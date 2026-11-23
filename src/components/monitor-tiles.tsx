"use client"

import { StatusDot, TEXT_TONES, type StatusTone } from "@/components/status-badge"
import type { MonitorFeed } from "@/lib/monitor-feed"
import type { UptimeRobotMonitor } from "@/lib/uptimerobot"
import type { UptimeKumaMonitor, UptimeKumaStatus } from "@/lib/uptime-kuma"
import { cn } from "@/lib/utils"

/** 概要タブのタイル1枚分。取得元が違っても同じ見た目に揃えて並べる */
interface MonitorTile {
    key: string
    name: string
    tone: StatusTone
    /** 右下に出す補足（応答時間・稼働率など） */
    detail: string
    source: string
    heartbeats?: UptimeKumaStatus[]
    url?: string
}

const KUMA_TONES: Record<UptimeKumaStatus, StatusTone> = {
    up: "ok",
    down: "danger",
    pending: "warn",
    maintenance: "neutral",
}

const HEARTBEAT_COLORS: Record<UptimeKumaStatus, string> = {
    up: "bg-status-ok",
    down: "bg-red-500",
    pending: "bg-orange-500",
    maintenance: "bg-primary",
}

/** 概要タブでは幅が狭いため、直近の分だけ出す */
const OVERVIEW_HEARTBEAT_COUNT = 12

/** 取得に失敗した系統。モニターが0件のときと見分けて知らせるために切り出す（#276） */
function getFailures(
    kuma: MonitorFeed<UptimeKumaMonitor>,
    robot: MonitorFeed<UptimeRobotMonitor>
): { source: string; error: string }[] {
    return [
        kuma.error !== null ? { source: "Uptime Kuma", error: kuma.error } : null,
        robot.error !== null ? { source: "UptimeRobot", error: robot.error } : null,
    ].filter((failure): failure is { source: string; error: string } => failure !== null)
}

function toTiles(
    kuma: MonitorFeed<UptimeKumaMonitor>,
    robot: MonitorFeed<UptimeRobotMonitor>
): MonitorTile[] {
    const kumaTiles = kuma.monitors.map<MonitorTile>((monitor) => ({
        key: `kuma-${monitor.id}`,
        name: monitor.name,
        tone: KUMA_TONES[monitor.status],
        detail: monitor.currentPing !== null ? `${monitor.currentPing}ms` : "-",
        source: "Kuma",
        heartbeats: monitor.recentStatuses.slice(-OVERVIEW_HEARTBEAT_COUNT),
        url: monitor.url,
    }))

    const robotTiles = robot.monitors.map<MonitorTile>((monitor) => {
        const ratio = (monitor.custom_uptime_ratio || monitor.uptime_ratio || "0").split("-")[0]
        return {
            key: `robot-${monitor.id}`,
            name: monitor.friendly_name,
            // 2=稼働、8=応答なし、9=停止、0=一時停止、1=未確認
            tone: monitor.status === 2 ? "ok" : monitor.status >= 8 ? "danger" : "neutral",
            detail: `${parseFloat(ratio)}%`,
            source: "Robot",
            url: monitor.url,
        }
    })

    return [...kumaTiles, ...robotTiles]
}

export function MonitorTiles({
    kuma,
    robot,
}: {
    kuma: MonitorFeed<UptimeKumaMonitor>
    robot: MonitorFeed<UptimeRobotMonitor>
}) {
    const tiles = toTiles(kuma, robot)
    const failures = getFailures(kuma, robot)

    // 失敗した系統は一覧が空で返ってくるため、タイルだけを見ると「その分の監視が無い」ように見える。
    // 取得できた側のタイルは出したまま、失敗した系統を先頭に添える
    const failureNotice = failures.length > 0 && (
        <ul role="alert" className="space-y-0.5">
            {failures.map((failure) => (
                <li key={failure.source} className={cn("text-xs", TEXT_TONES.danger)}>
                    {failure.source} を取得できません（{failure.error}）
                </li>
            ))}
        </ul>
    )

    if (tiles.length === 0) {
        return failureNotice || <p className="text-xs text-muted-foreground">監視の設定がありません</p>
    }

    return (
        <div className="space-y-2">
            {failureNotice}
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-2 xl:grid-cols-5 2xl:grid-cols-6">
                {tiles.map((tile) => (
                    <a
                        key={tile.key}
                        href={tile.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                            "flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-muted/30 px-2 py-1.5",
                            "transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            tile.tone === "danger" && "border-red-500/40 bg-red-500/10"
                        )}
                        aria-label={`${tile.name}（${tile.source}）`}
                    >
                        <span className="flex min-w-0 items-center gap-1.5">
                            <StatusDot tone={tile.tone} />
                            <span
                                className={cn(
                                    "min-w-0 truncate text-[10px]",
                                    tile.tone === "danger" && TEXT_TONES.danger
                                )}
                                title={tile.name}
                            >
                                {tile.name}
                            </span>
                        </span>
    
                        {tile.heartbeats && tile.heartbeats.length > 0 && (
                            <span className="flex h-3 items-stretch gap-px" aria-hidden>
                                {tile.heartbeats.map((status, index) => (
                                    <span
                                        key={index}
                                        className={cn("min-w-px flex-1 rounded-[1px]", HEARTBEAT_COLORS[status])}
                                    />
                                ))}
                            </span>
                        )}
    
                        <span className="flex items-center justify-between gap-1 font-mono text-[9px] text-muted-foreground">
                            <span>{tile.source}</span>
                            <span>{tile.detail}</span>
                        </span>
                    </a>
                ))}
            </div>
        </div>
    )
}

/**
 * 概要タブの見出しに添える「8 / 9 Up」。停止があれば赤で出す。
 * 取得に失敗した系統があれば `failed` を立てる（見出しに「取得不可」を出すため）
 */
export function getMonitorStatusText(
    kuma: MonitorFeed<UptimeKumaMonitor>,
    robot: MonitorFeed<UptimeRobotMonitor>
): { text: string | null; down: number; failed: boolean } {
    const tiles = toTiles(kuma, robot)
    const down = tiles.filter((tile) => tile.tone === "danger").length
    const failed = getFailures(kuma, robot).length > 0

    return {
        // 全系統が失敗して0件のときに「0 / 0 Up」と出すと、何も問題が無いように読めてしまう。
        // 見出しには「取得不可」のバッジが出るので、件数は出さない
        text: tiles.length === 0 && failed ? null : `${tiles.length - down} / ${tiles.length} Up`,
        down,
        failed,
    }
}
