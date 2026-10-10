/**
 * アプリが使うモデルの表示名・提供元・単価（#325）。
 *
 * 画面（クライアント）からも読むため、サーバー専用の処理を import しないこと。
 */

/** 100万トークンあたりの単価（USD） */
export interface ModelPrice {
    input: number
    output: number
    /** プロンプトキャッシュへの書き込み */
    cacheWrite: number
    /** プロンプトキャッシュからの読み出し */
    cacheRead: number
}

/** 画面で色分けに使うモデルの系統 */
export type ModelFamily = "opus" | "sonnet" | "haiku" | "jev" | "gpt"

export interface ModelInfo {
    /** 単価表のキー。連携先が日付付きのIDを返しても、ここへ寄せて数える */
    id: string
    label: string
    provider: string
    family: ModelFamily
    price: ModelPrice
    /** 単価表に添える注記（出典が未確認など）。単価と一緒に更新するため、この一覧に持たせる */
    note?: string
}

/**
 * モデルの一覧と単価。
 *
 * **Anthropicが単価を変えたら、または連携先が新しいモデルを使い始めたらここを直す。**
 * 表に無いモデルは、名前だけを出して金額は「不明」にする（近いモデルの単価で推測すると、
 * 実際より安く見えたり高く見えたりするため）。
 * Claude系の単価の出典は https://claude.com/pricing#api（2026-09-25時点。aide-bot の `MODEL_PRICING` と同じ値）。
 *
 * **使わなくなったモデルの行も消さない**（#418）。連携先は期間の途中でモデルを切り替えることがあり、
 * 行ごとに自分のモデルの単価で換算するため、消すとその期間の金額が「不明」に化ける。
 *
 * GPT-5.6系（aide-bot が Codex CLI 経由で使う）は、ChatGPTの定額枠で動くため実際の請求は発生しない。
 * ここの単価は公開API価格での換算値（画面に注記は出さない。#566）。出典は第三者サイトの2026-09-25時点の値（公式ページは
 * 取得できなかった。Solは2026-11-21までの期間限定価格の可能性）で、**キャッシュ読み出し（入力の1/10）と
 * 書き込み（入力と同額）は仮定**。公式の値が分かったら直す。
 *
 * **`gpt-6-*` の単価は出典が確認できていない**（#377で追加。Sonnet 5と同じ値）。aide-botがGPT-6へ
 * 切り替えても金額が出るよう残してあるが、公式の単価が出たら必ず確かめ直す。Terraなど未登録の
 * モデルは、名前だけを出して金額は「不明」になる。
 */
const MODELS: ModelInfo[] = [
    {
        id: "claude-fable-5-1",
        label: "Fable 5.1",
        provider: "Anthropic",
        // 画面の色分けに専用の系統が無いため、いちばん上位の opus に寄せる
        family: "opus",
        price: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
    },
    {
        id: "claude-opus-5-5",
        label: "Opus 5.5",
        provider: "Anthropic",
        family: "opus",
        price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    },
    {
        id: "claude-opus-5",
        label: "Opus 5",
        provider: "Anthropic",
        family: "opus",
        price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    },
    {
        id: "claude-sonnet-5",
        label: "Sonnet 5",
        provider: "Anthropic",
        family: "sonnet",
        price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    },
    {
        id: "claude-haiku-4-5",
        label: "Haiku 4.5",
        provider: "Anthropic",
        family: "haiku",
        price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
    },
    {
        // TypeSafe Jev。入力単価は typesafe.ts の TYPESAFE_INPUT_USD_PER_MILLION_TOKENS と同じ値
        // （テストで一致を確かめている）。出力トークンは現在無料のため 0
        id: "jev",
        label: "Jev",
        provider: "TypeSafe",
        family: "jev",
        price: { input: 0.042, output: 0, cacheWrite: 0, cacheRead: 0 },
    },
    {
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        provider: "OpenAI",
        family: "gpt",
        price: { input: 4, output: 20, cacheWrite: 4, cacheRead: 0.4 },
    },
    {
        id: "gpt-5.6-terra",
        label: "GPT-5.6 Terra",
        provider: "OpenAI",
        family: "gpt",
        price: { input: 2, output: 12, cacheWrite: 2, cacheRead: 0.2 },
    },
    {
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        provider: "OpenAI",
        family: "gpt",
        price: { input: 0.2, output: 1.2, cacheWrite: 0.2, cacheRead: 0.02 },
    },
    {
        id: "gpt-6-sol",
        label: "GPT-6 Sol",
        provider: "OpenAI",
        family: "gpt",
        note: "出典未確認",
        price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    },
    {
        id: "gpt-6-luna",
        label: "GPT-6 Luna",
        provider: "OpenAI",
        family: "gpt",
        note: "出典未確認",
        price: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    },
]

type ExtraModelsProvider = () => readonly ModelInfo[]

const globalForModels = globalThis as unknown as { __extraModelsProvider?: ExtraModelsProvider }

/**
 * 画面操作で追加・反映したモデル（#566）の取得元を登録する。**サーバー側だけが呼ぶ**（`price-watch/overrides.ts`）。
 * このファイルはクライアントからも読まれるため、ファイルの読み込みはここに持たず、同期の関数として差し込む。
 * 未登録（クライアント）のときは組み込みの一覧だけになる。
 */
export function setExtraModelsProvider(provider: ExtraModelsProvider | undefined): void {
    globalForModels.__extraModelsProvider = provider
}

/** 組み込みの一覧に、追加分を重ねる。同じIDは追加分（価格変更の反映）で置き換え、新しいIDは末尾へ足す */
function allModels(): readonly ModelInfo[] {
    const extra = globalForModels.__extraModelsProvider?.() ?? []
    if (extra.length === 0) return MODELS

    const byId = new Map(extra.map((info) => [info.id, info]))
    return [...MODELS.map((info) => byId.get(info.id) ?? info), ...extra.filter((info) => !MODELS.some((base) => base.id === info.id))]
}

