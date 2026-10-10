import fs from "fs"
import path from "path"
import { listModels, normalizeModelLabel, setExtraModelsProvider, type ModelFamily, type ModelInfo, type ModelPrice } from "@/lib/ai-app-usage/models"
import type { PriceCandidate } from "@/lib/ai-app-usage/price-watch/types"
import { writeFileAtomic } from "@/lib/host-stats/store"

/**
 * 単価表への画面操作（#566）。更新候補の反映・非表示と、登録済みモデルの非表示を `.data/` に持つ。
 *
 * - **`models.ts` のコードは書き換えない。** 反映したモデルは `added` に持ち、`models.ts` の一覧へ重ねる
 *   （同じIDは置き換え。価格変更の反映）。概算金額の計算（`estimateCostUsd`）も同じ一覧を引く
 * - **非表示は表示だけ。** 一覧・金額の計算には残す（消すと過去期間の金額が「不明」になる。#418）
 * - サーバー専用。`models.ts` へは同期の取得関数として差し込む（mtimeを見て読み直すため、起動順や
 *   別のモジュールグラフに依存しない）
 */

export interface PriceOverrides {
    /** 候補から反映したモデル。組み込みの一覧へ重ねる */
    added: ModelInfo[]
    /** 単価表で非表示にしたモデルのID */
    hiddenModels: string[]
    /** 候補一覧で隠した候補のキー（`PriceCandidate.key`。価格が変わると別のキーになり、再び出る） */
    hiddenCandidates: string[]
}

const EMPTY: PriceOverrides = { added: [], hiddenModels: [], hiddenCandidates: [] }

const FAMILIES: readonly ModelFamily[] = ["opus", "sonnet", "haiku", "jev", "gpt"]
const PRICE_KEYS: (keyof ModelPrice)[] = ["input", "output", "cacheWrite", "cacheRead"]

function getOverridesPath(): string {
    return process.env.MODEL_PRICE_OVERRIDES_PATH || path.join(process.cwd(), ".data", "model-price-overrides.json")
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string")

/** 壊れた行は捨てる（1行の不正で全体を落とさない）。価格が数値でない行は金額を誤らせるため入れない */
function parseAdded(value: unknown): ModelInfo[] {
    if (!Array.isArray(value)) return []
    return value.flatMap((raw): ModelInfo[] => {
        const entry = raw as Partial<ModelInfo> | null
        if (!entry || typeof entry.id !== "string" || typeof entry.label !== "string" || typeof entry.provider !== "string") return []
        if (!FAMILIES.includes(entry.family as ModelFamily)) return []
        const price = entry.price as Partial<ModelPrice> | undefined
        if (!price || !PRICE_KEYS.every((key) => typeof price[key] === "number" && Number.isFinite(price[key]))) return []
        return [
            {
                id: entry.id,
                label: normalizeModelLabel(entry.provider, entry.label),
                provider: entry.provider,
                family: entry.family as ModelFamily,
                price: { input: price.input!, output: price.output!, cacheWrite: price.cacheWrite!, cacheRead: price.cacheRead! },
                ...(typeof entry.note === "string" ? { note: entry.note } : {}),
            },
        ]
    })
}

let cache: { mtimeMs: number; value: PriceOverrides } | null = null

/** 同期で読む。ファイルの更新時刻が変わったときだけ読み直す。無い・壊れているときは空 */
export function readOverridesSync(): PriceOverrides {
    const file = getOverridesPath()
    let mtimeMs: number
    try {
        mtimeMs = fs.statSync(file).mtimeMs
    } catch {
        cache = null
        return EMPTY
    }
    if (cache && cache.mtimeMs === mtimeMs) return cache.value

    let value = EMPTY
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PriceOverrides> | null
        if (parsed && typeof parsed === "object") {
            value = {
                added: parseAdded(parsed.added),
                hiddenModels: isStringArray(parsed.hiddenModels) ? parsed.hiddenModels : [],
                hiddenCandidates: isStringArray(parsed.hiddenCandidates) ? parsed.hiddenCandidates : [],
            }
        }
    } catch {
        // 壊れたファイルは「操作なし」として扱う
    }
    cache = { mtimeMs, value }
    return value
}

// `models.ts` の `findModel` などが、この読み込みを通して追加分を見る。読み込んだ時点で差し込む
setExtraModelsProvider(() => readOverridesSync().added)

let queue: Promise<unknown> = Promise.resolve()

/** 読み→変更→書きを1件ずつ通す（並行すると後から書いた側が先の操作を消す） */
export function updateOverrides(change: (current: PriceOverrides) => PriceOverrides): Promise<PriceOverrides> {
    const run = queue.then(async () => {
        const next = change(readOverridesSync())
        await writeFileAtomic(getOverridesPath(), `${JSON.stringify(next, null, 2)}\n`)
        cache = null
        return next
    })
    queue = run.catch(() => undefined)
    return run
}

const unique = (items: readonly string[]) => [...new Set(items)]

/** 公式の表示名から、画面の色分けに使う系統を決める。分からなければ提供元の既定 */
export function guessFamily(provider: string, name: string): ModelFamily {
    if (provider === "OpenAI") return "gpt"
    if (/opus|fable/i.test(name)) return "opus"
    if (/haiku/i.test(name)) return "haiku"
    return "sonnet"
}

export class OverrideError extends Error {}

/** 候補を単価表へ反映する行にする。公式が `-`（その課金なし）とした項目は0で登録する */
export function candidateToModel(candidate: PriceCandidate, registered: readonly ModelInfo[]): ModelInfo {
    if (candidate.kind === "delisted") throw new OverrideError("掲載終了の候補は反映できません")
    if (!candidate.id) throw new OverrideError("モデルIDが未確定のため反映できません")
    if (!candidate.after) throw new OverrideError("通常価格が無い候補は反映できません")

    const existing = registered.find((info) => info.id === candidate.id)
    const after = candidate.after
    return {
        id: candidate.id,
        label: existing?.label ?? normalizeModelLabel(candidate.provider, candidate.name),
        provider: candidate.provider,
        family: existing?.family ?? guessFamily(candidate.provider, candidate.name),
        // 公式で確かめた単価なので、「出典未確認」の注記は付けない
        price: { input: after.input ?? 0, output: after.output ?? 0, cacheWrite: after.cacheWrite ?? 0, cacheRead: after.cacheRead ?? 0 },
    }
}

export function applyAddCandidate(current: PriceOverrides, candidate: PriceCandidate): PriceOverrides {
    const model = candidateToModel(candidate, listModels())
    return {
        ...current,
        added: [...current.added.filter((info) => info.id !== model.id), model],
        // 反映した候補は候補一覧から外す（次の確認で差分が無くなるまでの間も出さない）
        hiddenCandidates: unique([...current.hiddenCandidates, candidate.key]),
    }
}

export const applyHideCandidate = (current: PriceOverrides, key: string): PriceOverrides => ({
    ...current,
    hiddenCandidates: unique([...current.hiddenCandidates, key]),
})

export const applyHideModel = (current: PriceOverrides, id: string, hidden: boolean): PriceOverrides => ({
    ...current,
    hiddenModels: hidden ? unique([...current.hiddenModels, id]) : current.hiddenModels.filter((entry) => entry !== id),
})
