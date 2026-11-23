import { NextResponse } from "next/server"
import { setAideWorkerAssignmentMode } from "@/lib/aide-status"
import { isAssignmentMode } from "@/lib/aide-worker-assignment"
import { rejectCrossSiteRequest } from "@/lib/csrf"
import { requireAdminForApi } from "@/lib/session"

export const dynamic = "force-dynamic"

/**
 * AIDEの worker ジョブの担当ホストを切り替える（#668。AIDE側は guchi-apps/aide#891）。
 *
 * 担当を変えると、どのホストで Zaim の取り込みや天気の更新が走るかが変わるため、
 * **共通アクセス設定の管理者だけ**に許す（ログインしているだけでは通さない）。
 * Cookieで受ける書き込みなので、認証の直後にCSRFの確認を通す（#466）。
 * `OPS_API_TOKEN` などのサーバー間トークンでは通さない。
 *
 * 状態の正はAIDEにあり、ここはAIDEの `POST /api/worker/assignment` へ中継して結果を返すだけ。
 */
export async function POST(request: Request) {
    const { session, response } = await requireAdminForApi()
    if (response) return response

    const rejected = rejectCrossSiteRequest(request)
    if (rejected) return rejected

    let mode: unknown
    try {
        const body: unknown = await request.json()
        mode = typeof body === "object" && body !== null ? (body as Record<string, unknown>).mode : undefined
    } catch {
        return NextResponse.json({ error: "JSONとして読めませんでした" }, { status: 400 })
    }
    if (!isAssignmentMode(mode)) {
        return NextResponse.json({ error: "mode は auto・subpc・macmini のいずれかです" }, { status: 400 })
    }

    const result = await setAideWorkerAssignmentMode(mode)
    if (result.status !== "ok") {
        return NextResponse.json(
            { error: result.message },
            { status: result.status === "unconfigured" ? 503 : 502, headers: { "Cache-Control": "no-store" } }
        )
    }

    console.log(`[aide-worker-assignment] ${session.user.email} がモードを ${mode} にしました（担当 ${result.assignment.owner}）`)
    return NextResponse.json(
        { assignment: result.assignment },
        { headers: { "Cache-Control": "no-store" } }
    )
}
