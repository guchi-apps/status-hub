import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { enqueueCleanupRequest } from "@/lib/host-stats/cleanup-requests"
import { isCleanupTargetId } from "@/lib/host-stats/cleanup-targets"
import { enqueueCloseStaleRequest } from "@/lib/host-stats/close-requests"
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
 * `tmux-stale` は「放置セッションを全部閉じて」という依頼を1件積む。受信済みの一覧は先頭20件で切られるため、
 * セッションを指さず、何が放置かはエージェントが自分で見て決める（一覧の外にある放置セッションも閉じられる）。
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
        // 一覧に載らなかった分（総数との差）に放置があるかは分からないため、その分があるときは依頼を通す
        const hidden = Math.max(0, (snapshot.tmuxSessionTotal ?? sessions.length) - sessions.length)
        const hasStale = sessions.some((session) => isStaleTmuxSession(session, now))
        if (!hasStale && hidden === 0) {
            return NextResponse.json({ error: "放置セッションはありません" }, { status: 404 })
        }

        const result = await enqueueCloseStaleRequest(hostId, now)
        return NextResponse.json({ ok: true, alreadyRequested: result === "exists" })
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
