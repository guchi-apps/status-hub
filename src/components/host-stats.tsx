"use client"

import { useCallback, useState } from "react"
import { useDashboardData } from "@/components/dashboard-data"
import { HostDetailDialog } from "@/components/host-detail-dialog"
import {
    HOST_DETAIL_TITLES,
    HostDetailBody,
    summarizeSystems,
    type HostDetailKind,
} from "@/components/host-detail-panels"
import {
    MetricCard,
    NEUTRAL_METRIC_COLORS,
    getTemperatureColor,
    getUsageColor,
} from "@/components/metric-card"
import { SkeletonBar, SkeletonGroup } from "@/components/skeleton"
import { SectionHeading } from "@/components/section-heading"
import { Sparkline } from "@/components/sparkline"
import { describeCpu, formatAge, formatBytes, formatUptime } from "@/lib/host-stats/format"
import { pickSeries as pick, sumSeries } from "@/lib/host-stats/history"
import { cn } from "@/lib/utils"
import type { HostStatsHostView } from "@/types/host-stats"

/** 温度グラフの縦軸の最小の幅（℃）。変動が小さいときに波形が暴れて見えないようにする */
const MIN_TEMPERATURE_SPAN = 10

function formatRate(bytesPerSecond: number): string {
    return `${formatBytes(bytesPerSecond)}/s`
}

function OfflineBanner({
    ageSeconds,
    offlineAfterSeconds,
}: {
    ageSeconds: number
    offlineAfterSeconds: number
}) {
    return (
        <div
            className="rounded-lg border border-dashed border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-100"
            role="status"
        >
            <p className="font-semibold">オフラインの可能性があります</p>
            <p className="mt-1 text-red-200/80">
                最終受信が{formatAge(ageSeconds)}で、しきい値（{Math.round(offlineAfterSeconds / 60)}分）を超えています。
                表示しているのはその時点の値です。
            </p>
        </div>
    )
}

