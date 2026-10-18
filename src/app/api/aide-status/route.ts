import { NextResponse } from "next/server"
import { getAideStatusSnapshot } from "@/lib/aide-status"
import { requireSessionForApi } from "@/lib/session"

export const dynamic = "force-dynamic"

/**
 * AIDEの動作状況（#237）。
 *
 * 画面からしか使わないため、他の読み取りAPIと違って `OPS_API_TOKEN` の経路は付けない。
 * AIDEのジョブの失敗理由やMCPの利用記録を載せるので、ログインの内側に閉じておく
 * （src/lib/public-paths.ts の PUBLIC_PATH_PREFIXES にも載せていない）。
 */
export async function GET() {
    const { response } = await requireSessionForApi()
    if (response) return response

    const snapshot = await getAideStatusSnapshot()
    return NextResponse.json(snapshot, {
        headers: { "Cache-Control": "no-store" },
    })
}
