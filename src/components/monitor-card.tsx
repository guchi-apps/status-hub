"use client"

import { Link as LinkIcon } from "lucide-react"
import { MonitorNameEditor } from "@/components/monitor-name-editor"
import { DashboardCard } from "@/components/dashboard-card"
import type { MonitorSource } from "@/lib/monitor-source"
import { cn } from "@/lib/utils"

function BoldLinkLabel({ label, className }: { label: string; className?: string }) {
    return (
        <div className={cn("flex items-center gap-1.5 min-w-0 max-w-full", className)}>
            <span className="font-bold truncate">{label}</span>
            <LinkIcon className="h-4 w-4 shrink-0" aria-hidden />
        </div>
    )
}

function MonitorCardLink({
    href,
    label,
    children,
}: {
    href?: string
    label: string
    children: React.ReactNode
}) {
    if (!href) return <>{children}</>

    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${label}（外部リンク）`}
            className="block h-full w-full rounded-xl transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            {children}
        </a>
    )
}

export function MonitorCard({
    label,
    statusText,
    statusColor,
    uptimeLabel,
    href,
    edit,
}: {
    label: string
    statusText: string
    statusColor: string
    uptimeLabel?: string
    href?: string
    /** 表示名を変えられるカードのとき、保存先の系統とID（#479） */
    edit?: { source: MonitorSource; id: number; originalName?: string }
}) {
    return (
        <MonitorCardLink href={href} label={label}>
            <DashboardCard
                className={cn(
                    "h-full flex flex-col justify-center items-center text-center gap-1 px-3 py-4 sm:p-6",
                    href && "cursor-pointer"
                )}
            >
                {edit && (
                    <MonitorNameEditor
                        source={edit.source}
                        id={edit.id}
                        name={label}
                        originalName={edit.originalName}
                        className="absolute right-2 top-2"
                    />
                )}
                {href ? (
                    <BoldLinkLabel label={label} className="text-xs sm:text-sm" />
                ) : (
                    <span
                        className="text-[10px] sm:text-xs opacity-70 uppercase tracking-widest truncate w-full"
                        title={label}
                    >
                        {label}
                    </span>
                )}
                <div className={`text-xl sm:text-2xl font-bold font-mono ${statusColor}`}>{statusText}</div>
                {uptimeLabel && (
                    <div className="text-xs sm:text-sm font-medium text-muted-foreground">
                        {uptimeLabel}
                    </div>
                )}
            </DashboardCard>
        </MonitorCardLink>
    )
}

export function MonitorCardGrid({ children, count }: { children: React.ReactNode; count: number }) {
    const gridCols =
        count === 1
            ? "grid-cols-1"
            : count === 2
              ? "grid-cols-2"
              : count === 3
                ? "grid-cols-2 md:grid-cols-3"
                : "grid-cols-2 lg:grid-cols-4"

    return <div className={`grid ${gridCols} gap-3 sm:gap-4 h-full`}>{children}</div>
}
