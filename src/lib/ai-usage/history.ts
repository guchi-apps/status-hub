import fs from "fs/promises"
import path from "path"
import type {
    AiUsageSnapshot,
    AiUsageWindow,
    AiUsageWindowHistory,
    AiUsageWindowRecord,
    AiWeeklyMultiple,
} from "@/types/ai-usage"

/**
 * 終わった制限枠を「どれだけ使えたか」で振り返るための記録。
 *
 * 提供元が返すのは常に「いまの枠の使用率」だけで、過去の枠の実績を返すAPIは無い（#244）。
 * そのため取得のたびに枠ごとの使用率を書き留めておき、リセット時刻を過ぎた枠を確定値として扱う。
 * 使用率は枠の中で増える一方なので、枠ごとに最後に観測した値だけを残せば足りる
 * （1サンプル1行のログにすると際限なく伸びるうえ、集計にも使わない中間の値まで抱えることになる）。
 *
 * **記録できるのは観測できた時点の値だけ。** 取得はダッシュボードへのリクエストと
 * DeskMiniからのメトリクス受信を契機にしか走らないため、どちらも止まっていた時間帯は観測が飛ぶ。
 * 枠の終了間際に観測が無い枠は実際より低い値で確定するので、{@link AiUsageWindowRecord.undersampled}
 * を立てて画面側で区別できるようにしている。
 */

/** この使用率以上まで使った枠を「使い切った」として数える */
export const FULL_USE_PERCENT = 90

/** 枠の種類ごとに残す件数。画面に出す本数より多めに持ち、表示の上限を増やしても記録側を触らずに済むようにする */
const MAX_STORED_ENTRIES = 48

/** 画面に並べる本数。1日より短い枠（5時間枠）は本数を多めにして直近数日ぶんが見えるようにする */
const SHORT_WINDOW_DISPLAY = 12
const LONG_WINDOW_DISPLAY = 8
const LONG_WINDOW_SECONDS = 24 * 60 * 60

/**
 * 「枠の終了間際に観測できていた」とみなす、リセット時刻までの猶予。
 * 枠の長さの5%を基準にしつつ、短すぎる・長すぎる判定にならないよう上下で頭打ちにする。
 */
const UNDERSAMPLED_RATIO = 0.05
const MIN_UNDERSAMPLED_TOLERANCE_MS = 10 * 60 * 1000
const MAX_UNDERSAMPLED_TOLERANCE_MS = 60 * 60 * 1000

/**
 * 直前に記録した枠と同じ枠だとみなす、リセット時刻の進み幅（枠の長さに対する割合）。
 *
 * **リセット時刻の一致で同定してはいけない。** ChatGPTは `reset_at` を返さないことがあり、
 * その場合 `src/lib/ai-usage/chatgpt.ts` が `Date.now() + reset_after_seconds` で組み立てるため、
 * 同じ枠でも取得のたびに数秒ずれる。完全一致で見ると1取得ごとに別の枠として積み上がってしまう。
 * 本当にリセットされたときはリセット時刻が枠1つぶん先へ飛ぶので、その半分を境にする。
 */
const SAME_WINDOW_RATIO = 0.5

/** 枠1つぶんの観測結果。`resetsAt` が枠の識別子を兼ねる */
interface StoredEntry {
    resetsAt: string
    /** その枠で観測できた最大の使用率（0-100） */
    usedPercent: number
    /** 最後に観測した時刻（ISO 8601） */
    observedAt: string
}

/** 枠の種類（5時間・週間・週間Opus …）1つぶんの記録 */
interface StoredWindow {
    label: string
    note?: string
    windowSeconds: number
    /** リセット時刻の古い順 */
    entries: StoredEntry[]
}

interface HistoryState {
    /** 提供元ID → 枠の種類のキー → 記録 */
    providers: Record<string, Record<string, StoredWindow>>
}

function getStatePath(): string {
    return (
        process.env.AI_USAGE_HISTORY_PATH ||
        path.join(process.cwd(), ".data", "ai-usage-windows.json")
    )
}

/** 同じ長さでもモデル別の枠（週間 / 週間Opus）は別物なので、補足込みで区別する */
function windowKey(usageWindow: AiUsageWindow): string {
    return `${usageWindow.windowSeconds}:${usageWindow.note ?? ""}`
}

async function readState(): Promise<HistoryState> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(getStatePath(), "utf8"))
        if (!parsed || typeof parsed !== "object") return { providers: {} }

        const providers = (parsed as HistoryState).providers
        return { providers: providers && typeof providers === "object" ? providers : {} }
    } catch {
        return { providers: {} }
    }
}

