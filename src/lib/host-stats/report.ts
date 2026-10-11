import type {
    HostStatsApps,
    HostStatsDisk,
    HostStatsMaintenance,
    HostStatsProcess,
    HostStatsRate,
    HostStatsReport,
    HostStatsSensors,
    HostStatsService,
    HostStatsSessions,
    HostStatsTimer,
    HostStatsTmuxSession,
    HostStatsUsage,
} from "@/types/host-stats"

/**
 * エージェントが送るペイロードの形式バージョン。
 * エージェント側を非互換に変えたらここを上げ、古いエージェントからのPOSTを弾く。
 */
export const HOST_STATS_PAYLOAD_VERSION = 1

/** 1レポートに載せられる件数の上限（壊れた・悪意あるペイロードで肥大させないため） */
const MAX_DISKS = 8
const MAX_SERVICES = 20
const MAX_TIMERS = 20
const MAX_PROCESSES = 5
const MAX_SESSION_USERS = 10
const MAX_TMUX_SESSIONS = 20
const MAX_TMUX_COMMANDS = 4
const MAX_APPS = 30
const MAX_SENSORS = 10
const MAX_TEXT_LENGTH = 120

/** ホスト識別子に使える文字。保存先のディレクトリ名になるため、パス区切りなどを通さない */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * Issueのリポジトリ名（owner/repo）。
 * この値から GitHub のURLを組み立てるため、形を検査しないまま画面へ渡さない。
 */
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export class HostStatsReportError extends Error {}

function fail(message: string): never {
    throw new HostStatsReportError(message)
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} がオブジェクトではありません`)
    return value as Record<string, unknown>
}

function asNumber(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} が数値ではありません`)
    return value
}

function asText(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) fail(`${field} が文字列ではありません`)
    return value.slice(0, MAX_TEXT_LENGTH)
}

function asOptionalText(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined
    return asText(value, field)
}

function clampPercent(value: number): number {
    return Math.min(100, Math.max(0, Math.round(value * 10) / 10))
}

function nonNegative(value: number): number {
    return Math.max(0, value)
}

/** 任意の件数・バイト数。送ってこない世代のエージェントがあるため undefined を通す */
function asOptionalCount(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null) return undefined
    return Math.round(nonNegative(asNumber(value, field)))
}

function parseUsage(value: unknown, field: string): HostStatsUsage {
    const record = asRecord(value, field)
    return {
        usedBytes: nonNegative(asNumber(record.usedBytes, `${field}.usedBytes`)),
        totalBytes: nonNegative(asNumber(record.totalBytes, `${field}.totalBytes`)),
        usedPercent: clampPercent(asNumber(record.usedPercent, `${field}.usedPercent`)),
    }
}

function parseDisks(value: unknown): HostStatsDisk[] {
    if (!Array.isArray(value)) fail("disks が配列ではありません")
    if (value.length === 0) fail("disks が空です")

    return value.slice(0, MAX_DISKS).map((entry, index) => ({
        ...parseUsage(entry, `disks[${index}]`),
        path: asText(asRecord(entry, `disks[${index}]`).path, `disks[${index}].path`),
    }))
}

/**
 * 稼働中として扱う state。socket activation されたサービスは接続が来るまで .service が
 * inactive のままで、待ち受けは .socket が持つ。エージェントはその状態を listening として
 * 送るため（`scripts/host-stats/agent.sh`）、ここでも稼働中に数える（#187）
 */
const ACTIVE_SERVICE_STATES = new Set(["active", "listening"])

function parseServices(value: unknown): HostStatsService[] {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) fail("services が配列ではありません")

    return value.slice(0, MAX_SERVICES).map((entry, index) => {
        const record = asRecord(entry, `services[${index}]`)
        const state = asText(record.state, `services[${index}].state`)
        return {
            name: asText(record.name, `services[${index}].name`),
            state,
            active: ACTIVE_SERVICE_STATES.has(state),
        }
    })
}

/**
 * 定期ジョブの状態。
 * `HOST_STATS_TIMERS` を設定していないホストは項目ごと送ってこないため、undefined を通す。
 * 状態を取得できなかったユニットも `available: false` として受け取り、異常とは区別する。
 */
