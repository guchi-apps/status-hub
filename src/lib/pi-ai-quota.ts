import type { AiProviderId, AiUsageSnapshot, AiUsageWindow } from "@/types/ai-usage"

/** ラズパイの room-panel に返す1枠。金額・クレジット・履歴・プラン名は含めない（#618） */
export interface PiQuota {
    id: string
    label: string
    remaining_percent: number | null
    resets_at: string | null
}

export interface PiAiQuotaResponse {
    quotas: PiQuota[]
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

    return { quotas, fetched_at: snapshot.fetchedAt, stale }
}
