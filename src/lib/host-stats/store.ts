import fs from "fs/promises"
import path from "path"
import type {
    HostStatsHistoryPoint,
    HostStatsHostView,
    HostStatsReport,
    HostStatsSnapshot,
    HostStatsView,
} from "@/types/host-stats"
import { evaluateSensors, getSensorStaleAfterSeconds } from "@/lib/host-stats/sensors"

/**
 * 各ホストから受け取ったメトリクスの保管。
 *
 * 保存先は deploy.yml の削除対象に含まれない `.data/` 配下を既定とし、デプロイをまたいで
 * 履歴が消えないようにする（AI使用状況のトークン保管と同じ考え方）。
 * ホストごとにディレクトリを分けるため、VPS・サブPCが増えてもコードは変わらない。
 */

const DEFAULT_OFFLINE_AFTER_SECONDS = 300
const DEFAULT_HISTORY_HOURS = 24

/** グラフに載せる点の上限。1分間隔・24時間の1440点をそのまま返すとレスポンスが太るため間引く */
const MAX_VIEW_POINTS = 180

/** 履歴ファイルの1行あたりの見積もり。これを超えて膨らんだら期限切れの行を掃除する */
const HISTORY_LINE_BYTES = 160

function getDataDir(): string {
    return process.env.HOST_STATS_DATA_DIR || path.join(process.cwd(), ".data", "host-stats")
}

/**
 * ホスト1台分の保存先。最新スナップショット・履歴・通知の抑止状態を同じ場所へ置く。
 * `.data/` はデプロイの削除対象に入らないため、再デプロイをまたいでも消えない。
 */
export function getHostDataDir(id: string): string {
    return path.join(getDataDir(), id)
}

function getSnapshotPath(id: string): string {
    return path.join(getHostDataDir(id), "latest.json")
}

function getHistoryPath(id: string): string {
    return path.join(getHostDataDir(id), "history.jsonl")
}

function readPositiveInt(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] ?? "", 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function getOfflineAfterSeconds(): number {
    return readPositiveInt("HOST_STATS_OFFLINE_AFTER_SECONDS", DEFAULT_OFFLINE_AFTER_SECONDS)
}

export function getHistoryHours(): number {
    return readPositiveInt("HOST_STATS_HISTORY_HOURS", DEFAULT_HISTORY_HOURS)
}

/** 画面に並べる既定の順番（VPS・サブPC・Mac Mini・ラズパイ Zero W。#588） */
const DEFAULT_DISPLAY_ORDER = "vps,subpc,macmini,pi0w"

/** 画面に並べる順番。指定が無いホストは後ろへ回し、その中では識別子順にする */
function getDisplayOrder(): string[] {
    return (process.env.HOST_STATS_ORDER || DEFAULT_DISPLAY_ORDER)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
}

/**
 * ファイルへの読み書きを直列化する。
 * PM2 は fork モード1プロセスで動かしているため、プロセス内の直列化で足りる。
 */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

export async function writeFileAtomic(file: string, contents: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })

    // 書き込み中に読まれても壊れないよう、一時ファイル経由で差し替える
    const tempFile = `${file}.tmp`
    await fs.writeFile(tempFile, contents)
    await fs.rename(tempFile, file)
}

function toHistoryPoint(snapshot: HostStatsSnapshot): HostStatsHistoryPoint {
    // ディスクは複数を受け取れるが、履歴には最も使用率が高いものだけを残す
    const disk = snapshot.disks.reduce((worst, entry) =>
        entry.usedPercent > worst.usedPercent ? entry : worst
    )

    return {
        t: Math.floor(new Date(snapshot.receivedAt).getTime() / 1000),
        cpu: snapshot.cpuPercent,
        mem: snapshot.memory.usedPercent,
        disk: disk.usedPercent,
        load: snapshot.loadAverage[0],
        swap: snapshot.swap?.usedPercent,
        temp: snapshot.temperatureCelsius,
        rx: snapshot.network?.inBytesPerSecond,
        tx: snapshot.network?.outBytesPerSecond,
        ior: snapshot.diskIo?.inBytesPerSecond,
        iow: snapshot.diskIo?.outBytesPerSecond,
    }
}

function parseHistoryLines(raw: string, cutoffSeconds: number): HostStatsHistoryPoint[] {
    const points: HostStatsHistoryPoint[] = []

    for (const line of raw.split("\n")) {
        if (!line) continue
        try {
            const point = JSON.parse(line) as HostStatsHistoryPoint
            if (typeof point?.t === "number" && point.t >= cutoffSeconds) points.push(point)
        } catch {
            // 書き込み途中で切れた行などは捨てる
        }
    }

    return points
}

async function readHistoryFile(id: string, cutoffSeconds: number): Promise<HostStatsHistoryPoint[]> {
    try {
        return parseHistoryLines(await fs.readFile(getHistoryPath(id), "utf8"), cutoffSeconds)
    } catch {
        return []
    }
}

async function appendHistory(id: string, point: HostStatsHistoryPoint): Promise<void> {
    const file = getHistoryPath(id)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, `${JSON.stringify(point)}\n`)

    // 毎回全体を書き直すと無駄なため、想定サイズを超えたときだけ期限切れの行を落とす
    const maxBytes = getHistoryHours() * 60 * HISTORY_LINE_BYTES * 2
    const { size } = await fs.stat(file)
    if (size <= maxBytes) return

    const cutoffSeconds = Math.floor(Date.now() / 1000) - getHistoryHours() * 3600
    const kept = await readHistoryFile(id, cutoffSeconds)
    await writeFileAtomic(file, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""))
}

