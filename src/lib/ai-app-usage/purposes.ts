import type { AiAppUsageApp } from "@/types/ai-app-usage"

/**
 * AIを使っている用途の登録簿（#415）。「アプリ別のAI利用」は使用量APIを持つアプリしか出さないため、
 * AIを使っているのに載っていない用途を見つける手がかりとして、ここに全部の用途を手で持つ。
 * 他リポジトリのソースは実行時に読めないので、自動検出はしない。
 * **AIを呼ぶ機能を足したら（どのアプリでも）ここへ足す。**
 *
 * - `app`: 使用量の連携先と同じアプリ名。`metered` の用途は、スナップショットの `apps` に同名のアプリがあり取得できていれば「計測中」
 * - `metered`: アプリが自分でAI APIを呼び、使用量APIで数えられる用途
 * - `quota`: サブスクの利用枠を消費する用途。アプリ別には数えられず、提供元別の利用枠カードで見る
 */
export interface AiPurpose {
    app: string
    label: string
    provider: string
    kind: "metered" | "quota"
    /** 提供元別の利用枠カードのどこで見るか（quota のとき） */
    quotaOf?: "claude" | "chatgpt"
}

export const AI_PURPOSES: AiPurpose[] = [
    { app: "issue-deck", label: "Issueの要約・検索・提案ほか", provider: "Claude API / OpenAI / Jev", kind: "metered" },
    { app: "aide-bot", label: "チャット・ブリーフィング", provider: "Claude API", kind: "metered" },
    { app: "asset-manager", label: "レシート解析・リバランス助言", provider: "Claude API", kind: "metered" },
    { app: "dayspan", label: "旅行の所要時間見積もり", provider: "Claude Haiku 4.5", kind: "metered" },
    { app: "research-desk", label: "分析・週次ブリーフ（Codex CLI）", provider: "Codex CLI", kind: "metered" },
    { app: "portfolio", label: "プロジェクト要約", provider: "Claude Haiku 4.5", kind: "metered" },
    { app: "Claude Code", label: "実装・計画・レビュー・CI修正（サブPC・GitHub Actions）", provider: "Claude 利用枠", kind: "quota", quotaOf: "claude" },
    { app: "5時間枠の先開け", label: "issue-deckが最小の推論を送って枠を開ける", provider: "Claude 利用枠", kind: "quota", quotaOf: "claude" },
    { app: "Codex", label: "issue-deck経由の実装", provider: "ChatGPT 利用枠", kind: "quota", quotaOf: "chatgpt" },
]

/**
 * measured — スナップショットの `apps` に載り、取得できている（issue-deckのTypeSafe補完も含む）
 * failed   — スナップショットに載っているが取得できていない
 * unlinked — スナップショットに載っていない（AIは使っているのに数えられていない）
 * quota    — 利用枠を消費する。アプリ別には数えられない
 */
export type AiPurposeState = "measured" | "failed" | "unlinked" | "quota"

export interface AiPurposeRow extends AiPurpose {
    state: AiPurposeState
}

export function resolvePurposes(apps: AiAppUsageApp[], purposes: AiPurpose[] = AI_PURPOSES): AiPurposeRow[] {
    return purposes.map((purpose) => {
        if (purpose.kind === "quota") return { ...purpose, state: "quota" }
        const found = apps.find((app) => app.app === purpose.app)
        if (!found) return { ...purpose, state: "unlinked" }
        return { ...purpose, state: found.status === "ok" ? "measured" : "failed" }
    })
}

export function countStates(rows: AiPurposeRow[]): Record<AiPurposeState, number> {
    const counts: Record<AiPurposeState, number> = { measured: 0, failed: 0, unlinked: 0, quota: 0 }
    for (const row of rows) counts[row.state] += 1
    return counts
}
