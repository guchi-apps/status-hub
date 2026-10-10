import fs from "fs/promises"
import path from "path"
import { listModels, type ModelInfo } from "@/lib/ai-app-usage/models"
import { diffProvider } from "@/lib/ai-app-usage/price-watch/diff"
import { readOverridesSync } from "@/lib/ai-app-usage/price-watch/overrides"
import {
    describeSchedule,
    latestSlot,
    nextSlot,
    readSchedule,
    type WatchSchedule,
} from "@/lib/ai-app-usage/price-watch/schedule"
import {
    ANTHROPIC_MODELS_URL,
    ANTHROPIC_PRICING_URL,
    OPENAI_PRICING_URL,
    parseAnthropicModelIds,
    parseAnthropicPricing,
    parseOpenAiPricing,
    PriceParseError,
    type ParsedPrices,
} from "@/lib/ai-app-usage/price-watch/sources"
import type {
    CheckOutcome,
    CheckRun,
    PriceCandidate,
    ProviderCheckResult,
    WatchedProvider,
} from "@/lib/ai-app-usage/price-watch/types"
import { writeFileAtomic } from "@/lib/host-stats/store"
import type { PushMessage } from "@/lib/push/web-push"

/**
 * モデル単価表の定期チェック（#497）の入出力部分。判定は `diff.ts`・`sources.ts`（純粋関数）。
 * ここは公式ページの取得・状態ファイルの読み書き・通知の重複抑止を担う。
 *
 * **単価表（`models.ts`）は書き換えない。** 結果は `.data/model-price-watch.json` に残し、単価表の画面で人が確かめる。
 */

/** 履歴に残す実行の数（週1回で約1年ぶん） */
const HISTORY_LIMIT = 52

/** 全体または一部が失敗した回を、同じ予定時刻のうちにやり直す間隔と上限 */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000
const MAX_ATTEMPTS = 3

/** 手動更新の連打を止める間隔。基準は直近の実行の完了時刻（成功・失敗とも） */
export const MANUAL_MIN_INTERVAL_MS = 60 * 1000

const FETCH_TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface WatchState {
    lastRun: CheckRun | null
    /** 取得できなかった提供元が無かった最後の実行の完了時刻 */
    lastSuccessAt: string | null
    /** 最新の更新候補。取得に失敗した提供元は前回の候補を持ち越す */
    candidates: PriceCandidate[]
    history: CheckRun[]
    /** 直近の予定時刻と、そのうちの実行回数（失敗のやり直しを数える） */
    slot: { at: number; attempts: number } | null
    /** 通知済みの差分キー。差分が消えたら外れ、同じ内容が戻ってきたら再び通知する */
    notifiedKeys: string[]
    /** 通知済みの失敗の内容。同じ失敗が続く間は再通知しない */
    notifiedFailure: string | null
}

export const EMPTY_WATCH_STATE: WatchState = {
    lastRun: null,
    lastSuccessAt: null,
    candidates: [],
    history: [],
    slot: null,
    notifiedKeys: [],
    notifiedFailure: null,
}

function getStatePath(): string {
    return process.env.MODEL_PRICE_WATCH_PATH || path.join(process.cwd(), ".data", "model-price-watch.json")
}

export async function readWatchState(): Promise<WatchState> {
    try {
        const parsed = JSON.parse(await fs.readFile(getStatePath(), "utf8")) as Partial<WatchState> | null
        if (!parsed || typeof parsed !== "object") return EMPTY_WATCH_STATE
        return { ...EMPTY_WATCH_STATE, ...parsed }
    } catch {
        // 初回・壊れたファイルは「まだ確認していない」として扱う（予定時刻を過ぎていればすぐ実行する）
        return EMPTY_WATCH_STATE
    }
}

async function writeWatchState(state: WatchState): Promise<void> {
    await writeFileAtomic(getStatePath(), `${JSON.stringify(state, null, 2)}\n`)
}

/** 開発中のdev・worktreeで公式ページへ取りにいかないよう、本番かつ明示した環境だけで動かす */
export function isPriceWatchEnabled(env: Record<string, string | undefined> = process.env): boolean {
    if (env.MODEL_PRICE_WATCH_ENABLED === "0") return false
    return env.MODEL_PRICE_WATCH_ENABLED === "1" || env.NODE_ENV === "production"
}

export type FetchText = (url: string) => Promise<string>

/** 取得の失敗を、画面に出す短い理由つきで投げる */
export class FetchFailure extends Error {}

