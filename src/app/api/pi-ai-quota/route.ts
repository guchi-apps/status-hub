import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { getAiUsageSnapshot } from "@/lib/ai-usage"
import { toPiAiQuota } from "@/lib/pi-ai-quota"
import { tokenMatches } from "@/lib/session"

export const dynamic = "force-dynamic"

/**
 * ラズパイの room-panel（LCD表示）が、AI利用枠の残り割合を定期取得する読み取りAPI（#618）。
 *
 * このパスは src/proxy.ts の認証対象から除外している。認証は専用の固定トークン（`PI_PANEL_TOKEN`）だけで、
 * ログインセッションも `OPS_API_TOKEN` も通さない（Piに配ったトークンで他のAPIを読ませないため）。
 * 内容は `/api/ai-usage` と同じキャッシュから作るので、提供元への問い合わせは増えない。
 */
export async function GET(request: NextRequest) {
    const expected = process.env.PI_PANEL_TOKEN
    const authorization = request.headers.get("authorization")
    if (
        !expected ||
        !authorization?.startsWith("Bearer ") ||
        !tokenMatches(authorization.slice("Bearer ".length), expected)
    ) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }

    try {
        const snapshot = await getAiUsageSnapshot()
        return NextResponse.json(toPiAiQuota(snapshot), {
            headers: { "Cache-Control": "no-store" },
        })
    } catch (error) {
        console.error("Pi AI quota error:", error)
        return NextResponse.json({ error: "取得できませんでした" }, { status: 500 })
    }
}
