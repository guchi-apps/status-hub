import { invalidateAiAppUsageCache } from "@/lib/ai-app-usage"
import {
    applyAddCandidate,
    applyHideCandidate,
    applyHideModel,
    OverrideError,
    updateOverrides,
} from "@/lib/ai-app-usage/price-watch/overrides"
import { getPriceWatchView, readWatchState, type PriceWatchView } from "@/lib/ai-app-usage/price-watch/run"
import { listModels } from "@/lib/ai-app-usage/models"

/**
 * 単価表の画面操作（#566）。候補の価格は画面から受け取らず、保存済みの結果からキーで引く
 * （クライアントの値をそのまま単価表へ入れない）。
 */
export type PriceAction =
    | { action: "add-candidate"; key: string }
    | { action: "hide-candidate"; key: string }
    | { action: "hide-model"; id: string }
    | { action: "show-model"; id: string }

export { OverrideError }

export function parsePriceAction(body: unknown): PriceAction | null {
    if (!body || typeof body !== "object") return null
    const { action, key, id } = body as Record<string, unknown>
    if ((action === "add-candidate" || action === "hide-candidate") && typeof key === "string" && key) return { action, key }
    if ((action === "hide-model" || action === "show-model") && typeof id === "string" && id) return { action, id }
    return null
}

export async function applyPriceAction(action: PriceAction): Promise<PriceWatchView> {
    switch (action.action) {
        case "add-candidate": {
            const candidate = (await readWatchState()).candidates.find((entry) => entry.key === action.key)
            if (!candidate) throw new OverrideError("候補が見つかりません。更新して確認し直してください")
            await updateOverrides((current) => applyAddCandidate(current, candidate))
            // 概算金額は5分キャッシュされているため、反映した単価で計算し直させる
            invalidateAiAppUsageCache()
            break
        }
        case "hide-candidate":
            await updateOverrides((current) => applyHideCandidate(current, action.key))
            break
        case "hide-model":
        case "show-model":
            if (!listModels().some((info) => info.id === action.id)) throw new OverrideError("モデルが見つかりません")
            await updateOverrides((current) => applyHideModel(current, action.id, action.action === "hide-model"))
            break
    }
    return getPriceWatchView()
}