function parseTimers(value: unknown): HostStatsTimer[] | undefined {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) fail("timers が配列ではありません")

    return value.slice(0, MAX_TIMERS).map((entry, index) => {
        const record = asRecord(entry, `timers[${index}]`)
        return {
            name: asText(record.name, `timers[${index}].name`),
            unit: asText(record.unit, `timers[${index}].unit`),
            user: asOptionalText(record.user, `timers[${index}].user`),
            available: record.available === true,
            loaded: asOptionalBoolean(record.loaded),
            active: asOptionalBoolean(record.active),
            enabled: asOptionalText(record.enabled, `timers[${index}].enabled`),
            lastTriggerAt: asOptionalText(record.lastTriggerAt, `timers[${index}].lastTriggerAt`),
            nextElapseAt: asOptionalText(record.nextElapseAt, `timers[${index}].nextElapseAt`),
            result: asOptionalText(record.result, `timers[${index}].result`),
            exitStatus: asOptionalCount(record.exitStatus, `timers[${index}].exitStatus`),
            lastFinishedAt: asOptionalText(record.lastFinishedAt, `timers[${index}].lastFinishedAt`),
            running: asOptionalBoolean(record.running),
        }
    })
}

/** 送ってこない世代のエージェントと false を取り違えないよう、undefined を残す */
function asOptionalBoolean(value: unknown): boolean | undefined {
    if (value === undefined || value === null) return undefined
    return value === true
}

function parseLoadAverage(value: unknown): [number, number, number] {
    if (!Array.isArray(value) || value.length !== 3) fail("loadAverage が3要素の配列ではありません")
    const [one, five, fifteen] = value.map((entry, index) =>
        nonNegative(asNumber(entry, `loadAverage[${index}]`))
    )
    return [one, five, fifteen]
}

function parseRate(value: unknown, field: string): HostStatsRate | undefined {
    if (value === undefined || value === null) return undefined
    const record = asRecord(value, field)
    return {
        inBytesPerSecond: nonNegative(asNumber(record.inBytesPerSecond, `${field}.inBytesPerSecond`)),
        outBytesPerSecond: nonNegative(asNumber(record.outBytesPerSecond, `${field}.outBytesPerSecond`)),
    }
}

/** CPU順・メモリ順のどちらも同じ形なので、項目名だけ変えて使い回す */
function parseProcesses(value: unknown, field: string): HostStatsProcess[] | undefined {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) fail(`${field} が配列ではありません`)

    return value.slice(0, MAX_PROCESSES).map((entry, index) => {
        const record = asRecord(entry, `${field}[${index}]`)
        return {
            name: asText(record.name, `${field}[${index}].name`),
            cpuPercent: clampPercent(asNumber(record.cpuPercent, `${field}[${index}].cpuPercent`)),
            memoryBytes: asOptionalCount(record.memoryBytes, `${field}[${index}].memoryBytes`),
        }
    })
}

function parseMaintenance(value: unknown): HostStatsMaintenance | undefined {
    if (value === undefined || value === null) return undefined
    const record = asRecord(value, "maintenance")

    return {
        rebootRequired: record.rebootRequired === true,
        updatesAvailable: asOptionalCount(record.updatesAvailable, "maintenance.updatesAvailable"),
        securityUpdatesAvailable: asOptionalCount(
            record.securityUpdatesAvailable,
            "maintenance.securityUpdatesAvailable"
        ),
    }
}

function parseSessions(value: unknown): HostStatsSessions | undefined {
    if (value === undefined || value === null) return undefined
    const record = asRecord(value, "sessions")
    const users = Array.isArray(record.users) ? record.users : []

    return {
        count: Math.round(nonNegative(asNumber(record.count, "sessions.count"))),
        users: users.slice(0, MAX_SESSION_USERS).map((user, index) => asText(user, `sessions.users[${index}]`)),
    }
}