function HostSection({
    host,
    offlineAfterSeconds,
    historyHours,
}: {
    host: HostStatsHostView
    offlineAfterSeconds: number
    historyHours: number
}) {
    // 開いている詳細。早期 return より前に置く（フックの呼び出し順を変えないため）
    const [open, setOpen] = useState<{ kind: HostDetailKind; trigger: HTMLElement } | null>(null)
    const closeDetail = useCallback(() => setOpen(null), [])

    const { latest, history, online } = host

    // 保存済みファイルが古い形式・壊れている場合に、画面全体を巻き込んで落とさないための保険
    if (!latest.disks?.length || !latest.loadAverage) return null

    const dimmed = !online
    const chartClass = "h-6 w-full"
    const historyLabelSuffix = `直近${historyHours}時間の推移`

    // 履歴に残しているのは最も使用率が高いディスク1件。カードもそれに合わせる
    const worstDisk = latest.disks.reduce((worst, disk) =>
        disk.usedPercent > worst.usedPercent ? disk : worst
    )

    const loads = pick(history, "load")
    const temperatures = pick(history, "temp")
    const temperatureMin = temperatures.length > 0 ? Math.min(...temperatures) : 0
    const temperatureMax = temperatures.length > 0 ? Math.max(...temperatures) : 0
    const temperatureSpan = Math.max(MIN_TEMPERATURE_SPAN, temperatureMax - temperatureMin)

    const networkSeries = sumSeries(pick(history, "rx"), pick(history, "tx"))
    const diskIoSeries = sumSeries(pick(history, "ior"), pick(history, "iow"))

    // オフラインの最後のスナップショットは予定時刻を過ぎているのが当たり前なので、異常として数えない
    const systems = summarizeSystems(host)
    const problems = online ? systems.problems : 0
    const systemsTone: "danger" | "warn" | undefined =
        problems > 0 ? "danger" : online && systems.notices > 0 ? "warn" : undefined
    const systemsValue = !online
        ? "最終値"
        : problems > 0
          ? `異常 ${problems}`
          : systems.notices > 0
            ? `要確認 ${systems.notices}`
            : systems.servicesReported || systems.timers > 0
              ? "正常"
              : "未取得"
    const systemsDetail = [
        systems.servicesReported ? `サービス ${systems.services}` : null,
        systems.timers > 0 ? `定期ジョブ ${systems.timers}` : null,
        systems.tmux > 0 ? `tmux ${systems.tmux}` : null,
    ]
        .filter((part): part is string => part !== null)
        .join(" / ")

    const openCard = (kind: HostDetailKind) => (trigger: HTMLElement) => setOpen({ kind, trigger })
    const labelFor = (kind: HostDetailKind) => `${host.label} の ${HOST_DETAIL_TITLES[kind]} の詳細を開く`

    return (
        <section className="space-y-3 sm:space-y-4">
            <SectionHeading
                title={`${host.label} Status`}
                trailing={
                    <>
                        {!online && (
                            <span className="text-xs font-mono font-semibold px-2 py-1 rounded-md bg-red-500/20 text-red-300 border border-red-500/30">
                                OFFLINE
                            </span>
                        )}
                        {problems > 0 && (
                            <span className="text-xs font-mono font-semibold px-2 py-1 rounded-md bg-red-500/20 text-red-300 border border-red-500/30">
                                異常 {problems}
                            </span>
                        )}
                        <span className="text-xs font-mono text-muted-foreground truncate">
                            {latest.hostname}
                        </span>
                        <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                            受信 {formatAge(host.ageSeconds)}
                        </span>
                    </>
                }
            />

            {!online && (
                <OfflineBanner ageSeconds={host.ageSeconds} offlineAfterSeconds={offlineAfterSeconds} />
            )}

            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
                <MetricCard
                    label="CPU"
                    value={`${latest.cpuPercent}%`}
                    detail={describeCpu(latest.cpuModel, latest.cpuThreads)}
                    valueClassName={getUsageColor(latest.cpuPercent)}
                    dimmed={dimmed}
                    onOpen={openCard("cpu")}
                    openLabel={labelFor("cpu")}
                    chart={
                        <Sparkline
                            values={pick(history, "cpu")}
                            className={cn(chartClass, getUsageColor(latest.cpuPercent))}
                            label={`CPU使用率の${historyLabelSuffix}`}
                        />
                    }
                />
                <MetricCard
                    label="Memory"
                    value={`${latest.memory.usedPercent}%`}
                    detail={`${formatBytes(latest.memory.usedBytes)} / ${formatBytes(latest.memory.totalBytes)}`}
                    valueClassName={getUsageColor(latest.memory.usedPercent)}
                    dimmed={dimmed}
                    onOpen={openCard("memory")}
                    openLabel={labelFor("memory")}
                    chart={
                        <Sparkline
                            values={pick(history, "mem")}
                            className={cn(chartClass, getUsageColor(latest.memory.usedPercent))}
                            label={`メモリ使用率の${historyLabelSuffix}`}
                        />
                    }
                />
                {latest.swap && latest.swap.totalBytes > 0 && (
                    <MetricCard
                        label="Swap"
                        value={`${latest.swap.usedPercent}%`}
                        detail={`${formatBytes(latest.swap.usedBytes)} / ${formatBytes(latest.swap.totalBytes)}`}
                        valueClassName={getUsageColor(latest.swap.usedPercent)}
                        dimmed={dimmed}
                        onOpen={openCard("swap")}
                        openLabel={labelFor("swap")}
                        chart={
                            <Sparkline
                                values={pick(history, "swap")}
                                className={cn(chartClass, getUsageColor(latest.swap.usedPercent))}
                                label={`Swap使用率の${historyLabelSuffix}`}
                            />
                        }
                    />
                )}
                <MetricCard
                    label="Disk"
                    value={`${worstDisk.usedPercent}%`}
                    detail={`${formatBytes(worstDisk.usedBytes)} / ${formatBytes(worstDisk.totalBytes)}（${worstDisk.path}）`}
                    valueClassName={getUsageColor(worstDisk.usedPercent)}
                    dimmed={dimmed}
                    onOpen={openCard("disk")}
                    openLabel={labelFor("disk")}
                    chart={
                        <Sparkline
                            values={pick(history, "disk")}
                            className={cn(chartClass, getUsageColor(worstDisk.usedPercent))}
                            label={`ディスク使用率の${historyLabelSuffix}`}
                        />
                    }
                />
                <MetricCard
                    label="Load Avg"
                    value={latest.loadAverage[0].toFixed(2)}
                    detail={`1m / 5m / 15m: ${latest.loadAverage.map((value) => value.toFixed(2)).join(" / ")}`}
                    dimmed={dimmed}
                    onOpen={openCard("load")}
                    openLabel={labelFor("load")}
                    chart={
                        <Sparkline
                            values={loads}
                            max={Math.max(...loads, 1)}
                            className={cn(chartClass, NEUTRAL_METRIC_COLORS.load)}
                            label={`Load Averageの${historyLabelSuffix}`}
                        />
                    }
                />
                {latest.network && (
                    <MetricCard
                        label="Network"
                        value={`↓ ${formatRate(latest.network.inBytesPerSecond)}`}
                        detail={`↑ ${formatRate(latest.network.outBytesPerSecond)}`}
                        dimmed={dimmed}
                        onOpen={openCard("network")}
                        openLabel={labelFor("network")}
                        chart={
                            <Sparkline
                                values={networkSeries}
                                max={Math.max(...networkSeries, 1)}
                                className={cn(chartClass, NEUTRAL_METRIC_COLORS.network)}
                                label={`ネットワーク転送量の${historyLabelSuffix}`}
                            />
                        }
                    />
                )}
                {latest.diskIo && (
                    <MetricCard
                        label="Disk I/O"
                        value={`R ${formatRate(latest.diskIo.inBytesPerSecond)}`}
                        detail={`W ${formatRate(latest.diskIo.outBytesPerSecond)}`}
                        dimmed={dimmed}
                        onOpen={openCard("diskIo")}
                        openLabel={labelFor("diskIo")}
                        chart={
                            <Sparkline
                                values={diskIoSeries}
                                max={Math.max(...diskIoSeries, 1)}
                                className={cn(chartClass, NEUTRAL_METRIC_COLORS.diskIo)}
                                label={`ディスクI/Oの${historyLabelSuffix}`}
                            />
                        }
                    />
                )}
                <MetricCard
                    label="Uptime"
                    value={formatUptime(latest.uptimeSeconds)}
                    detail={latest.os ?? latest.kernel}
                    dimmed={dimmed}
                    onOpen={openCard("uptime")}
                    openLabel={labelFor("uptime")}
                />
                {latest.temperatureCelsius !== undefined && (
                    <MetricCard
                        label="Temp"
                        value={`${latest.temperatureCelsius}°C`}
                        valueClassName={getTemperatureColor(latest.temperatureCelsius)}
                        dimmed={dimmed}
                        onOpen={openCard("temp")}
                        openLabel={labelFor("temp")}
                        chart={
                            <Sparkline
                                values={temperatures}
                                min={temperatureMin}
                                max={temperatureMin + temperatureSpan}
                                className={cn(chartClass, getTemperatureColor(latest.temperatureCelsius))}
                                label={`CPU温度の${historyLabelSuffix}`}
                            />
                        }
                    />
                )}
                <MetricCard
                    label="稼働システム"
                    value={systemsValue}
                    valueClassName={
                        systemsTone === "danger"
                            ? "text-red-400"
                            : systemsTone === "warn"
                              ? "text-amber-400"
                              : online && systemsValue === "正常"
                                ? "text-status-ok"
                                : undefined
                    }
                    detail={systemsDetail || undefined}
                    alert={systemsTone}
                    dimmed={dimmed}
                    onOpen={openCard("systems")}
                    openLabel={labelFor("systems")}
                />
            </div>

            {open && (
                <HostDetailDialog
                    title={`${host.label} · ${HOST_DETAIL_TITLES[open.kind]}`}
                    subtitle={`最終受信 ${formatAge(host.ageSeconds)}${online ? "" : "（古い値）"}`}
                    returnFocusTo={open.trigger}
                    onClose={closeDetail}
                >
                    <HostDetailBody kind={open.kind} host={host} historyHours={historyHours} />
                </HostDetailDialog>
            )}
        </section>
    )
}

export function HostStats() {
    const { hostStats: view } = useDashboardData()

    // 取得前は骨組みを出す。取得できて0台（エージェント未設置）ならセクションごと出さない
    if (!view) {
        return (
            <section className="space-y-3">
                <SectionHeading title="ホスト" />
                <SkeletonGroup label="ホストのメトリクス" className="grid gap-3 sm:grid-cols-3">
                    <SkeletonBar />
                    <SkeletonBar />
                    <SkeletonBar />
                </SkeletonGroup>
            </section>
        )
    }
    if (!view.hosts.length) return null

    return (
        <>
            {view.hosts.map((host) => (
                <HostSection
                    key={host.id}
                    host={host}
                    offlineAfterSeconds={view.offlineAfterSeconds}
                    historyHours={view.historyHours}
                />
            ))}
        </>
    )
}
