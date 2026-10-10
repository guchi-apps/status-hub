import { NextResponse } from "next/server"
import { rejectCrossSiteRequest } from "@/lib/csrf"
import { requireSessionForApi } from "@/lib/session"
import { applyPriceAction, OverrideError, parsePriceAction } from "@/lib/ai-app-usage/price-watch/actions"

export const dynamic = "force-dynamic"

/**
 * モデル単価表の画面操作（#566）: 候補の反映・非表示、登録済みモデルの非表示と再表示。
 * ログインセッションでだけ受け、セッションを使う書き込みなのでCSRFも確かめる。
 */
export async function POST(request: Request) {
    const { response } = await requireSessionForApi()
    if (response) return response
    const rejected = rejectCrossSiteRequest(request)
    if (rejected) return rejected

    const action = parsePriceAction(await request.json().catch(() => null))
    if (!action) return NextResponse.json({ error: "Invalid request" }, { status: 400 })

    try {
        return NextResponse.json(await applyPriceAction(action), { headers: { "Cache-Control": "no-store" } })
    } catch (error) {
        if (error instanceof OverrideError) return NextResponse.json({ error: error.message }, { status: 409 })
        console.error("Model price action error:", error)
        return NextResponse.json({ error: "Failed to update model prices" }, { status: 500 })
    }
}
