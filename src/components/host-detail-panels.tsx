"use client"

import { AppDiskBreakdown, AppMemoryBreakdown } from "@/components/app-resources"
import { getTemperatureColor, getUsageColor, NEUTRAL_METRIC_COLORS } from "@/components/metric-card"
import { Sparkline } from "@/components/sparkline"
import { StatusBadge, StatusDot, type StatusTone } from "@/components/status-badge"
import { describeCpu, formatAge, formatBytes, formatUptime } from "@/lib/host-stats/format"
import { pickSeries, sumSeries } from "@/lib/host-stats/history"
import { describeTimer, evaluateTimers, type TimerState } from "@/lib/host-stats/timers"
import { cn } from "@/lib/utils"
import type { HostStatsHostView, HostStatsProcess, HostStatsTmuxSession } from "@/types/host-stats"

/** ホストごとに開ける詳細の種類。カード1枚に1つ対応する */
export type HostDetailKind = "cpu" | "memory" | "swap" | "disk" | "load" | "network" | "diskIo" | "uptime" | "temp" | "systems"

export const HOST_DETAIL_TITLES: Record<HostDetailKind, string> = {
    cpu: "CPU",
    memory: "Memory",
    swap: "Swap",
    disk: "Disk",
    load: "Load Avg",
    network: "Network",
    diskIo: "Disk I/O",
    uptime: "Uptime",
    temp: "Temp",
    systems: "稼働システム",
}

/** 温度グラフの縦軸の最小の幅（℃）。変動が小さいときに波形が暴れて見えないようにする */
const MIN_TEMPERATURE_SPAN = 10

/** 定期ジョブの状態と色の対応。unknown は「壊れている」ではないので警告どまりにする */
const TIMER_TONES: Record<TimerState, StatusTone> = {
    ok: "ok",
    running: "info",
    failed: "danger",
    overdue: "danger",
    stopped: "danger",
    missing: "danger",
    unknown: "warn",
}

function formatRate(bytesPerSecond: number): string {
    return `${formatBytes(bytesPerSecond)}/s`
}

/** 履歴がまだ無い（起動直後など）ときは、空のグラフではなく文言で伝える */
function History({
    values,
    className,
    label,
    min,
    max,
    hours,
}: {
    values: number[]
    className: string
    label: string
    min?: number
    max?: number
    hours: number
}) {
    return (
        <Section title={`直近${hours}時間の推移`}>
            {values.length < 2 ? (
                <p className="text-xs text-muted-foreground">推移のデータがまだありません。</p>
            ) : (
                <Sparkline values={values} min={min} max={max} className={cn("h-14 w-full", className)} label={label} />
            )}
        </Section>
    )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="space-y-2">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</h3>
            {children}
        </section>
    )
}

function Facts({ rows }: { rows: { label: string; value: string }[] }) {
    return (
        <dl className="divide-y divide-border/60 text-xs">
            {rows.map((row) => (
                <div key={row.label} className="flex justify-between gap-3 py-1.5">
                    <dt className="text-muted-foreground">{row.label}</dt>
                    <dd className="text-right font-mono [overflow-wrap:anywhere]">{row.value}</dd>
                </div>
            ))}
        </dl>
    )
}

function BigValue({ value, className, caption }: { value: string; className?: string; caption?: string }) {
    return (
        <div>
            <div className={cn("font-mono text-3xl font-bold", className)}>{value}</div>
            {caption && <div className="mt-0.5 text-xs text-muted-foreground">{caption}</div>}
        </div>
    )
}

function ProcessList({
    title,
    processes,
    format,
}: {
    title: string
    processes?: HostStatsProcess[]
    format: (process: HostStatsProcess) => string
}) {
    return (
        <Section title={title}>
            {!processes || processes.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    {processes ? "対象のプロセスはありません。" : "未取得です（このホストのエージェントはプロセスの一覧を送っていません）。"}
                </p>
            ) : (
                <Facts rows={processes.map((process, index) => ({ label: `${index + 1}. ${process.name}`, value: format(process) }))} />
            )}
        </Section>
    )
}

/** オフラインのホストの詳細に出す注意。値は最後に受け取った時点のもの */
function StaleNotice({ host }: { host: HostStatsHostView }) {
    if (host.online) return null

    return (
        <p
            className="rounded-lg border border-dashed border-red-500/50 bg-red-500/10 px-3 py-2 text-xs text-red-200"
            role="status"
        >
            オフラインの可能性があります。最終受信は{formatAge(host.ageSeconds)}で、表示しているのはその時点の値です。
        </p>
    )
}