function parseTmuxSessions(value: unknown): HostStatsTmuxSession[] | undefined {
    // tmux が入っていないホストは項目ごと送ってこない。0件（空配列）とは意味が違うので区別する
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) fail("tmuxSessions が配列ではありません")

    return value.slice(0, MAX_TMUX_SESSIONS).map((entry, index) => {
        const record = asRecord(entry, `tmuxSessions[${index}]`)
        return {
            name: asText(record.name, `tmuxSessions[${index}].name`),
            windows: Math.round(nonNegative(asNumber(record.windows, `tmuxSessions[${index}].windows`))),
            attached: record.attached === true,
            createdAt: asOptionalText(record.createdAt, `tmuxSessions[${index}].createdAt`),
            user: asOptionalText(record.user, `tmuxSessions[${index}].user`),
            commands: parseTmuxCommands(record.commands, index),
            // 送ってこない世代のエージェントと「シェルだけで待機中」を取り違えないよう undefined を残す
            busy: record.busy === undefined || record.busy === null ? undefined : record.busy === true,
            lastActivityAt: asOptionalText(
                record.lastActivityAt,
                `tmuxSessions[${index}].lastActivityAt`
            ),
            path: asOptionalText(record.path, `tmuxSessions[${index}].path`),
            holdReason: asOptionalText(record.holdReason, `tmuxSessions[${index}].holdReason`),
            holdReasonAt: asOptionalText(record.holdReasonAt, `tmuxSessions[${index}].holdReasonAt`),
            lastEventName: asOptionalText(
                record.lastEventName,
                `tmuxSessions[${index}].lastEventName`
            ),
            lastEventAt: asOptionalText(record.lastEventAt, `tmuxSessions[${index}].lastEventAt`),
            issueRepository: parseRepositoryFullName(record.issueRepository, index),
            issueNumber: asOptionalCount(record.issueNumber, `tmuxSessions[${index}].issueNumber`),
        }
    })
}

/** owner/repo の形を満たさない値は、エラーにせず落とす（リンクが出ないだけで一覧は使える） */
function parseRepositoryFullName(value: unknown, index: number): string | undefined {
    const text = asOptionalText(value, `tmuxSessions[${index}].issueRepository`)
    if (text === undefined) return undefined
    return REPOSITORY_PATTERN.test(text) ? text : undefined
}

function parseTmuxCommands(value: unknown, index: number): string[] | undefined {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) fail(`tmuxSessions[${index}].commands が配列ではありません`)

    return value
        .slice(0, MAX_TMUX_COMMANDS)
        .map((command, commandIndex) =>
            asText(command, `tmuxSessions[${index}].commands[${commandIndex}]`)
        )
}

/**
 * アプリ別のメモリ・ディスク使用量（#226）。
 * `HOST_STATS_APPS_ROOT` を設定していないホストは項目ごと送ってこないため、undefined を通す。
 */
function parseApps(value: unknown): HostStatsApps | undefined {
    if (value === undefined || value === null) return undefined
    const record = asRecord(value, "apps")
    const items = record.items
    if (!Array.isArray(items)) fail("apps.items が配列ではありません")

    return {
        root: asText(record.root, "apps.root"),
        items: items.slice(0, MAX_APPS).map((entry, index) => {
            const item = asRecord(entry, `apps.items[${index}]`)
            return {
                name: asText(item.name, `apps.items[${index}].name`),
                memoryBytes: asOptionalCount(item.memoryBytes, `apps.items[${index}].memoryBytes`) ?? 0,
                processes: asOptionalCount(item.processes, `apps.items[${index}].processes`) ?? 0,
                diskBytes: asOptionalCount(item.diskBytes, `apps.items[${index}].diskBytes`),
            }
        }),
        disk: record.disk === undefined || record.disk === null ? undefined : parseUsage(record.disk, "apps.disk"),
        diskMeasuredAt: asOptionalText(record.diskMeasuredAt, "apps.diskMeasuredAt"),
    }
}

/**
 * センサーの取得状況（#581）。
 * `HOST_STATS_SENSOR_STATUS_FILE` を設定していないホストは項目ごと送ってこないため、undefined を通す。
 * 時刻は鮮度の判定に使うため、日時として読めない値は落とす（壊れた値で「最新」に見せない）。
 */
