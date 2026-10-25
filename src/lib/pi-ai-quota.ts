import type { AiProviderId, AiUsageSnapshot, AiUsageWindow } from "@/types/ai-usage"

/** ラズパイの room-panel に返す1枠。金額・クレジット・履歴・プラン名は含めない（#618） */
export interface PiQuota {
    id: string
    label: string
    remaining_percent: number | null
    resets_at: string | null
}

/**
 * 固定取得済みの room-panel（pi0w の ai_quota_client.py）が読む `/api/ai-usage` 互換の形（#621）。
 * `providers[].windows[].usedPercent` だけを読むため、必要最小限の項目に絞る。
 */
export interface PiCompatWindow {
    label: string
    windowSeconds: number
    usedPercent: number
    resetsAt: string | null
}

export interface PiCompatProvider {
    id: AiProviderId
    status: "ok" | "unavailable"
    windows: PiCompatWindow[]
}

export interface PiAiQuotaResponse {
    quotas: PiQuota[]
    /** 旧クライアント向けの互換フィールド。新しいクライアントは `quotas` を読む */
    providers: PiCompatProvider[]
    fetched_at: string
    stale: boolean
}

interface QuotaSlot {
    id: string
    label: string
    provider: AiProviderId
    windowSeconds: number
}

/**
 * 返す枠。拾うのは `windowSeconds` と `note` で決める（`label` は「週間」がClaudeの全体・Opus・Sonnetで
 * 同じになり、取り違える）。Claudeは全体の枠（`note` なし）だけ、ChatGPTは週間枠だけを対象にする。
 */
const SLOTS: QuotaSlot[] = [
    { id: "claude_5h", label: "Claude 5h", provider: "claude", windowSeconds: 18_000 },
    { id: "claude_7d", label: "Claude 7d", provider: "claude", windowSeconds: 604_800 },
    { id: "codex_7d", label: "Codex 7d", provider: "chatgpt", windowSeconds: 604_800 },
]

/** 提供元ごとに最後に取得できた枠。取得に失敗した回に、直前の値で埋めるために持つ */
export type HeldWindows = Map<AiProviderId, AiUsageWindow[]>

const held: HeldWindows = new Map()

function findWindow(windows: AiUsageWindow[], slot: QuotaSlot): AiUsageWindow | undefined {
    return windows.find((window) => window.windowSeconds === slot.windowSeconds && !window.note)
}

/**
 * `/api/ai-usage` と同じスナップショットから、Pi向けの残り割合を組み立てる。
 *
 * 提供元の取得に失敗した（`status` が ok 以外）回は、その提供元の最後の成功値で埋めて `stale` を立てる。
 * 一度も取れていない枠は外さず `remaining_percent: null` にする（0%や余裕ありと誤解させない）。
 * `fetched_at` はスナップショットの値（提供元の取得時刻のうち最古）をそのまま返す。
 */
export function toPiAiQuota(snapshot: AiUsageSnapshot, store: HeldWindows = held): PiAiQuotaResponse {
    for (const provider of snapshot.providers) {
        if (provider.status === "ok") store.set(provider.id, provider.windows)
    }

    let stale = false
    const quotas = SLOTS.map((slot): PiQuota => {
        const provider = snapshot.providers.find((entry) => entry.id === slot.provider)
        const usedFresh = provider?.status === "ok"
        const windows = usedFresh ? provider.windows : store.get(slot.provider)
        const window = windows ? findWindow(windows, slot) : undefined

        if (!window) return { id: slot.id, label: slot.label, remaining_percent: null, resets_at: null }
        if (!usedFresh) stale = true

        const remaining = Math.min(100, Math.max(0, Math.round(100 - window.usedPercent)))
        return { id: slot.id, label: slot.label, remaining_percent: remaining, resets_at: window.resetsAt }
    })

    return { quotas, providers: toCompatProviders(quotas), fetched_at: snapshot.fetchedAt, stale }
}

/**
 * `quotas` から旧 room-panel が読む `providers` を組み立てる。値のある枠だけを載せ、
 * 取れなかった枠（null）は載せない（旧クライアントは枠が無ければ「不明」として扱う）。
 * 枠の判別は旧クライアントが `windowSeconds` で行う。
 */
function toCompatProviders(quotas: PiQuota[]): PiCompatProvider[] {
    const providers = new Map<AiProviderId, PiCompatProvider>()
    for (const slot of SLOTS) {
        const provider = providers.get(slot.provider) ?? { id: slot.provider, status: "unavailable" as const, windows: [] }
        providers.set(slot.provider, provider)
        const quota = quotas.find((entry) => entry.id === slot.id)
        if (!quota || quota.remaining_percent === null) continue
        provider.status = "ok"
        provider.windows.push({
            label: slot.windowSeconds === 18_000 ? "5時間" : "週間",
            windowSeconds: slot.windowSeconds,
            usedPercent: 100 - quota.remaining_percent,
            resetsAt: quota.resets_at,
        })
    }
    return [...providers.values()]
}