function tmuxAgeSeconds(createdAt?: string): number | undefined {
    if (!createdAt) return undefined

    const created = Date.parse(createdAt)
    if (Number.isNaN(created)) return undefined

    return Math.max(0, Math.floor((Date.now() - created) / 1000))
}

function formatTmuxDetail(session: HostStatsTmuxSession, withUser: boolean): string {
    const parts = [`${session.windows}窓`]

    const age = tmuxAgeSeconds(session.createdAt)
    if (age !== undefined) parts.push(formatUptime(age))
    if (withUser && session.user) parts.push(session.user)

    return parts.join(" · ")
}

export interface SystemsSummary {
    /** サービスを送ってくるホストか。送らないホストは「未取得」 */
    servicesReported: boolean
    services: number
    stoppedServices: number
    timers: number
    abnormalTimers: number
    tmux: number
    /** danger の件数（停止したサービス＋異常な定期ジョブ）。見出しとカードの要約に使う */
    problems: number
    /** 再起動待ち・更新あり・取得できなかったジョブ。異常ではないが気に留めたいもの */
    notices: number
}

/** 稼働システムの要約。カード・ホスト見出しで同じ数え方を使う */
export function summarizeSystems(host: HostStatsHostView): SystemsSummary {
    const { latest } = host
    const timerStatuses = evaluateTimers(latest.timers)
    const stoppedServices = (latest.services ?? []).filter((service) => !service.active).length
    const abnormalTimers = timerStatuses.filter((status) => status.abnormal).length
    const unknownTimers = timerStatuses.filter((status) => status.state === "unknown").length
    const maintenance = latest.maintenance

    return {
        servicesReported: latest.services !== undefined,
        services: latest.services?.length ?? 0,
        stoppedServices,
        timers: timerStatuses.length,
        abnormalTimers,
        tmux: latest.tmuxSessions?.length ?? 0,
        problems: stoppedServices + abnormalTimers,
        notices:
            unknownTimers + (maintenance?.rebootRequired ? 1 : 0) + ((maintenance?.updatesAvailable ?? 0) > 0 ? 1 : 0),
    }
}

