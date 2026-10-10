"use client"

import { useState } from "react"
import { formatAge, formatBytes } from "@/lib/host-stats/format"
import { cn } from "@/lib/utils"
import type { HostStatsApps, HostStatsUsage } from "@/types/host-stats"

/** 狭い画面で最初に出す件数。残りは「他 N件を表示」で開く */
const COLLAPSED_ROWS = 6

/** 「アプリ以外」の分に敷く斜線。色だけに頼らず、アプリの分と見分けられるようにする */
const HATCH_STYLE = {
    backgroundImage: "repeating-linear-gradient(135deg, currentColor 0 2px, transparent 2px 5px)",
}

const HATCH_CLASS = "text-muted-foreground"

interface ResourceRow {
    name: string
    bytes: number
    /** ホバー時に添える補足（プロセス数など） */
    note?: string
}

function percentOf(bytes: number, total: number): number {
    return total > 0 ? (bytes / total) * 100 : 0
}

/** ディスクを測ってからの経過秒数。時刻が読めなければ undefined */
function measuredAgeSeconds(measuredAt?: string): number | undefined {
    if (!measuredAt) return undefined

    const measured = Date.parse(measuredAt)
    if (Number.isNaN(measured)) return undefined

    return Math.max(0, Math.floor((Date.now() - measured) / 1000))
}

/**
 * メモリかディスクの片方。上に「アプリ合計 / アプリ以外 / 空き」の内訳バー、
 * 下にアプリごとの横棒を大きい順に並べる。
 *
 * 横棒の長さは最大のアプリを基準にする。1アプリはホスト全体の数%にしかならず、
 * 全体を分母にすると棒がどれも短くて差が読めないため。全体に対する割合は右端の％で出す。
 */
function ResourceBlock({
    label,
    totalLabel,
    rows,
    usage,
    stamp,
    barClassName,
}: {
    label: string
    /** ％の分母の呼び名（「メモリ総量」など） */
    totalLabel: string
    rows: ResourceRow[]
    usage: HostStatsUsage
    stamp?: string
    barClassName: string
}) {
    const [expanded, setExpanded] = useState(false)

    const appsBytes = rows.reduce((sum, row) => sum + row.bytes, 0)
    // エージェントが PSS を読めず RSS で代用したときは、共有ページの重複でアプリ合計が使用量を超えうる。
    // 内訳バーは使用量で頭打ちにし、「アプリ以外」は0未満にしない
    const appsInUsage = Math.min(appsBytes, usage.usedBytes)
    const otherBytes = Math.max(0, usage.usedBytes - appsBytes)
    const freeBytes = Math.max(0, usage.totalBytes - usage.usedBytes)
    const largest = rows[0]?.bytes ?? 0
    const hiddenCount = Math.max(0, rows.length - COLLAPSED_ROWS)

    return (
        <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {label}
                </span>
                <span className="font-mono text-base font-bold tabular-nums">{formatBytes(appsBytes)}</span>
                <span className="text-xs text-muted-foreground">
                    アプリ合計 / {formatBytes(usage.totalBytes)}
                </span>
                {stamp && <span className="ml-auto text-[10px] text-muted-foreground">{stamp}</span>}
            </div>

            <div
                className="flex h-3.5 gap-0.5 overflow-hidden rounded bg-muted"
                role="img"
                aria-label={`${totalLabel}の内訳: アプリ ${formatBytes(appsBytes)}、アプリ以外 ${formatBytes(otherBytes)}、空き ${formatBytes(freeBytes)}`}
            >
                <span
                    className={cn("h-full", barClassName)}
                    style={{ width: `${percentOf(appsInUsage, usage.totalBytes)}%` }}
                />
                {otherBytes > 0 && (
                    <span
                        className={cn("h-full", HATCH_CLASS)}
                        style={{ ...HATCH_STYLE, width: `${percentOf(otherBytes, usage.totalBytes)}%` }}
                    />
                )}
            </div>

            <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[10px] text-muted-foreground sm:text-[11px]">
                <span className="inline-flex items-center gap-1.5">
                    <span className={cn("size-2.5 rounded-sm", barClassName)} />
                    アプリ
                    <span className="font-mono font-semibold text-foreground">
                        {Math.round(percentOf(appsInUsage, usage.totalBytes))}%
                    </span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span
                        className={cn("size-2.5 rounded-sm border border-current", HATCH_CLASS)}
                        style={HATCH_STYLE}
                    />
                    アプリ以外
                    <span className="font-mono font-semibold text-foreground">
                        {Math.round(percentOf(otherBytes, usage.totalBytes))}%
                    </span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm border border-border bg-muted" />
                    空き
                    <span className="font-mono font-semibold text-foreground">{formatBytes(freeBytes)}</span>
                </span>
            </div>

            <ul className="space-y-2 sm:space-y-1">
                {rows.map((row, index) => {
                    const percent = percentOf(row.bytes, usage.totalBytes)

                    return (
                        <li
                            key={row.name}
                            title={`${row.name}: ${formatBytes(row.bytes)}（${totalLabel}の${percent.toFixed(1)}%）${row.note ? ` · ${row.note}` : ""}`}
                            className={cn(
                                // 狭い画面では「名前・値・％」の1行目の下に棒を敷き、広い画面では1行に並べる
                                "grid grid-cols-[minmax(0,1fr)_4.5rem_2.75rem] items-center gap-x-2 gap-y-1 rounded-md px-1 py-0.5 text-xs hover:bg-muted sm:grid-cols-[minmax(6rem,9.5rem)_minmax(0,1fr)_5rem_3rem] sm:gap-x-3",
                                !expanded && index >= COLLAPSED_ROWS && "hidden sm:grid"
                            )}
                        >
                            <span className="col-start-1 row-start-1 truncate font-medium sm:col-start-auto sm:row-start-auto">
                                {row.name}
                            </span>
                            <span className="col-span-3 row-start-2 h-2.5 sm:col-span-1 sm:row-start-auto">
                                <span
                                    className={cn("block h-full min-w-0.5 rounded-r", barClassName)}
                                    style={{ width: `${largest > 0 ? (row.bytes / largest) * 100 : 0}%` }}
                                />
                            </span>
                            <span className="col-start-2 row-start-1 text-right font-mono font-semibold tabular-nums sm:col-start-auto sm:row-start-auto">
                                {formatBytes(row.bytes)}
                            </span>
                            <span className="col-start-3 row-start-1 text-right font-mono text-[10px] text-muted-foreground tabular-nums sm:col-start-auto sm:row-start-auto">
                                {percent.toFixed(1)}%
                            </span>
                        </li>
                    )
                })}
            </ul>

            {hiddenCount > 0 && (
                <button
                    type="button"
                    onClick={() => setExpanded((value) => !value)}
                    className="rounded-full border border-border px-3 py-0.5 text-[11px] text-muted-foreground hover:bg-muted sm:hidden"
                >
                    {expanded ? "閉じる" : `他 ${hiddenCount}件を表示`}
                </button>
            )}
        </div>
    )
}

