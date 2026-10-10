import { NextResponse } from "next/server"
import { getAideWorkReportsSnapshot } from "@/lib/aide-work-reports"
import { requireSessionForApi } from "@/lib/session"

export const dynamic = "force-dynamic"

/**
 * dotの作業報告（#575）。作業名・待機理由・結果要約を載せるため、ログインの内側に閉じる
 * （`OPS_API_TOKEN` の経路は付けず、src/proxy.ts の PUBLIC_PATH_PREFIXES にも載せない）。
 */
export async function GET() {
    const { response } = await requireSessionForApi()
    if (response) return response

    return NextResponse.json(await getAideWorkReportsSnapshot(), {
        headers: { "Cache-Control": "no-store" },
    })
}