function SystemsPanel({ host }: { host: HostStatsHostView }) {
    const { latest } = host
    const services = latest.services
    const timerStatuses = evaluateTimers(latest.timers)
    const tmuxSessions = latest.tmuxSessions ?? []
    const tmuxUserCount = new Set(tmuxSessions.map((session) => session.user).filter(Boolean)).size
    // エージェントが送信上限で切り捨てた分。並んでいる一覧が全てだと思わせないよう件数を出す
    const tmuxUntracked = Math.max(0, (latest.tmuxSessionTotal ?? tmuxSessions.length) - tmuxSessions.length)
    const { maintenance, sessions } = latest

    return (
        <>
            <Section title="サービス">
                {!services ? (
                    <p className="text-xs text-muted-foreground">未取得です。</p>
                ) : services.length === 0 ? (
                    <p className="text-xs text-muted-foreground">監視対象のサービスはありません。</p>
                ) : (
                    <div className="flex flex-wrap gap-2">
                        {services.map((service) => (
                            <StatusBadge key={service.name} tone={service.active ? "ok" : "danger"} withDot>
                                {service.name}
                                <span className="opacity-70">{service.state}</span>
                            </StatusBadge>
                        ))}
                    </div>
                )}
            </Section>

            <Section title="定期ジョブ">
                {timerStatuses.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        {latest.timers ? "監視対象の定期ジョブはありません。" : "未設定です（このホストは定期ジョブを送っていません）。"}
                    </p>
                ) : (
                    <ul className="space-y-1.5">
                        {timerStatuses.map((status) => (
                            <li key={status.timer.name} className="flex items-start gap-2 text-xs">
                                <StatusDot tone={TIMER_TONES[status.state]} className="mt-1.5" />
                                <span className="shrink-0 font-mono">{status.timer.name}</span>
                                <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
                                    {describeTimer(status)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            <Section title="tmux">
                {tmuxSessions.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        {latest.tmuxSessions ? "セッションはありません。" : "未取得です（tmux が無いホスト、または対応前のエージェントです）。"}
                    </p>
                ) : (
                    <div className="flex flex-wrap gap-2">
                        {tmuxSessions.map((session, index) => (
                            <StatusBadge
                                key={`${session.user ?? ""}/${session.name}/${index}`}
                                tone={session.attached ? "ok" : "neutral"}
                                withDot={session.attached}
                            >
                                {session.name}
                                <span className="opacity-70">{formatTmuxDetail(session, tmuxUserCount > 1)}</span>
                            </StatusBadge>
                        ))}
                        {tmuxUntracked > 0 && (
                            <StatusBadge tone="warn">
                                送信上限のため 他 {tmuxUntracked}件（全 {latest.tmuxSessionTotal}件）
                            </StatusBadge>
                        )}
                    </div>
                )}
            </Section>

            <Section title="メンテナンス・ログイン">
                {!maintenance && !sessions ? (
                    <p className="text-xs text-muted-foreground">未取得です。</p>
                ) : (
                    <div className="flex flex-wrap gap-2">
                        {maintenance?.rebootRequired && <StatusBadge tone="danger">再起動待ち</StatusBadge>}
                        {maintenance?.updatesAvailable !== undefined && maintenance.updatesAvailable > 0 && (
                            <StatusBadge tone={maintenance.securityUpdatesAvailable ? "danger" : "warn"}>
                                更新 {maintenance.updatesAvailable}件
                                {maintenance.securityUpdatesAvailable
                                    ? `（セキュリティ ${maintenance.securityUpdatesAvailable}件）`
                                    : ""}
                            </StatusBadge>
                        )}
                        {maintenance && !maintenance.rebootRequired && !maintenance.updatesAvailable && (
                            <StatusBadge tone="ok">更新なし</StatusBadge>
                        )}
                        {sessions && (
                            <StatusBadge tone="neutral">
                                ログイン {sessions.count}
                                {sessions.users.length > 0 && `（${sessions.users.join(", ")}）`}
                            </StatusBadge>
                        )}
                    </div>
                )}
            </Section>
        </>
    )
}

/** カードから開いた詳細の中身。取得済みの値だけを出し、無いものは「未取得」「対象なし」と書く */
export function HostDetailBody({
    kind,
    host,
    historyHours,
}: {
    kind: HostDetailKind
    host: HostStatsHostView
    historyHours: number
}) {
    const { latest, history } = host
    const hours = historyHours
    const suffix = `直近${hours}時間の推移`
    // 履歴に残しているのは最も使用率が高いディスク1件。カードもそれに合わせる
    const worstDisk = latest.disks.reduce((worst, disk) => (disk.usedPercent > worst.usedPercent ? disk : worst))
    const otherDisks = latest.disks.filter((disk) => disk.path !== worstDisk.path)

    let body: React.ReactNode = null

    if (kind === "cpu") {
        body = (
            <>
                <BigValue
                    value={`${latest.cpuPercent}%`}
                    className={getUsageColor(latest.cpuPercent)}
                    caption={describeCpu(latest.cpuModel, latest.cpuThreads)}
                />
                <History
                    values={pickSeries(history, "cpu")}
                    className={getUsageColor(latest.cpuPercent)}
                    label={`CPU使用率の${suffix}`}
                    hours={hours}
                />
                <ProcessList
                    title="CPU上位プロセス"
                    processes={latest.topProcesses}
                    format={(process) => `${process.cpuPercent}%`}
                />
                <Section title="アプリ別CPU">
                    {/* エージェントはアプリ別のCPUを送っていない。0%と書かず、取得していないと示す */}
                    <p className="text-xs text-muted-foreground">
                        取得していません（アプリ別に集計しているのはメモリとディスクのみです）。
                    </p>
                </Section>
            </>
        )
    } else if (kind === "memory") {
        body = (
            <>
                <BigValue
                    value={`${latest.memory.usedPercent}%`}
                    className={getUsageColor(latest.memory.usedPercent)}
                    caption={`${formatBytes(latest.memory.usedBytes)} / ${formatBytes(latest.memory.totalBytes)}`}
                />
                <History
                    values={pickSeries(history, "mem")}
                    className={getUsageColor(latest.memory.usedPercent)}
                    label={`メモリ使用率の${suffix}`}
                    hours={hours}
                />
                <AppMemoryBreakdown apps={latest.apps} memory={latest.memory} />
                <ProcessList
                    title="メモリ上位プロセス"
                    processes={latest.topMemoryProcesses}
                    format={(process) =>
                        process.memoryBytes === undefined ? "—" : formatBytes(process.memoryBytes)
                    }
                />
            </>
        )
    } else if (kind === "swap" && latest.swap) {
        body = (
            <>
                <BigValue
                    value={`${latest.swap.usedPercent}%`}
                    className={getUsageColor(latest.swap.usedPercent)}
                    caption={`${formatBytes(latest.swap.usedBytes)} / ${formatBytes(latest.swap.totalBytes)}`}
                />
                <History
                    values={pickSeries(history, "swap")}
                    className={getUsageColor(latest.swap.usedPercent)}
                    label={`Swap使用率の${suffix}`}
                    hours={hours}
                />
            </>
        )
    } else if (kind === "disk") {
        body = (
            <>
                <BigValue
                    value={`${worstDisk.usedPercent}%`}
                    className={getUsageColor(worstDisk.usedPercent)}
                    caption={`${formatBytes(worstDisk.usedBytes)} / ${formatBytes(worstDisk.totalBytes)}（${worstDisk.path}）`}
                />
                <History
                    values={pickSeries(history, "disk")}
                    className={getUsageColor(worstDisk.usedPercent)}
                    label={`ディスク使用率の${suffix}`}
                    hours={hours}
                />
                <AppDiskBreakdown apps={latest.apps} />
                <Section title="その他のディスク">
                    {otherDisks.length === 0 ? (
                        <p className="text-xs text-muted-foreground">他のディスクはありません。</p>
                    ) : (
                        <Facts
                            rows={otherDisks.map((disk) => ({
                                label: disk.path,
                                value: `${disk.usedPercent}% · ${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`,
                            }))}
                        />
                    )}
                </Section>
            </>
        )
    } else if (kind === "load") {
        const loads = pickSeries(history, "load")
        body = (
            <>
                <BigValue value={latest.loadAverage[0].toFixed(2)} caption="直近1分" />
                <Facts
                    rows={[
                        { label: "1分", value: latest.loadAverage[0].toFixed(2) },
                        { label: "5分", value: latest.loadAverage[1]?.toFixed(2) ?? "—" },
                        { label: "15分", value: latest.loadAverage[2]?.toFixed(2) ?? "—" },
                    ]}
                />
                <History
                    values={loads}
                    max={Math.max(...loads, 1)}
                    className={NEUTRAL_METRIC_COLORS.load}
                    label={`Load Averageの${suffix}`}
                    hours={hours}
                />
            </>
        )
    } else if (kind === "network" && latest.network) {
        const series = sumSeries(pickSeries(history, "rx"), pickSeries(history, "tx"))
        body = (
            <>
                <Facts
                    rows={[
                        { label: "受信（↓）", value: formatRate(latest.network.inBytesPerSecond) },
                        { label: "送信（↑）", value: formatRate(latest.network.outBytesPerSecond) },
                    ]}
                />
                <History
                    values={series}
                    max={Math.max(...series, 1)}
                    className={NEUTRAL_METRIC_COLORS.network}
                    label={`ネットワーク転送量の${suffix}`}
                    hours={hours}
                />
            </>
        )
    } else if (kind === "diskIo" && latest.diskIo) {
        const series = sumSeries(pickSeries(history, "ior"), pickSeries(history, "iow"))
        body = (
            <>
                <Facts
                    rows={[
                        { label: "読み込み（R）", value: formatRate(latest.diskIo.inBytesPerSecond) },
                        { label: "書き込み（W）", value: formatRate(latest.diskIo.outBytesPerSecond) },
                    ]}
                />
                <History
                    values={series}
                    max={Math.max(...series, 1)}
                    className={NEUTRAL_METRIC_COLORS.diskIo}
                    label={`ディスクI/Oの${suffix}`}
                    hours={hours}
                />
            </>
        )
    } else if (kind === "uptime") {
        body = (
            <>
                <BigValue value={formatUptime(latest.uptimeSeconds)} caption="稼働時間" />
                <Facts
                    rows={[
                        { label: "OS", value: latest.os ?? "未取得" },
                        { label: "カーネル", value: latest.kernel ?? "未取得" },
                        { label: "ホスト名", value: latest.hostname },
                    ]}
                />
            </>
        )
    } else if (kind === "temp" && latest.temperatureCelsius !== undefined) {
        const temperatures = pickSeries(history, "temp")
        const min = temperatures.length > 0 ? Math.min(...temperatures) : 0
        const max = temperatures.length > 0 ? Math.max(...temperatures) : 0
        body = (
            <>
                <BigValue
                    value={`${latest.temperatureCelsius}°C`}
                    className={getTemperatureColor(latest.temperatureCelsius)}
                />
                <History
                    values={temperatures}
                    min={min}
                    max={min + Math.max(MIN_TEMPERATURE_SPAN, max - min)}
                    className={getTemperatureColor(latest.temperatureCelsius)}
                    label={`CPU温度の${suffix}`}
                    hours={hours}
                />
            </>
        )
    } else if (kind === "systems") {
        body = <SystemsPanel host={host} />
    } else {
        body = <p className="text-xs text-muted-foreground">この指標は取得していません。</p>
    }

    return (
        <>
            <StaleNotice host={host} />
            {body}
        </>
    )
}