/** 単価表の表示用に、一覧を登録順のまま返す（呼び出し側が並びを変えても元の一覧には響かないコピー） */
export function listModels(): readonly ModelInfo[] {
    return [...allModels()]
}

/**
 * モデルの識別子から一覧の1件を引く。
 *
 * 日付付きのID（`claude-haiku-4-5-20251001`）や Jev の派生名（`jev-1`）も同じモデルとして扱うため、
 * 完全一致のほかに「一覧のIDに `-` を足したものの先頭一致」を許す。**完全一致を全件先に確かめてから
 * 前方一致にフォールバックする。** 一段階の判定にすると、`claude-opus-5-5`（別モデル）が
 * `claude-opus-5` への前方一致で先に拾われてしまうように、短いIDのモデルが配列内で先にあるだけで
 * 後から登録した別モデルの単価を誤って被ってしまう（#362）。
 */
export function findModel(model: string): ModelInfo | null {
    const normalized = model.trim().toLowerCase()
    const models = allModels()
    return (
        models.find((info) => normalized === info.id) ??
        // 前方一致は最も長いIDを選ぶ。`claude-sonnet-5-5-20260101` が `claude-sonnet-5` に先に当たらないように
        models
            .filter((info) => normalized.startsWith(`${info.id}-`))
            .reduce<ModelInfo | null>((best, info) => (best === null || info.id.length > best.id.length ? info : best), null) ??
        null
    )
}

/**
 * 表示名を揃える（#570）。公式の表示名やIDのまま入った行を、一覧の他の行と同じ表記にする。
 * Anthropicは先頭の「Claude 」を外し、OpenAIの `gpt-6.1-sol` は `GPT-6.1 Sol` にする。モデルIDは変えない。
 */
export function normalizeModelLabel(provider: string, name: string): string {
    const trimmed = name.trim()
    if (provider === "Anthropic") return trimmed.replace(/^claude[\s-]+/i, "")
    if (provider === "OpenAI") {
        const match = /^gpt[\s-]*(\d+(?:\.\d+)*)(?:[\s-]+(.+))?$/i.exec(trimmed)
        if (match) {
            const suffix = (match[2] ?? "")
                .split(/[\s-]+/)
                .filter(Boolean)
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join(" ")
            return suffix ? `GPT-${match[1]} ${suffix}` : `GPT-${match[1]}`
        }
    }
    return trimmed
}

/** 提供元の並び。一覧に無い提供元はこの後ろへ、出てきた順で並ぶ */
const PROVIDER_ORDER = ["Anthropic", "OpenAI", "TypeSafe"]

/** 格付け（上位ほど小さい）。名前から引く。無いものは各提供元の末尾 */
const TIER_ORDER = ["fable", "astra", "opus", "sol", "sonnet", "terra", "haiku", "luna", "jev"]

function tierRank(label: string): number {
    const index = TIER_ORDER.findIndex((tier) => label.toLowerCase().includes(tier))
    return index === -1 ? TIER_ORDER.length : index
}

/** 表示名に含まれる版（`5.5`・`6.1`）。無ければ0 */
function versionOf(label: string): number[] {
    return (/\d+(?:\.\d+)*/.exec(label)?.[0] ?? "0").split(".").map(Number)
}

function compareVersionsDesc(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (b[i] ?? 0) - (a[i] ?? 0)
        if (diff !== 0) return diff
    }
    return 0
}

/**
 * 単価表の表示順（#570）。提供元ごとにまとめ、各提供元の中は格付けの高い順、同じ格付けなら新しい版が上。
 * 格付けが不明なモデルは提供元の末尾へ、出力単価の高い順で並べる。**概算金額の計算には影響しない**（表示専用）。
 */
export function sortModelsForDisplay<T extends ModelInfo>(models: readonly T[]): T[] {
    const providerRank = (provider: string) => {
        const index = PROVIDER_ORDER.indexOf(provider)
        return index === -1 ? PROVIDER_ORDER.length : index
    }
    return [...models].sort(
        (a, b) =>
            providerRank(a.provider) - providerRank(b.provider) ||
            tierRank(a.label) - tierRank(b.label) ||
            compareVersionsDesc(versionOf(a.label), versionOf(b.label)) ||
            b.price.output - a.price.output
    )
}

/** 集計のキーに使うモデルID。一覧にあれば一覧のID、無ければ連携先が返した値のまま */
export function canonicalModelId(model: string): string {
    return findModel(model)?.id ?? model
}

/** 画面に出すモデル名。一覧に無ければIDのまま */
export function modelLabel(model: string): string {
    return findModel(model)?.label ?? model
}

export interface TokenCounts {
    inputTokens: number
    /** 数えていなければ null */
    outputTokens: number | null
    cacheReadTokens: number
    cacheWriteTokens: number
}

/**
 * 単価表からの概算金額（USD）。計算できなければ null。
 *
 * - 単価が無いモデルは null（推測しない）
 * - 出力トークンが不明で、そのモデルの出力が有料なら null（入力だけの金額を全体の金額として
 *   出すと、実際より安く見えるため）
 */
export function estimateCostUsd(model: string, tokens: TokenCounts): number | null {
    const info = findModel(model)
    if (!info) return null

    const { price } = info
    if (tokens.outputTokens === null && price.output > 0) return null

    return (
        (tokens.inputTokens * price.input +
            (tokens.outputTokens ?? 0) * price.output +
            tokens.cacheReadTokens * price.cacheRead +
            tokens.cacheWriteTokens * price.cacheWrite) /
        1_000_000
    )
}