async function writeState(state: HistoryState): Promise<void> {
    const file = getStatePath()
    await fs.mkdir(path.dirname(file), { recursive: true })

    // 書き込み中に読まれても壊れないよう、一時ファイル経由で差し替える
    const tempFile = `${file}.tmp`
    await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`)
    await fs.rename(tempFile, file)
}

/**
 * ファイルへの read-modify-write を直列化する。
 * PM2 は fork モード1プロセスで動かしているため、プロセス内の直列化で足りる。
 */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

/** 今回観測した枠を記録へ反映する。反映するものがあれば true */
function mergeWindow(
    windows: Record<string, StoredWindow>,
    usageWindow: AiUsageWindow,
    observedAt: string
): boolean {
    if (!usageWindow.resetsAt || !usageWindow.windowSeconds) return false
    if (Number.isNaN(Date.parse(usageWindow.resetsAt))) return false

    const key = windowKey(usageWindow)
    const stored: StoredWindow = windows[key] ?? {
        label: usageWindow.label,
        windowSeconds: usageWindow.windowSeconds,
        entries: [],
    }

    // 提供元が表示名を変えたときに古い名前が残らないよう、観測のたびに上書きする
    stored.label = usageWindow.label
    stored.note = usageWindow.note
    windows[key] = stored

    // 観測は時系列に並ぶため、突き合わせる相手は常に最後に記録した枠だけでよい
    const latest = stored.entries.at(-1)
    const advanceMs = latest ? Date.parse(usageWindow.resetsAt) - Date.parse(latest.resetsAt) : 0

    if (latest && advanceMs < usageWindow.windowSeconds * 1000 * SAME_WINDOW_RATIO) {
        // 秒単位のぶれに追随させる。使用率は枠の中で増える一方なので大きいほうを残す
        latest.resetsAt = usageWindow.resetsAt
        latest.usedPercent = Math.max(latest.usedPercent, usageWindow.usedPercent)
        latest.observedAt = observedAt
        return true
    }

    stored.entries.push({
        resetsAt: usageWindow.resetsAt,
        usedPercent: usageWindow.usedPercent,
        observedAt,
    })
    stored.entries.splice(0, Math.max(0, stored.entries.length - MAX_STORED_ENTRIES))

    return true
}

async function updateState(snapshot: AiUsageSnapshot): Promise<HistoryState> {
    const state = await readState()
    let changed = false

    for (const provider of snapshot.providers) {
        // 取得に失敗した提供元の 0% を実績として残すと、使っていない枠として確定してしまう
        if (provider.status !== "ok") continue

        const windows = (state.providers[provider.id] ??= {})
        for (const usageWindow of provider.windows) {
            if (mergeWindow(windows, usageWindow, snapshot.fetchedAt)) changed = true
        }
    }

    if (changed) await writeState(state)
    return state
}

function undersampledToleranceMs(windowSeconds: number): number {
    return Math.min(
        Math.max(windowSeconds * 1000 * UNDERSAMPLED_RATIO, MIN_UNDERSAMPLED_TOLERANCE_MS),
        MAX_UNDERSAMPLED_TOLERANCE_MS
    )
}

function toHistory(stored: StoredWindow, now: number): AiUsageWindowHistory | null {
    if (stored.entries.length === 0) return null

    const limit =
        stored.windowSeconds >= LONG_WINDOW_SECONDS ? LONG_WINDOW_DISPLAY : SHORT_WINDOW_DISPLAY
    const tolerance = undersampledToleranceMs(stored.windowSeconds)

    const records = stored.entries.slice(-limit).map<AiUsageWindowRecord>((entry) => {
        const resetsAtMs = Date.parse(entry.resetsAt)
        const inProgress = resetsAtMs > now

        return {
            resetsAt: entry.resetsAt,
            usedPercent: Math.round(entry.usedPercent * 10) / 10,
            inProgress,
            undersampled: !inProgress && resetsAtMs - Date.parse(entry.observedAt) > tolerance,
        }
    })

    const completed = records.filter((record) => !record.inProgress)
    const total = completed.reduce((sum, record) => sum + record.usedPercent, 0)

    return {
        label: stored.label,
        note: stored.note,
        windowSeconds: stored.windowSeconds,
        records,
        averagePercent: completed.length > 0 ? Math.round(total / completed.length) : null,
        fullCount: completed.filter((record) => record.usedPercent >= FULL_USE_PERCENT).length,
        completedCount: completed.length,
    }
}

const FIVE_HOUR_SECONDS = 5 * 60 * 60
const WEEK_SECONDS = 7 * 24 * 60 * 60

/** これ未満の週間使用率では、整数%の丸めで倍率が大きくぶれるため推定しない */
export const MIN_WEEKLY_PERCENT_FOR_MULTIPLE = 10

/**
 * 週間枠が5時間枠の何倍かを推定する（#523）。
 * 今週（週間枠の開始以降に始まった）5時間枠の使用率の合計 ÷ 週間枠の使用率。
 * 観測が足りない終了済みの5時間枠は低く記録されるため、含むときは `lowerBound` を立てる。
 */
export function estimateWeeklyMultiple(
    fiveHourEntries: StoredEntry[],
    weeklyEntry: StoredEntry,
    now: number
): AiWeeklyMultiple | null {
    const weeklyResetsAt = Date.parse(weeklyEntry.resetsAt)
    if (Number.isNaN(weeklyResetsAt) || weeklyResetsAt <= now) return null

    const weekStart = weeklyResetsAt - WEEK_SECONDS * 1000
    const tolerance = undersampledToleranceMs(FIVE_HOUR_SECONDS)

    let count = 0
    let total = 0
    // 保持数の上限で古い記録が切り捨てられ、週の始まりまで届いていないときも小さく出る
    let lowerBound =
        fiveHourEntries.length >= MAX_STORED_ENTRIES &&
        Date.parse(fiveHourEntries[0].resetsAt) - FIVE_HOUR_SECONDS * 1000 > weekStart

    for (const entry of fiveHourEntries) {
        const resetsAt = Date.parse(entry.resetsAt)
        if (Number.isNaN(resetsAt)) continue
        // 週の境目をまたぐ枠は、どちらの週の使用か分からないので数えない
        if (resetsAt - FIVE_HOUR_SECONDS * 1000 < weekStart) continue

        count += 1
        total += entry.usedPercent
        if (resetsAt <= now && resetsAt - Date.parse(entry.observedAt) > tolerance) lowerBound = true
    }

    const weeklyPercent = weeklyEntry.usedPercent
    const usable = weeklyPercent >= MIN_WEEKLY_PERCENT_FOR_MULTIPLE && total > 0

    return {
        multiple: usable ? Math.round((total / weeklyPercent) * 10) / 10 : null,
        fiveHourCount: count,
        fiveHourTotalPercent: Math.round(total),
        weeklyPercent: Math.round(weeklyPercent * 10) / 10,
        lowerBound,
    }
}

function buildHistory(stored: Record<string, StoredWindow>, now: number): AiUsageWindowHistory[] {
    return Object.values(stored)
        .map((window) => toHistory(window, now))
        .filter((history): history is AiUsageWindowHistory => history !== null)
        .sort((a, b) => a.windowSeconds - b.windowSeconds || a.label.localeCompare(b.label))
}

/**
 * 今回の使用状況を記録へ反映し、提供元ごとの使い切り実績をスナップショットへ載せる。
 *
 * 記録の読み書きに失敗しても使用状況の表示は続けたいため、例外にはせず警告だけ出す
 * （その場合は実績のブロックが出ないだけで、既存の使用量バーはそのまま表示される）。
 */
export async function applyAiUsageHistory(snapshot: AiUsageSnapshot): Promise<void> {
    let state: HistoryState
    try {
        state = await serialize(() => updateState(snapshot))
    } catch (error) {
        console.warn("AI usage: 枠の使い切りの記録に失敗", error)
        return
    }

    const fetchedAtMs = Date.parse(snapshot.fetchedAt)
    const now = Number.isNaN(fetchedAtMs) ? Date.now() : fetchedAtMs

    for (const provider of snapshot.providers) {
        const stored = state.providers[provider.id]
        if (!stored) continue

        const history = buildHistory(stored, now)
        if (history.length > 0) provider.windowHistory = history

        if (provider.id === "claude") {
            const fiveHour = stored[`${FIVE_HOUR_SECONDS}:`]?.entries
            const weeklyEntry = stored[`${WEEK_SECONDS}:`]?.entries.at(-1)
            const multiple = fiveHour && weeklyEntry && estimateWeeklyMultiple(fiveHour, weeklyEntry, now)
            if (multiple) provider.weeklyMultiple = multiple
        }
    }
}
