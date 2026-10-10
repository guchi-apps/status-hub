import { estimateCostUsd } from "@/lib/ai-app-usage/models"
// 画面操作で反映したモデルも金額の計算に使うため、取得元を差し込む（サーバー専用。副作用import）
import "@/lib/ai-app-usage/price-watch/overrides"
import { parseAiAppUsageResponse } from "@/lib/ai-app-usage/parse"
import type { AiAppUsageSource } from "@/lib/ai-app-usage/sources"
import { fetchWithTimeout } from "@/lib/upstream"
import type { AiAppFeatureUsage, AiAppUsageApp, AiAppUsageTotals } from "@/types/ai-app-usage"
import type { AiMeteredTotals, AiProviderUsage } from "@/types/ai-usage"

/**
 * 使用量APIを持たないissue-deckの分を、既存のTypeSafe連携（`TYPESAFE_USAGE_URL`）から補うときのアプリ名。
 * TypeSafe（Jev）を呼んでいるのはissue-deckで、その集計を読んでいる。
 */
export const TYPESAFE_APP_NAME = "issue-deck"

/** TypeSafe（Jev）のモデルID。単価表（models.ts）のIDと同じ */
const TYPESAFE_MODEL = "jev"

async function fetchSource(source: AiAppUsageSource, token: string): Promise<AiAppUsageApp> {
    try {
        const response = await fetchWithTimeout(source.url, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            // 許可ホストから別のホストへ転送されても、トークン付きで追わない（#465）
            redirect: "error",
        })
        if (!response.ok) {
            return { app: source.app, status: "error", message: `HTTP ${response.status}`, features: [] }
        }

        const features = parseAiAppUsageResponse(await response.json())
        if (!features) {
            return { app: source.app, status: "error", message: "応答の形式が想定と異なります", features: [] }
        }

        return { app: source.app, status: "ok", features }
    } catch {
        // 例外の内容にはURLが含まれうるため、画面へは出さない
        return { app: source.app, status: "error", message: "接続できません", features: [] }
    }
}

function fromMeteredTotals(totals: AiMeteredTotals): AiAppUsageTotals {
    return {
        calls: totals.calls,
        inputTokens: totals.inputTokens,
        // TypeSafeは出力トークンを数えない（現在は無料）
        outputTokens: null,
        // Jevにキャッシュは無い（金額の換算に渡す値と同じ0）。省略（不明）にすると注記が常に付いてしまう
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: estimateCostUsd(TYPESAFE_MODEL, {
            inputTokens: totals.inputTokens,
            outputTokens: null,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        }),
    }
}

/**
 * 既存のTypeSafe連携の結果を、issue-deckのアプリ別の行へ直す。
 * 未設定なら null（一覧に出さない）。追加の問い合わせはせず、TypeSafeカードと同じ取得結果を使う。
 */
export function typeSafeAppFromUsage(usage: AiProviderUsage): AiAppUsageApp | null {
    if (usage.status === "unconfigured") return null
    if (usage.status === "error" || !usage.metered) {
        return {
            app: TYPESAFE_APP_NAME,
            status: "error",
            message: usage.message ?? "取得できませんでした",
            features: [],
        }
    }

    const features: AiAppFeatureUsage[] = usage.metered.features.map((feature) => ({
        label: feature.label,
        model: TYPESAFE_MODEL,
        last24h: fromMeteredTotals(feature.last24h),
        last7d: fromMeteredTotals(feature.last7d),
    }))

    return { app: TYPESAFE_APP_NAME, status: "ok", features }
}

interface CollectInput {
    sources: AiAppUsageSource[]
    /** 連携先へ送るBearerトークン。無ければ連携先は読みにいかない */
    token: string | undefined
    /** 既存のTypeSafe連携の結果。`AI_APP_USAGE_SOURCES` に issue-deck が無いときだけ使う */
    typesafe: AiProviderUsage | null
}

/** 連携先を並行に読み、アプリごとの結果を返す。キャッシュは呼び出し側（index.ts）が持つ */
export async function collectAiAppUsage({ sources, token, typesafe }: CollectInput): Promise<AiAppUsageApp[]> {
    const apps = token ? await Promise.all(sources.map((source) => fetchSource(source, token))) : []

    // issue-deck自身が使用量APIを持つようになったら、そちらを正とする（Jevの分が二重に数えられる）
    if (typesafe && !sources.some((source) => source.app === TYPESAFE_APP_NAME)) {
        const fallback = typeSafeAppFromUsage(typesafe)
        if (fallback) apps.push(fallback)
    }

    return apps
}