const defaultFetchText: FetchText = async (url) => {
    let response: Response
    try {
        response = await fetch(url, {
            headers: { "User-Agent": "status-hub-price-watch", Accept: "text/markdown, text/plain;q=0.9" },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            cache: "no-store",
        })
    } catch {
        throw new FetchFailure("接続できません")
    }
    if (!response.ok) throw new FetchFailure(`HTTP ${response.status}`)

    const text = await response.text()
    if (text.length > MAX_BODY_BYTES) throw new FetchFailure("応答が大きすぎます")
    return text
}

function failureReason(error: unknown): string {
    if (error instanceof FetchFailure) return error.message
    if (error instanceof PriceParseError) return `応答の形式が想定と異なります（${error.message}）`
    return "取得に失敗しました"
}

interface ProviderFetch {
    result: ProviderCheckResult
    parsed: ParsedPrices | null
}

async function checkAnthropic(fetchText: FetchText): Promise<ProviderFetch> {
    const base = { provider: "Anthropic", sourceUrls: [ANTHROPIC_PRICING_URL, ANTHROPIC_MODELS_URL] }
    const [pricing, models] = await Promise.allSettled([fetchText(ANTHROPIC_PRICING_URL), fetchText(ANTHROPIC_MODELS_URL)])

    try {
        if (pricing.status === "rejected") throw pricing.reason
        const warnings: string[] = []

        // IDの根拠はモデル概要だけ。読めなくても料金は確認できるため、IDを「未確定」にして続ける
        let ids = new Map<string, string>()
        try {
            if (models.status === "rejected") throw models.reason
            ids = parseAnthropicModelIds(models.value)
        } catch (error) {
            warnings.push(`モデルIDを確かめられませんでした（${failureReason(error)}）。IDは未確定として扱います`)
        }

        const parsed = parseAnthropicPricing(pricing.value, ids)
        return {
            result: { ...base, status: "ok", reason: null, modelCount: parsed.prices.length, warnings: [...warnings, ...parsed.warnings] },
            parsed,
        }
    } catch (error) {
        return { result: { ...base, status: "failed", reason: failureReason(error), modelCount: 0, warnings: [] }, parsed: null }
    }
}

async function checkOpenAi(fetchText: FetchText): Promise<ProviderFetch> {
    const base = { provider: "OpenAI", sourceUrls: [OPENAI_PRICING_URL] }
    try {
        const parsed = parseOpenAiPricing(await fetchText(OPENAI_PRICING_URL))
        return {
            result: { ...base, status: "ok", reason: null, modelCount: parsed.prices.length, warnings: parsed.warnings },
            parsed,
        }
    } catch (error) {
        return { result: { ...base, status: "failed", reason: failureReason(error), modelCount: 0, warnings: [] }, parsed: null }
    }
}

/** 公開の単価ページが無い提供元。失敗ではなく「対象外」として理由を残す */
const TYPESAFE_RESULT: ProviderCheckResult = {
    provider: "TypeSafe",
    status: "unavailable",
    reason: "公式の単価ページが公開されていないため、自動では確認できません",
    sourceUrls: [],
    modelCount: 0,
    warnings: [],
}

export function summarizeOutcome(providers: readonly ProviderCheckResult[], candidateCount: number): CheckOutcome {
    const checked = providers.filter((entry) => entry.status !== "unavailable")
    const failed = checked.filter((entry) => entry.status === "failed")
    if (checked.length > 0 && failed.length === checked.length) return "failed"
    if (failed.length > 0) return "partial"
    return candidateCount > 0 ? "candidates" : "unchanged"
}

const KIND_LABEL = { add: "追加", change: "価格変更", verify: "出典確認" } as const