/** 内訳の無い理由を出す。apps自体が無い（未取得）と、appsはあるが該当行が無い（対象なし）を分ける */
function EmptyBreakdown({ label, message }: { label: string; message: string }) {
    return (
        <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
            <p className="text-xs text-muted-foreground">{message}</p>
        </div>
    )
}

const FOOTNOTE_CLASS = "border-t border-border pt-2.5 text-[10px] text-muted-foreground sm:text-[11px]"

/**
 * アプリ別のメモリ内訳（#226・#558）。メモリ詳細の中に置く。
 *
 * 「メモリ上位」のプロセス一覧は next-server や node が並ぶだけでどのアプリか読めないため、
 * エージェントがアプリのディレクトリ単位で集計したものを別に描く。
 */
export function AppMemoryBreakdown({ apps, memory }: { apps?: HostStatsApps; memory: HostStatsUsage }) {
    if (!apps) {
        return (
            <EmptyBreakdown
                label="Memory · アプリ別"
                message="アプリ別の内訳は未取得です（このホストはアプリの置き場を設定していないか、対応前のエージェントです）。"
            />
        )
    }

    const rows: ResourceRow[] = apps.items
        .filter((item) => item.memoryBytes > 0)
        .map((item) => ({ name: item.name, bytes: item.memoryBytes, note: `${item.processes}プロセス` }))
        .sort((a, b) => b.bytes - a.bytes)

    if (rows.length === 0) {
        return <EmptyBreakdown label="Memory · アプリ別" message="メモリを使っているアプリはありません。" />
    }

    return (
        <div className="space-y-3">
            <ResourceBlock
                label="Memory · アプリ別"
                totalLabel="メモリ総量"
                rows={rows}
                usage={memory}
                barClassName="bg-primary"
            />
            <p className={FOOTNOTE_CLASS}>
                アプリのディレクトリで動いているプロセスの使用メモリ（共有分をプロセス数で割ったPSS）の合計。
            </p>
        </div>
    )
}

/** アプリ別のディスク内訳（#226・#558）。ディスク詳細の中に置く */
export function AppDiskBreakdown({ apps }: { apps?: HostStatsApps }) {
    if (!apps) {
        return (
            <EmptyBreakdown
                label="Disk · アプリ別"
                message="アプリ別の内訳は未取得です（このホストはアプリの置き場を設定していないか、対応前のエージェントです）。"
            />
        )
    }

    const rows: ResourceRow[] = apps.items
        .flatMap((item) => (item.diskBytes ? [{ name: item.name, bytes: item.diskBytes }] : []))
        .sort((a, b) => b.bytes - a.bytes)

    if (!apps.disk || rows.length === 0) {
        return (
            <EmptyBreakdown
                label="Disk · アプリ別"
                message="ディスク使用量はまだ測っていません（1時間ごとに計測します）。"
            />
        )
    }

    const measuredAge = measuredAgeSeconds(apps.diskMeasuredAt)

    return (
        <div className="space-y-3">
            <ResourceBlock
                label="Disk · アプリ別"
                totalLabel="ディスク容量"
                rows={rows}
                usage={apps.disk}
                stamp={measuredAge === undefined ? undefined : `計測 ${formatAge(measuredAge)}（1時間ごと）`}
                barClassName="bg-teal-400"
            />
            <p className={FOOTNOTE_CLASS}>
                各アプリのディレクトリの使用量（node_modules・ビルド成果物を含む）。{apps.root} 配下をアプリ単位で集計。
            </p>
        </div>
    )
}