/** 受信したレポートを最新スナップショットとして保存し、履歴に1点追加する */
export async function saveHostStatsReport(
    report: HostStatsReport & { id: string }
): Promise<HostStatsSnapshot> {
    const snapshot: HostStatsSnapshot = { ...report, receivedAt: new Date().toISOString() }

    await serialize(async () => {
        await writeFileAtomic(getSnapshotPath(report.id), `${JSON.stringify(snapshot, null, 2)}\n`)
        await appendHistory(report.id, toHistoryPoint(snapshot))
    })

    return snapshot
}

export async function readSnapshot(id: string): Promise<HostStatsSnapshot | null> {
    try {
        const raw = await fs.readFile(getSnapshotPath(id), "utf8")
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object") return null
        return parsed as HostStatsSnapshot
    } catch {
        return null
    }
}

async function listHostIds(): Promise<string[]> {
    try {
        const entries = await fs.readdir(getDataDir(), { withFileTypes: true })
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
        return []
    }
}

function average(values: number[]): number {
    return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
}

function averageOf(
    bucket: HostStatsHistoryPoint[],
    key: keyof HostStatsHistoryPoint
): number | undefined {
    const values = bucket
        .map((point) => point[key])
        .filter((value): value is number => typeof value === "number")
    return values.length > 0 ? average(values) : undefined
}

/** 点が多いときは等間隔のバケットに束ねて平均を取る（形が保たれればよいので単純平均でよい） */
function downsample(points: HostStatsHistoryPoint[]): HostStatsHistoryPoint[] {
    if (points.length <= MAX_VIEW_POINTS) return points

    const bucketSize = Math.ceil(points.length / MAX_VIEW_POINTS)
    const result: HostStatsHistoryPoint[] = []

    for (let index = 0; index < points.length; index += bucketSize) {
        const bucket = points.slice(index, index + bucketSize)

        result.push({
            t: bucket[bucket.length - 1].t,
            cpu: average(bucket.map((point) => point.cpu)),
            mem: average(bucket.map((point) => point.mem)),
            disk: average(bucket.map((point) => point.disk)),
            load: average(bucket.map((point) => point.load)),
            swap: averageOf(bucket, "swap"),
            temp: averageOf(bucket, "temp"),
            rx: averageOf(bucket, "rx"),
            tx: averageOf(bucket, "tx"),
            ior: averageOf(bucket, "ior"),
            iow: averageOf(bucket, "iow"),
        })
    }

    return result
}

/**
 * 最終受信からの経過と、OFFLINEかどうかの判定。画面（`readHostView`）と、定期判定による
 * ホスト停止の検知・エラー件数（`src/lib/incidents/`）が同じ判定を共有する（#495）。
 */
export function judgeHostOnline(
    receivedAt: string,
    now: number,
    offlineAfterSeconds: number
): { ageSeconds: number; online: boolean } {
    const ageSeconds = Math.max(0, Math.round((now - new Date(receivedAt).getTime()) / 1000))
    return { ageSeconds, online: ageSeconds <= offlineAfterSeconds }
}

function toHostView(
    id: string,
    latest: HostStatsSnapshot,
    history: HostStatsHistoryPoint[],
    now: number,
    offlineAfterSeconds: number
): HostStatsHostView {
    const judged = judgeHostOnline(latest.receivedAt, now, offlineAfterSeconds)
    return {
        id,
        label: latest.label || latest.hostname,
        latest,
        ...judged,
        history,
        sensors: evaluateSensors(latest.sensors, {
            now,
            hostOnline: judged.online,
            staleAfterSeconds: getSensorStaleAfterSeconds(),
        }),
    }
}

async function readHostView(
    id: string,
    cutoffSeconds: number,
    offlineAfterSeconds: number
): Promise<HostStatsHostView | null> {
    const [latest, history] = await Promise.all([readSnapshot(id), readHistoryFile(id, cutoffSeconds)])
    if (!latest) return null

    return toHostView(id, latest, downsample(history), Date.now(), offlineAfterSeconds)
}

/**
 * 全ホストの最新スナップショットだけを返す（履歴は空）。数十秒おきの定期判定向けで、
 * 24時間分の履歴を毎回読まない。時刻は引数で渡す（テストと、判定の基準時刻を揃えるため）。
 */
export async function getHostLatestViews(now: number): Promise<HostStatsHostView[]> {
    const offlineAfterSeconds = getOfflineAfterSeconds()
    const views = await Promise.all(
        (await listHostIds()).map(async (id) => {
            const latest = await readSnapshot(id)
            return latest ? toHostView(id, latest, [], now, offlineAfterSeconds) : null
        })
    )

    return views
        .filter((view): view is HostStatsHostView => view !== null)
        .sort((a, b) => a.id.localeCompare(b.id))
}

/** ダッシュボード表示用に、全ホストの最新スナップショットと間引いた履歴をまとめて返す */
export async function getHostStatsView(): Promise<HostStatsView> {
    const historyHours = getHistoryHours()
    const offlineAfterSeconds = getOfflineAfterSeconds()
    const cutoffSeconds = Math.floor(Date.now() / 1000) - historyHours * 3600

    const ids = await listHostIds()
    const views = await Promise.all(
        ids.map((id) => readHostView(id, cutoffSeconds, offlineAfterSeconds))
    )

    const order = getDisplayOrder()
    const rank = (id: string) => {
        const index = order.indexOf(id)
        return index === -1 ? order.length : index
    }

    const hosts = views
        .filter((view): view is HostStatsHostView => view !== null)
        .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))

    return { hosts, offlineAfterSeconds, historyHours }
}