export function buildCandidateMessage(fresh: readonly PriceCandidate[]): PushMessage {
    const counts = (["add", "change", "verify"] as const)
        .map((kind) => [kind, fresh.filter((entry) => entry.kind === kind).length] as const)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${KIND_LABEL[kind]} ${count}件`)
    const names = fresh.slice(0, 3).map((entry) => entry.name).join("・")
    return {
        title: "モデル単価表に更新候補があります",
        body: `${counts.join("・")}（${names}${fresh.length > 3 ? " ほか" : ""}）`,
        tag: "model-price-watch",
        url: "/",
    }
}

export function buildFailureMessage(failed: readonly ProviderCheckResult[]): PushMessage {
    return {
        title: "モデル単価の定期チェックに失敗しました",
        body: failed.map((entry) => `${entry.provider}: ${entry.reason}`).join(" / "),
        tag: "model-price-watch-failure",
        url: "/",
    }
}

export type Notify = (message: PushMessage) => Promise<boolean>

/** 通知を送る入口。Web Pushの設定や宛先の絞り込みは `notify.ts` に分け、テストからは差し替える */
async function defaultNotify(message: PushMessage): Promise<boolean> {
    return (await import("@/lib/ai-app-usage/price-watch/notify")).sendPriceWatchPush(message)
}

export interface RunOptions {
    now?: number
    fetchText?: FetchText
    notify?: Notify
    registered?: readonly ModelInfo[]
    /** 今回の実行を数える予定時刻。省略すると直近の予定時刻 */
    slotAt?: number
    /**
     * 画面の「更新」ボタンからの実行。予定時刻と試行回数（`slot`）を進めない。進めると、手動の連打や失敗が
     * 定期のやり直し（`MAX_ATTEMPTS`）を削り、手動の成功で定期がその週を実行済みと見なしてしまう
     */
    manual?: boolean
}

const globalForRun = globalThis as unknown as { __priceWatchRun?: Promise<WatchState> }

/**
 * 1回分のチェック。取得して差分を出し、状態を保存して、新しい差分と失敗だけを通知する。
 * 取得に失敗しても既存の単価表と前回の候補は保持する（失敗を「変更なし」にしない）。
 */
export function runModelPriceWatch(options: RunOptions = {}): Promise<WatchState> {
    if (globalForRun.__priceWatchRun) return globalForRun.__priceWatchRun

    const run = executeRun(options).finally(() => {
        globalForRun.__priceWatchRun = undefined
    })
    globalForRun.__priceWatchRun = run
    return run
}

async function executeRun(options: RunOptions): Promise<WatchState> {
    const now = options.now ?? Date.now()
    const fetchText = options.fetchText ?? defaultFetchText
    const notify = options.notify ?? defaultNotify
    const registered = options.registered ?? listModels()
    const startedAt = new Date(now).toISOString()
    const previous = await readWatchState()

    const [anthropic, openai] = await Promise.all([checkAnthropic(fetchText), checkOpenAi(fetchText)])
    const providers = [anthropic.result, openai.result, TYPESAFE_RESULT]
    const checkedAt = new Date().toISOString()

    // 取得できた提供元だけ作り直し、失敗した提供元は前回の候補を持ち越す
    const fresh: PriceCandidate[] = []
    const carried: PriceCandidate[] = []
    for (const [provider, fetched] of [["Anthropic", anthropic], ["OpenAI", openai]] as [WatchedProvider, ProviderFetch][]) {
        if (fetched.parsed) {
            fresh.push(...diffProvider({ provider, official: fetched.parsed.prices, registered, checkedAt }))
        } else {
            carried.push(...previous.candidates.filter((entry) => entry.provider === provider))
        }
    }
    const candidates = [...fresh, ...carried]

    const outcome = summarizeOutcome(providers, candidates.filter((entry) => entry.kind !== "delisted").length)
    const finishedAt = new Date().toISOString()
    const checkRun: CheckRun = {
        startedAt,
        finishedAt,
        outcome,
        providers,
        candidateCount: fresh.filter((entry) => entry.kind !== "delisted").length,
    }

    const slotAt = options.slotAt ?? latestSlot(now, readSchedule())
    const attempts = previous.slot?.at === slotAt ? previous.slot.attempts + 1 : 1

    let state: WatchState = {
        ...previous,
        lastRun: checkRun,
        lastSuccessAt: outcome === "unchanged" || outcome === "candidates" ? finishedAt : previous.lastSuccessAt,
        candidates,
        history: [checkRun, ...previous.history].slice(0, HISTORY_LIMIT),
        slot: options.manual ? previous.slot : { at: slotAt, attempts },
    }
    // 先に保存する。通知の途中でプロセスが落ちても、実行した事実と候補は残る
    await writeWatchState(state)

    // 通知するのは確かめてほしい差分だけ。掲載終了は情報としてだけ出す
    const hiddenKeys = readOverridesSync().hiddenCandidates
    const notifiable = candidates.filter((entry) => entry.kind !== "delisted" && !hiddenKeys.includes(entry.key))
    const newOnes = notifiable.filter((entry) => !previous.notifiedKeys.includes(entry.key))
    const failed = providers.filter((entry) => entry.status === "failed")
    const failureKey = failed.length > 0 ? failed.map((entry) => `${entry.provider}:${entry.reason}`).sort().join("|") : null

    let notifiedKeys = previous.notifiedKeys.filter((key) => notifiable.some((entry) => entry.key === key))
    let notifiedFailure = failureKey === null ? null : previous.notifiedFailure

    try {
        // 届かなかった通知は記録せず、次の実行で送り直す（#297と同じ。登録した端末が無い間も記録しない）
        if (newOnes.length > 0 && (await notify(buildCandidateMessage(newOnes)))) {
            notifiedKeys = [...new Set([...notifiedKeys, ...newOnes.map((entry) => entry.key)])]
        }
        if (failureKey !== null && failureKey !== previous.notifiedFailure && (await notify(buildFailureMessage(failed)))) {
            notifiedFailure = failureKey
        }
    } catch (error) {
        console.error("[model-price-watch] 通知に失敗しました:", error)
    }

    state = { ...state, notifiedKeys, notifiedFailure }
    await writeWatchState(state)
    return state
}

/** いま実行すべきか。予定時刻を過ぎて未実行、または失敗した回を一定時間あけてやり直す */
export function isDue(state: WatchState, now: number, schedule: WatchSchedule): boolean {
    const slot = latestSlot(now, schedule)
    if (!state.slot || slot > state.slot.at) return true

    const last = state.lastRun
    if (!last || state.slot.at !== slot || state.slot.attempts >= MAX_ATTEMPTS) return false
    const failed = last.outcome === "failed" || last.outcome === "partial"
    return failed && now - new Date(last.finishedAt).getTime() >= RETRY_AFTER_MS
}

/** 定期処理（`src/instrumentation.ts`）から呼ぶ。予定時刻に当たっていなければ何もしない */
export async function runModelPriceWatchIfDue(now = Date.now()): Promise<void> {
    if (!isPriceWatchEnabled()) return
    const schedule = readSchedule()
    if (!isDue(await readWatchState(), now, schedule)) return
    await runModelPriceWatch({ now, slotAt: latestSlot(now, schedule) })
}

/** 単価表の画面へ返す値 */
export interface PriceWatchView {
    enabled: boolean
    schedule: string
    nextRunAt: string
    lastRun: CheckRun | null
    lastSuccessAt: string | null
    /** 非表示にしたものを除いた更新候補 */
    candidates: PriceCandidate[]
    history: CheckRun[]
    /** 単価表の行（反映したモデルを含む。非表示の印付き。クライアントは `models.ts` の組み込み一覧ではなくこれを使う） */
    models: PriceModelRow[]
}

/** 単価表の1行。`hidden` は表示だけの印で、金額の計算には使われ続ける */
export interface PriceModelRow extends ModelInfo {
    hidden: boolean
    /** 画面操作で反映した（または価格を置き換えた）行 */
    added: boolean
}

export async function getPriceWatchView(now = Date.now()): Promise<PriceWatchView> {
    const state = await readWatchState()
    const schedule = readSchedule()
    const overrides = readOverridesSync()
    return {
        enabled: isPriceWatchEnabled(),
        schedule: describeSchedule(schedule),
        nextRunAt: new Date(nextSlot(now, schedule)).toISOString(),
        lastRun: state.lastRun,
        lastSuccessAt: state.lastSuccessAt,
        candidates: state.candidates.filter((entry) => !overrides.hiddenCandidates.includes(entry.key)),
        history: state.history.slice(0, 8),
        models: listModels().map((info) => ({
            ...info,
            hidden: overrides.hiddenModels.includes(info.id),
            added: overrides.added.some((entry) => entry.id === info.id),
        })),
    }
}

/** 直近の実行から間もないか（手動更新の連打を実行せずに返すための判定） */
export function isManualRunThrottled(state: WatchState, now: number): boolean {
    if (!state.lastRun) return false
    const elapsed = now - new Date(state.lastRun.finishedAt).getTime()
    return elapsed >= 0 && elapsed < MANUAL_MIN_INTERVAL_MS
}

/**
 * 画面の「更新」ボタン。公式ページを今すぐ確認し、画面へ返す形で結果を返す。
 * 直近の実行から60秒以内なら実行せず、保存済みの結果を `throttled` 付きで返す。
 * 同時に押された分は `runModelPriceWatch` の相乗りで1回にまとまる。
 */
export async function refreshModelPriceWatch(
    options: Omit<RunOptions, "manual"> = {}
): Promise<{ view: PriceWatchView; throttled: boolean }> {
    const now = options.now ?? Date.now()
    if (isManualRunThrottled(await readWatchState(), now)) {
        return { view: await getPriceWatchView(now), throttled: true }
    }
    await runModelPriceWatch({ ...options, now, manual: true })
    return { view: await getPriceWatchView(now), throttled: false }
}