function parseSensors(value: unknown): HostStatsSensors | undefined {
    if (value === undefined || value === null) return undefined
    const record = asRecord(value, "sensors")
    const items = record.items === undefined || record.items === null ? [] : record.items
    if (!Array.isArray(items)) fail("sensors.items が配列ではありません")

    return {
        available: record.available === true,
        items: items.slice(0, MAX_SENSORS).map((entry, index) => {
            const item = asRecord(entry, `sensors.items[${index}]`)
            return {
                name: asText(item.name, `sensors.items[${index}].name`),
                lastAttemptAt: asOptionalTimestamp(item.lastAttemptAt, `sensors.items[${index}].lastAttemptAt`),
                lastSuccessAt: asOptionalTimestamp(item.lastSuccessAt, `sensors.items[${index}].lastSuccessAt`),
                lastResult: asOptionalText(item.lastResult, `sensors.items[${index}].lastResult`),
            }
        }),
    }
}

function asOptionalTimestamp(value: unknown, field: string): string | undefined {
    const text = asOptionalText(value, field)
    if (text === undefined) return undefined
    return Number.isFinite(new Date(text).getTime()) ? text : undefined
}

/** ホスト名から保存先に使える識別子を作る（エージェントが id を送ってこない場合の保険） */
function slugFromHostname(hostname: string): string {
    const slug = hostname
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/^-+/, "")
        .slice(0, 64)
    return slug || "host"
}

/** POSTされたJSONを検証し、保管できる形に正規化する。壊れていれば HostStatsReportError を投げる */
export function parseHostStatsReport(input: unknown): HostStatsReport & { id: string } {
    const record = asRecord(input, "payload")

    const version = asNumber(record.version, "version")
    if (version !== HOST_STATS_PAYLOAD_VERSION) {
        fail(`version ${version} は未対応です（このダッシュボードは ${HOST_STATS_PAYLOAD_VERSION}）`)
    }

    const swap = record.swap === undefined || record.swap === null ? undefined : parseUsage(record.swap, "swap")
    const temperature =
        record.temperatureCelsius === undefined || record.temperatureCelsius === null
            ? undefined
            : Math.round(asNumber(record.temperatureCelsius, "temperatureCelsius") * 10) / 10

    const hostname = asText(record.hostname, "hostname")
    const id = record.id === undefined || record.id === null ? slugFromHostname(hostname) : asText(record.id, "id")
    if (!ID_PATTERN.test(id)) {
        fail(`id "${id}" は英小文字・数字・ハイフン・アンダースコアのみ（64文字以内）にしてください`)
    }

    return {
        version,
        id,
        label: asOptionalText(record.label, "label"),
        hostname,
        os: asOptionalText(record.os, "os"),
        kernel: asOptionalText(record.kernel, "kernel"),
        collectedAt: asOptionalText(record.collectedAt, "collectedAt"),
        cpuPercent: clampPercent(asNumber(record.cpuPercent, "cpuPercent")),
        cpuModel: asOptionalText(record.cpuModel, "cpuModel"),
        cpuThreads: asOptionalCount(record.cpuThreads, "cpuThreads"),
        memory: parseUsage(record.memory, "memory"),
        swap,
        disks: parseDisks(record.disks),
        loadAverage: parseLoadAverage(record.loadAverage),
        uptimeSeconds: Math.round(nonNegative(asNumber(record.uptimeSeconds, "uptimeSeconds"))),
        temperatureCelsius: temperature,
        network: parseRate(record.network, "network"),
        diskIo: parseRate(record.diskIo, "diskIo"),
        topProcesses: parseProcesses(record.topProcesses, "topProcesses"),
        topMemoryProcesses: parseProcesses(record.topMemoryProcesses, "topMemoryProcesses"),
        maintenance: parseMaintenance(record.maintenance),
        sessions: parseSessions(record.sessions),
        tmuxSessions: parseTmuxSessions(record.tmuxSessions),
        tmuxSessionTotal: asOptionalCount(record.tmuxSessionTotal, "tmuxSessionTotal"),
        apps: parseApps(record.apps),
        services: parseServices(record.services),
        timers: parseTimers(record.timers),
        sensors: parseSensors(record.sensors),
    }
}
