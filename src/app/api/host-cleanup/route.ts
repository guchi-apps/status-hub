import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { enqueueCleanupRequest } from "@/lib/host-stats/cleanup-requests"
import { isCleanupTargetId } from "@/lib/host-stats/cleanup-targets"
import { enqueueCloseRequest } from "@/lib/host-stats/close-requests"
import { ID_PATTERN } from "@/lib/host-stats/report"
import { readSnapshot } from "@/lib/host-stats/store"
import { isStaleTmuxSession } from "@/lib/host-stats/tmux"
import { rejectCrossSiteRequest } from "@/lib/csrf"
import { requireSessionForApi } from "@/lib/session"

export const dynamic = "force-dynamic"

/**
 * ホストのディスクの掃除を依頼する（#657）。
 *
 * 実行するのはホストのエージェント（掃除ユニット）で、依頼は次の受信の応答で渡る（最大1分ほど）。
 * **ファイルを消す操作のため、ログインセッションでだけ受け付ける**（`OPS_API_TOKEN` では通さない）。
 *
 * `{ hostId, target }` — target はエージェントが掃除できると申告している対象のIDだけ。
 * `tmux-stale` は、直近の受信で放置と判定されるセッションを tmux の閉じる依頼（#409）へ積む。
 */
export async function POST(request: NextRequest) {
    const { response } = await requireSessionForApi()
    if (response) return response

    const rejected = rejectCrossSiteRequest(request)
    if (rejected) return rejected

    let payload: unknown
    try {
        payload = await request.json()
    } catch {
        return NextResponse.json({ error: "JSONとして読めませんでした" }, { status: 400 })
    }

    const { hostId, target } = (payload ?? {}) as Record<string, unknown>
    if (typeof hostId !== "string" || !ID_PATTERN.test(hostId)) {
        return NextResponse.json({ error: "ホストの指定が正しくありません" }, { status: 400 })
    }
    if (!isCleanupTargetId(target)) {
        return NextResponse.json({ error: "掃除の対象の指定が正しくありません" }, { status: 400 })
    }

    const snapshot = await readSnapshot(hostId)
    if (!snapshot?.cleanup?.targets.some((entry) => entry.id === target)) {
        return NextResponse.json({ error: "このホストではその対象を掃除できません" }, { status: 400 })
    }

    if (target === "tmux-stale") {
        const sessions = snapshot.tmuxSessions ?? []
        const now = Date.now()
        const stale = sessions.filter((session) => session.user !== undefined && isStaleTmuxSession(session, now))
        if (stale.length === 0) {
            return NextResponse.json({ error: "放置セッションはありません" }, { status: 404 })
        }

        let queued = 0
        for (const session of stale) {
            const result = await enqueueCloseRequest(hostId, { user: session.user, name: session.name }, sessions, now)
            if (result === "queued" || result === "exists") queued += 1
        }
        return NextResponse.json({ ok: true, queued })
    }

    const result = await enqueueCleanupRequest(hostId, target, snapshot.cleanup)
    switch (result) {
        case "invalid":
        case "unsupported":
            return NextResponse.json({ error: "このホストではその対象を掃除できません" }, { status: 400 })
        default:
            return NextResponse.json({ ok: true, alreadyRequested: result === "exists" })
    }
}
