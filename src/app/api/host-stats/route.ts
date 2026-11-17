import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireSessionOrApiToken, tokenMatches } from "@/lib/session"
import { getAiUsageSnapshot } from "@/lib/ai-usage"
import { HostStatsReportError, parseHostStatsReport } from "@/lib/host-stats/report"
import { getHostStatsView, saveHostStatsReport } from "@/lib/host-stats/store"
import { processTimerAlerts } from "@/lib/host-stats/timer-alerts"
import { settleCloseRequests } from "@/lib/host-stats/close-requests"
import { settleCleanupRequests } from "@/lib/host-stats/cleanup-requests"

export const dynamic = "force-dynamic"

/** 想定されるペイロードは1KB前後。壊れた送信元にファイルを膨らませられないよう上限を設ける */
const MAX_BODY_BYTES = 32_768

/**
 * サブPCのメトリクスの受け口と取り出し口。
 *
 * VPS Status（自ホストの /proc を直読み）と違い、サブPCは自宅LAN内にいてVPSから
 * ポーリングできないため、サブPC側のエージェントから定期POSTしてもらう push 型にしている。
 *
 * - POST: エージェントからの受信。ログイン画面を通れないため `HOST_STATS_TOKEN` で認証する
 *   （このパスは src/proxy.ts の認証対象から除外している）
 * - GET: ダッシュボードからの取得。ログインセッション、またはサーバー間用の `OPS_API_TOKEN`
 *   で認証する（後者はAIDEのMCPサーバー向け。詳細は src/lib/session.ts）
 */
export async function POST(request: NextRequest) {
    const token = process.env.HOST_STATS_TOKEN
    const authorization = request.headers.get("authorization")
    if (
        !token ||
        !authorization?.startsWith("Bearer ") ||
        !tokenMatches(authorization.slice("Bearer ".length), token)
    ) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }

    const body = await request.text()
    if (body.length > MAX_BODY_BYTES) {
        return NextResponse.json({ error: "payload too large" }, { status: 413 })
    }

    let payload: unknown
    try {
        payload = JSON.parse(body)
    } catch {
        return NextResponse.json({ error: "JSONとして読めません" }, { status: 400 })
    }

    try {
        const report = parseHostStatsReport(payload)
        const snapshot = await saveHostStatsReport(report)

        // 定期ジョブの異常通知。判定は受信のたびに行うが、鳴るのは状態が変わったときだけ。
        // 通知が落ちても受信は成功しているため、エージェントへは 200 を返す
        try {
            await processTimerAlerts({
                hostId: report.id,
                hostLabel: report.label || report.hostname,
                timers: report.timers,
            })
        } catch (error) {
            console.error("Timer alert error:", error)
        }

        // AI利用枠の「使い切り」は取得できた時点の値しか記録できず、ダッシュボードを開いていない
        // 時間帯は観測が飛ぶ（#244）。エージェントからの受信はホストが動いている限り続くため、
        // これを契機に取得も回して記録をつなぐ。
        //
        // **提供元への問い合わせは常時5分間隔になる**（これまでは画面を開いている間だけ）。
        // エージェントは1分ごとに届くが、プロセス内キャッシュ（`AI_USAGE_CACHE_SECONDS`・既定300秒）
        // を挟むため実際に取りにいくのは5分に1回で、Anthropicが推奨する180秒以上の間隔は保たれる。
        // 受信の成否とは切り離したいので待たない（上流の遅延でエージェントのPOSTを詰まらせない）

        void getAiUsageSnapshot().catch((error) => {
            console.error("AI usage sample error:", error)
        })

        // tmux セッションを閉じる依頼（#409）。ホストへ指示を送る経路が無いため、応答に載せて渡す。
        // 古いエージェントは知らない項目を読み飛ばすので、載せても害は無い。
        // 依頼の処理が落ちても受信は成功しているため、依頼が無い扱いで200を返す
        let closeSessions: string[] = []
        try {
            closeSessions = await settleCloseRequests(report.id, report.tmuxSessions)
        } catch (error) {
            console.error("Close request error:", error)
        }

        // ディスクの掃除の依頼（#657）。tmux と同じく応答に載せ、`<対象>:<依頼時刻>` だけを渡す
        let cleanupRequests: string[] = []
        try {
            cleanupRequests = await settleCleanupRequests(report.id, report.cleanup)
        } catch (error) {
            console.error("Cleanup request error:", error)
        }

        return NextResponse.json({
            ok: true,
            receivedAt: snapshot.receivedAt,
            ...(closeSessions.length > 0 && { closeSessions }),
            ...(cleanupRequests.length > 0 && { cleanupRequests }),
        })
    } catch (error) {
        if (error instanceof HostStatsReportError) {
            return NextResponse.json({ error: error.message }, { status: 400 })
        }
        console.error("Host stats save error:", error)
        return NextResponse.json({ error: "Failed to save host stats" }, { status: 500 })
    }
}

export async function GET(request: NextRequest) {
    const { response } = await requireSessionOrApiToken(request)
    if (response) return response

    try {
        const view = await getHostStatsView()
        return NextResponse.json(view, {
            headers: { "Cache-Control": "no-store" },
        })
    } catch (error) {
        console.error("Host stats read error:", error)
        return NextResponse.json({ error: "Failed to read host stats" }, { status: 500 })
    }
}
