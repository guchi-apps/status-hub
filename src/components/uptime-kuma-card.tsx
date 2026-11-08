"use client"

import { Link as LinkIcon } from "lucide-react"
import { DashboardCard } from "@/components/dashboard-card"
import { MonitorNameEditor } from "@/components/monitor-name-editor"
import { cn } from "@/lib/utils"
import type { UptimeKumaMonitor, UptimeKumaStatus } from "@/lib/uptime-kuma"

const STATUS_STYLES: Record<UptimeKumaStatus, { label: string; className: string }> = {
    up: { label: "Up", className: "bg-status-ok" },
    down: { label: "Down", className: "bg-red-600" },
    pending: { label: "Pending", className: "bg-orange-500" },
    maintenance: { label: "Maintenance", className: "bg-primary" },
}

function StatusBadge({ status }: { status: UptimeKumaStatus }) {
    const style = STATUS_STYLES[status]
    return (
        <span
            className={cn(
                "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] sm:px-3 sm:py-1 sm:text-xs font-semibold text-white",
                style.className
            )}
        >
            {style.label}
        </span>
    )
}

function HeartbeatBar({ statuses }: { statuses: UptimeKumaStatus[] }) {
    return (
        <div className="flex w-full items-end gap-0.5">
            {statuses.map((status, index) => (
                <span
                    key={index}
                    className={cn(
                        "h-5 sm:h-6 min-w-px flex-1 max-w-[6px] rounded-sm",
                        STATUS_STYLES[status].className
                    )}
                />
            ))}
        </div>
    )
}

function MonitorUrl({ url }: { url?: string }) {
    if (!url) return null

    return (
        <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:underline"
        >
            <LinkIcon className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{url}</span>
        </a>
    )
}

export function UptimeKumaDashboardCard({ monitor }: { monitor: UptimeKumaMonitor }) {
    return (
        <DashboardCard className="h-full flex flex-col gap-2 px-3 py-3 sm:gap-3 sm:px-4 sm:py-4">
            <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-xs sm:text-sm font-bold" title={monitor.name}>
                    {monitor.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={monitor.status} />
                    <MonitorNameEditor
                        source="kuma"
                        id={monitor.id}
                        name={monitor.name}
                        originalName={monitor.originalName}
                    />
                </span>
            </div>
            <MonitorUrl url={monitor.url} />
            <HeartbeatBar statuses={monitor.recentStatuses} />
            <div className="flex items-center justify-between text-[11px] sm:text-xs text-muted-foreground">
                <span>現在: {monitor.currentPing !== null ? `${monitor.currentPing}ms` : "-"}</span>
                <span>平均: {monitor.avgPing !== null ? `${monitor.avgPing}ms` : "-"}</span>
            </div>
        </DashboardCard>
    )
}
