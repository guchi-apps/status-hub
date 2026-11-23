"use client"

import { StatusBadge, StatusDot, type StatusTone } from "@/components/status-badge"
import { UsageRing } from "@/components/usage-ring"
import { formatAge, formatUptime } from "@/lib/host-stats/format"
import { describeTimer, evaluateTimers, type TimerState, type TimerStatus } from "@/lib/host-stats/timers"
import { shouldJumpOnClick } from "@/lib/section-anchors"
import { cn } from "@/lib/utils"
import type { HostSensorState, HostSensorsView, HostStatsHostView } from "@/types/host-stats"

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

/**
 * 定期ジョブ（systemd timer）の一覧。
 *
 * サービスのバッジと違い、oneshot のジョブは「いま動いているか」ではなく
 * 「前回いつ動いて、どう終わったか」が知りたい情報なので、1行1ユニットで並べる。
 * 異常なものは狭い画面でも隠さない（見に行かないと分からない異常を減らすのが目的のため）。
 */
function TimerList({ statuses }: { statuses: TimerStatus[] }) {
    if (statuses.length === 0) return null

    const abnormal = statuses.filter((status) => status.abnormal)
    if (abnormal.length === 0) return null

    return (
        <div className="mt-2 flex flex-col gap-1">
            <div className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground">定期ジョブ</div>
            {abnormal.map((status) => {
                const detail = describeTimer(status)

                return (
                    <div
                        key={status.timer.name}
                        className="flex min-w-0 items-center gap-1.5 text-[10px]"
                    >
                        <StatusDot tone={TIMER_TONES[status.state]} />
                        <span className="shrink-0 font-mono">{status.timer.name}</span>
                        <span className="truncate text-muted-foreground" title={detail}>
                            {detail}
                        </span>
                    </div>
                )
            })}
        </div>
    )
}

/** センサーの状態と色の対応。unknown は「止まっている」ではないので警告どまりにする */
export const SENSOR_TONES: Record<HostSensorState, StatusTone> = {
    ok: "ok",
    retrying: "warn",
    stale: "danger",
    unknown: "warn",
}

/**
 * センサーの取得状況（#581）。ホストが動いていても、センサーだけ取れていないことがあるため別に出す。
 * 定期ジョブと同じく、異常なものは狭い画面でも隠さない。
 */
function SensorList({ sensors }: { sensors: HostSensorsView | undefined }) {
    if (!sensors) return null

    const abnormalItems = sensors.items.filter((sensor) => sensor.abnormal)
    if (sensors.available && abnormalItems.length === 0) return null

    return (
        <div className="mt-2 flex flex-col gap-1">
            <div className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground">センサー</div>
            {!sensors.available && (
                <div className="flex min-w-0 items-center gap-1.5 text-[10px]">
                    <StatusDot tone="warn" />
                    <span className="truncate text-muted-foreground">取得状況を読めません（取得側が未記録）</span>
                </div>
            )}
            {abnormalItems.map((sensor) => (
                <div key={sensor.name} className="flex min-w-0 items-center gap-1.5 text-[10px]">
                    <StatusDot tone={SENSOR_TONES[sensor.state]} />
                    <span className="shrink-0">{sensor.name}</span>
                    <span className="truncate text-muted-foreground" title={sensor.label}>
                        {sensor.label}
                    </span>
                </div>
            ))}
        </div>
    )
}

/**
 * 概要タブに出す、1ホスト＝1枚のカード。
 *
 * CPU・Memory・Disk・Swapを円グラフで横4列に並べるだけにし、画面幅によらず同じ表示にする（#683）。
 * 推移・ロード・転送量などの細かい値は、ホストタブの役目。
 * 異常（停止サービス・異常な定期ジョブ/センサー）だけは概要でも隠さない。
 */
export function HostCard({
    host,
    onOpen,
}: {
    host: HostStatsHostView
    /** ホストタブの該当ホストへ移動する（#682）。カード全体と見出し右のボタンから呼ぶ */
    onOpen?: () => void
}) {
    const { latest, online } = host

    // 保存済みファイルが古い形式・壊れている場合に、画面全体を巻き込んで落とさないための保険
    if (!latest.disks?.length || !latest.loadAverage) return null

    const worstDisk = latest.disks.reduce((worst, disk) =>
        disk.usedPercent > worst.usedPercent ? disk : worst
    )
    const hasSwap = latest.swap !== undefined && latest.swap.totalBytes > 0
    const stoppedServices = (latest.services ?? []).filter((service) => !service.active)
    const timerStatuses = evaluateTimers(latest.timers)

    return (
        <div
            className={cn(
                "h-full rounded-xl border border-border bg-card p-3",
                !online && "opacity-70",
                onOpen && "cursor-pointer transition-colors hover:border-highlight/50"
            )}
            onClick={
                onOpen
                    ? (event) => {
                          if (shouldJumpOnClick(event.target as Element, !!window.getSelection()?.toString())) {
                              onOpen()
                          }
                      }
                    : undefined
            }
        >
            <div className="mb-2 flex flex-nowrap items-center gap-x-2">
                <StatusDot tone={online ? "ok" : "danger"} />
                <span className="shrink-0 whitespace-nowrap text-sm font-bold">{host.label}</span>
                <span
                    className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground"
                    title={latest.hostname}
                >
                    {latest.hostname}
                </span>
                {!online && (
                    <span className="shrink-0 whitespace-nowrap rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-red-400">
                        応答なし
                    </span>
                )}
                <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                    稼働 {formatUptime(latest.uptimeSeconds)} · 受信 {formatAge(host.ageSeconds)}
                </span>
            </div>

            <div className="grid grid-cols-4 gap-2">
                <UsageRing label="CPU" percent={latest.cpuPercent} />
                <UsageRing label="Memory" percent={latest.memory.usedPercent} />
                <UsageRing label="Disk" percent={worstDisk.usedPercent} />
                <UsageRing
                    label="Swap"
                    percent={hasSwap ? latest.swap!.usedPercent : null}
                    caption={hasSwap ? undefined : "なし"}
                />
            </div>

            {stoppedServices.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                    {stoppedServices.map((service) => (
                        <StatusBadge key={service.name} tone="danger" withDot>
                            {service.name}
                        </StatusBadge>
                    ))}
                </div>
            )}

            <TimerList statuses={timerStatuses} />
            <SensorList sensors={host.sensors} />
        </div>
    )
}
