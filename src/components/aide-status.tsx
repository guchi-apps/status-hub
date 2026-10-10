"use client"

import { CSRF_HEADERS } from "@/lib/csrf-headers"
import { Fragment, useCallback, useState } from "react"
import { AideWorkReports } from "@/components/aide-work-reports"
import { useDashboardData } from "@/components/dashboard-data"
import { JobHistoryModal } from "@/components/job-history-modal"
import { Panel } from "@/components/panel"
import { AccessDenied, Skeleton, SkeletonGroup } from "@/components/skeleton"
import { StatusBadge, TEXT_TONES } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import {
    AIDE_SEVERITY_LABEL,
    AIDE_SEVERITY_TONE,
    formatAideDateTime,
    formatAideDuration,
    formatAideLogTime,
} from "@/lib/aide-status-format"
import { cn } from "@/lib/utils"
import type {
    AideCache,
    AideConnector,
    AideHealth,
    AideJob,
    AideMcpAccess,
    AideMcpAccessEntry,
    AideProbeResponse,
    AideProbeResult,
    AideSeverity,
    AideStatusSnapshot,
} from "@/types/aide-status"

/** メソッドの日本語。ツールの呼び出し以外は、何をしたのかが名前から読めないため置き換える */
const METHOD_LABELS: Record<string, string> = {
    auth: "認証で拒否",
    initialize: "接続開始",
    ping: "接続確認",
    "tools/list": "ツール一覧",
    "resources/list": "リソース一覧",
    "prompts/list": "プロンプト一覧",
}

/**
 * 数が多く、ツールの呼び出しを押し流すメソッド。既定では畳む。
 * AIDE側の `isQuietMethod`（src/mcp/access-log.ts）に `initialize` を足したもの。接続開始は
 * クライアントが数分おきに繰り返すため、畳まないと一覧を埋めてツール名が見えなくなる（#394）
 */
const QUIET_METHODS = new Set(["initialize", "ping", "tools/list", "resources/list", "prompts/list"])

function isQuietMethod(method: string): boolean {
    return QUIET_METHODS.has(method) || method.startsWith("notifications/")
}

/** 悪いほうを採る。unknown（材料が無い）は判定に影響させない */
function worst(severities: AideSeverity[]): AideSeverity {
    if (severities.includes("danger")) return "danger"
    if (severities.includes("warn")) return "warn"
    return "ok"
}

function SeverityBadge({ severity, label }: { severity: AideSeverity; label?: string }) {
    return (
        <StatusBadge tone={AIDE_SEVERITY_TONE[severity]} withDot>
            {label ?? AIDE_SEVERITY_LABEL[severity]}
        </StatusBadge>
    )
}

function Meta({ children }: { children: React.ReactNode }) {
    return <span className="ml-auto font-mono text-[10px] text-muted-foreground">{children}</span>
}

function Note({ children }: { children: React.ReactNode }) {
    return (
        <p className="mt-2.5 border-t border-border pt-2 text-[11px] text-muted-foreground">{children}</p>
    )
}

function DefList({ rows }: { rows: [string, React.ReactNode][] }) {
    return (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-1 text-xs">
            {rows.map(([label, value]) => (
                <Fragment key={label}>
                    <dt className="whitespace-nowrap text-muted-foreground">{label}</dt>
                    <dd className="min-w-0 tabular-nums [overflow-wrap:anywhere]">{value}</dd>
                </Fragment>
            ))}
        </dl>
    )
}

/** 広い画面用の表。狭い画面では各カードが2行のリストへ組み替えるため、sm 未満では隠す */
function Table({
    headers,
    rows,
    rowClassNames,
    onRowSelect,
    className,
}: {
    headers: string[]
    rows: React.ReactNode[][]
    rowClassNames?: (string | undefined)[]
    /** 渡すと行が押せるようになる（クリック・Enter・Space） */
    onRowSelect?: (index: number) => void
    className?: string
}) {
    return (
        <div className={cn("overflow-x-auto", className)}>
            <table className="w-full border-collapse text-xs">
                <thead>
                    <tr>
                        {headers.map((header) => (
                            <th
                                key={header}
                                className="whitespace-nowrap border-b border-border py-1 pr-2.5 text-left text-[10px] font-medium tracking-wide text-muted-foreground"
                            >
                                {header}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="[&_tr:last-child_td]:border-b-0">
                    {rows.map((cells, index) => (
                        <tr
                            key={index}
                            className={cn(
                                rowClassNames?.[index],
                                onRowSelect &&
                                    "cursor-pointer hover:bg-primary/10 focus-visible:bg-primary/10 focus-visible:outline-none"
                            )}
                            {...(onRowSelect && {
                                tabIndex: 0,
                                role: "button",
                                onClick: () => onRowSelect(index),
                                onKeyDown: (event: React.KeyboardEvent) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault()
                                        onRowSelect(index)
                                    }
                                },
                            })}
                        >
                            {cells.map((cell, cellIndex) => (
                                <td
                                    key={cellIndex}
                                    className="border-b border-border py-1.5 pr-2.5 align-top tabular-nums"
                                >
                                    {cell}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function RowList({ children }: { children: React.ReactNode }) {
    return <ul className="divide-y divide-border sm:hidden">{children}</ul>
}

function RowItem({
    name,
    badge,
    sub,
    detail,
    onSelect,
}: {
    name: React.ReactNode
    badge: React.ReactNode
    sub: string
    detail?: string
    /** 渡すと行が押せるようになる（クリック・Enter・Space） */
    onSelect?: () => void
}) {
    return (
        <li
            className={cn(
                "flex flex-col gap-px py-1.5",
                onSelect && "cursor-pointer active:bg-primary/10 focus-visible:bg-primary/10 focus-visible:outline-none"
            )}
            {...(onSelect && {
                tabIndex: 0,
                role: "button",
                onClick: onSelect,
                onKeyDown: (event: React.KeyboardEvent) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        onSelect()
                    }
                },
            })}
        >
            <div className="flex items-center gap-2">
                <span className="min-w-0 text-xs font-medium [overflow-wrap:anywhere]">{name}</span>
                <span className="ml-auto shrink-0">{badge}</span>
            </div>
            <span className="text-[11px] tabular-nums text-muted-foreground">{sub}</span>
            {detail && <span className="text-[11px] text-red-400">{detail}</span>}
        </li>
    )
}

function hostOf(url: string): string {
    try {
        return new URL(url).host
    } catch {
        return url
    }
}

function OverviewPanel({ health }: { health: AideHealth }) {
    const count = health.attention.length
    const headline =
        count === 0
            ? "異常はありません"
            : health.severity === "danger"
              ? `対応が必要なことが ${count} 件あります`
              : `注意が ${count} 件あります`

    return (
        <Panel
            title="AIDE の動作状況"
            className="md:col-span-2 xl:col-span-12"
            trailing={
                <>
                    <SeverityBadge severity={health.severity} />
                    <Meta>{hostOf(health.server.baseUrl)}</Meta>
                </>
            }
        >
            <div className="space-y-2">
                <p className="text-lg font-bold leading-snug text-balance md:text-xl">{headline}</p>
                <div className="flex flex-wrap gap-x-3.5 gap-y-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                    <span>確認 {formatAideDateTime(health.checkedAt)}</span>
                    <span>稼働 {formatAideDuration(Math.round(health.server.uptimeSeconds / 60))}</span>
                    <span>v{health.server.version || "?"}</span>
                    <span>Node {health.server.nodeVersion}</span>
                </div>
                {count > 0 && (
                    <ul className="space-y-1.5">
                        {health.attention.map((item, index) => (
                            <li
                                key={index}
                                className={cn(
                                    "rounded-lg border-l-[3px] px-2.5 py-2 text-[13px]",
                                    item.severity === "danger"
                                        ? "border-l-red-500 bg-red-500/10"
                                        : "border-l-amber-500 bg-amber-500/10"
                                )}
                            >
                                {item.message}
                                {item.action && (
                                    <span className="mt-0.5 block text-xs text-muted-foreground">
                                        対応: {item.action}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </Panel>
    )
}

/** 取得に失敗したとき。直前の値があれば、その下にそのまま残して出す */
function ErrorPanel({ snapshot, now }: { snapshot: AideStatusSnapshot; now: number }) {
    return (
        <Panel
            title="AIDE の動作状況"
            className={cn(
                "border-l-[3px] md:col-span-2 xl:col-span-12",
                snapshot.denied ? "border-l-amber-500" : "border-l-red-500"
            )}
            trailing={
                <>
                    <StatusBadge tone={snapshot.denied ? "warn" : "danger"} withDot>
                        {snapshot.denied ? "権限不足" : "取得できません"}
                    </StatusBadge>
                    <Meta>{formatAideLogTime(snapshot.fetchedAt, now)} に確認</Meta>
                </>
            }
        >
            {snapshot.denied ? (
                <AccessDenied reason={snapshot.message} />
            ) : (
                <p className="text-[13px]">
                    AIDEから動作状況を取得できませんでした。{snapshot.message}
                </p>
            )}
            {snapshot.health && snapshot.healthFetchedAt && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                    以下は {formatAideDateTime(snapshot.healthFetchedAt)} に取得できた値です。
                </p>
            )}
        </Panel>
    )
}

function jobLabel(job: AideJob): string {
    if (!job.lastRun) return AIDE_SEVERITY_LABEL[job.severity]
    if (!job.lastRun.ok) return "失敗"
    // 成功しているが間隔ぶん動いていない。「成功」のまま黄色にすると何が悪いのか読めない
    return job.severity === "warn" ? "遅れ" : "成功"
}

function JobsPanel({ jobs }: { jobs: AideJob[] }) {
    const [selectedName, setSelectedName] = useState<string | null>(null)
    const closeModal = useCallback(() => setSelectedName(null), [])
    const selectedJob = jobs.find((job) => job.name === selectedName)
    const badge = (job: AideJob) => (
        <StatusBadge tone={AIDE_SEVERITY_TONE[job.severity]}>{jobLabel(job)}</StatusBadge>
    )
    const failures = jobs.filter((job) => job.lastRun && !job.lastRun.ok)

    return (
        <Panel
            title="定期ジョブ"
            className="md:col-span-2 xl:col-span-8"
            trailing={
                <>
                    <SeverityBadge severity={worst(jobs.map((job) => job.severity))} />
                    <Meta>worker · サブPC</Meta>
                </>
            }
        >
            <Table
                className="hidden sm:block"
                headers={["ジョブ", "実行間隔", "最後の実行", "経過", "状態"]}
                rows={jobs.map((job) => [
                    <span key="name" className="font-mono">
                        {job.name}
                    </span>,
                    job.interval,
                    <span key="at" className="whitespace-nowrap font-mono">
                        {job.lastRun ? formatAideDateTime(job.lastRun.at) : "—"}
                    </span>,
                    <span key="age" className="whitespace-nowrap font-mono">
                        {job.lastRun ? `${formatAideDuration(job.lastRun.ageMinutes)}前` : "—"}
                    </span>,
                    badge(job),
                ])}
                onRowSelect={(index) => setSelectedName(jobs[index]?.name ?? null)}
            />
            <RowList>
                {jobs.map((job) => (
                    <RowItem
                        key={job.name}
                        name={<span className="font-mono">{job.name}</span>}
                        badge={badge(job)}
                        sub={
                            job.lastRun
                                ? `${job.interval} · ${formatAideDateTime(job.lastRun.at)}（${formatAideDuration(job.lastRun.ageMinutes)}前）`
                                : job.interval
                        }
                        onSelect={() => setSelectedName(job.name)}
                    />
                ))}
            </RowList>
            {/* 失敗の理由は表の列に収まらないため、表の下へ回す */}
            {failures.map((job) => (
                <p key={job.name} className="mt-1.5 text-[11px] text-red-400">
                    <span className="font-mono">{job.name}</span>: {job.lastRun?.message}
                </p>
            ))}
            <Note>
                worker が実行のたびに残す記録を読んでいます。まだ一度も動いていないジョブは「記録なし」になります。ジョブを押すと実行記録を開きます。
            </Note>
            {selectedJob && <JobHistoryModal job={selectedJob} onClose={closeModal} />}
        </Panel>
    )
}

function ServerPanel({ health }: { health: AideHealth }) {
    const { server } = health
    return (
        <Panel
            title="サーバー"
            className="xl:col-span-4"
            trailing={
                <>
                    <SeverityBadge
                        severity={server.authEnabled ? "ok" : "danger"}
                        label={server.authEnabled ? "正常" : "認証が無効"}
                    />
                    <Meta>VPS</Meta>
                </>
            }
        >
            <DefList
                rows={[
                    ["稼働時間", formatAideDuration(Math.round(server.uptimeSeconds / 60))],
                    ["起動", <span key="started" className="font-mono">{formatAideDateTime(server.startedAt)}</span>],
                    ["バージョン", <span key="version" className="font-mono">{server.version || "不明"}</span>],
                    ["Node", <span key="node" className="font-mono">{server.nodeVersion}</span>],
                    ["認証", server.authEnabled ? "有効" : "無効（AIDE_AUTH_DISABLED=1）"],
                    ["MCP接続先", <span key="mcp" className="font-mono">{server.mcpUrl}</span>],
                ]}
            />
        </Panel>
    )
}

function Operation({ entry }: { entry: AideMcpAccessEntry }) {
    if (entry.tool) return <span className="font-mono">{entry.tool}</span>
    if (entry.method.startsWith("notifications/")) {
        return (
            <>
                通知（<span className="font-mono">{entry.method.slice("notifications/".length)}</span>）
            </>
        )
    }
    return <>{METHOD_LABELS[entry.method] ?? entry.method}</>
}

function AccessPanel({ access, now }: { access: AideMcpAccess; now: number }) {
    const [showQuiet, setShowQuiet] = useState(false)

    if (access.total === 0) {
        return (
            <Panel
                title="MCPアクセス"
                className="md:col-span-2 xl:col-span-8"
                trailing={<SeverityBadge severity="unknown" />}
            >
                <p className="text-[11px] text-muted-foreground">
                    まだ記録がありません。ClaudeアプリがMCPへ接続すると、ここに1件ずつ残ります。
                </p>
            </Panel>
        )
    }

    const entries = showQuiet ? access.entries : access.entries.filter((entry) => !isQuietMethod(entry.method))
    const resultBadge = (entry: AideMcpAccessEntry) => (
        <StatusBadge tone={entry.ok ? "ok" : "danger"}>{entry.ok ? "成功" : "失敗"}</StatusBadge>
    )

    return (
        <Panel
            title="MCPアクセス"
            className="md:col-span-2 xl:col-span-8"
            trailing={
                <>
                    <SeverityBadge severity={access.severity} />
                    <Meta>直近 {access.total} 件</Meta>
                </>
            }
        >
            <div className="space-y-2">
                <DefList
                    rows={[
                        [
                            "最後のアクセス",
                            access.lastAt
                                ? `${formatAideDateTime(access.lastAt)}（${formatAideDuration(access.lastAgeMinutes ?? 0)}前）`
                                : "—",
                        ],
                        [
                            "ツール呼び出し",
                            `${access.toolCalls} 件${access.failures > 0 ? `（失敗 ${access.failures} 件）` : ""}`,
                        ],
                        ["接続クライアント", access.clients.length === 0 ? "不明" : access.clients.join(" ／ ")],
                        // 0件のときは行ごと出さない。常時0が並ぶと、実際に弾いたときの1が目に入らない
                        ...(access.authFailures > 0
                            ? ([["認証で拒否", `${access.authFailures} 件`]] as [string, string][])
                            : []),
                    ]}
                />
                <label
                    htmlFor="aide-mcp-quiet"
                    className="flex w-fit cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground"
                >
                    <input
                        id="aide-mcp-quiet"
                        type="checkbox"
                        checked={showQuiet}
                        onChange={(event) => setShowQuiet(event.target.checked)}
                        className="accent-primary"
                    />
                    接続開始・接続確認・一覧の取得も表示する
                </label>
                {entries.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                        直近の記録は接続開始・接続確認などだけで、ツールは呼ばれていません。上のチェックを入れると表示します。
                    </p>
                ) : (
                    <>
                        <Table
                            className="hidden sm:block"
                            headers={["時刻", "クライアント", "操作", "結果", "所要"]}
                            rows={entries.map((entry) => [
                                <span key="at" className="whitespace-nowrap font-mono">
                                    {formatAideLogTime(entry.at, now)}
                                </span>,
                                entry.client ?? "不明",
                                <Fragment key="op">
                                    <Operation entry={entry} />
                                    {!entry.ok && entry.detail && (
                                        <span className="block text-[11px] text-red-400">
                                            {entry.detail}
                                        </span>
                                    )}
                                </Fragment>,
                                resultBadge(entry),
                                <span key="ms" className="whitespace-nowrap font-mono">
                                    {entry.ms.toLocaleString("ja-JP")}ms
                                </span>,
                            ])}
                            rowClassNames={entries.map((entry) =>
                                isQuietMethod(entry.method) ? "text-muted-foreground" : undefined
                            )}
                        />
                        <RowList>
                            {entries.map((entry, index) => (
                                <RowItem
                                    key={`${entry.at}-${index}`}
                                    name={<Operation entry={entry} />}
                                    badge={resultBadge(entry)}
                                    sub={`${formatAideLogTime(entry.at, now)} · ${entry.client ?? "不明"} · ${entry.ms.toLocaleString("ja-JP")}ms`}
                                    detail={!entry.ok && entry.detail ? entry.detail : undefined}
                                />
                            ))}
                        </RowList>
                    </>
                )}
            </div>
            <Note>
                呼ばれた事実だけを残しています（引数・応答の中身・アクセス元は記録しません）。古いものから順に消えます。
            </Note>
        </Panel>
    )
}

function McpPanel({ health, tools }: { health: AideHealth; tools: string[] }) {
    const counts = new Map(health.mcpAccess.toolCounts.map(({ tool, count }) => [tool, count]))
    // よく使うものから並べる。0回のツールには数字を添えない
    // （「一度も呼ばれていない」と「記録が流れて消えた」を見分けられないため）
    const sorted = [...tools].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))

    return (
        <Panel
            title="MCP接続"
            className="xl:col-span-4"
            trailing={
                <>
                    <SeverityBadge severity="ok" />
                    <Meta>ツール {tools.length}</Meta>
                </>
            }
        >
            <div className="space-y-2.5">
                <DefList
                    rows={[
                        ["登録クライアント", `${health.mcp.clients} 件`],
                        [
                            "有効なトークン",
                            health.mcp.nearestExpiryAt
                                ? `${health.mcp.tokens} 件（最短の期限 ${formatAideDateTime(health.mcp.nearestExpiryAt)}）`
                                : `${health.mcp.tokens} 件`,
                        ],
                    ]}
                />
                <ul className="flex flex-wrap gap-1.5">
                    {sorted.map((tool) => (
                        <li
                            key={tool}
                            className="rounded-md border border-border bg-muted px-1.5 py-px font-mono text-[11px]"
                        >
                            {tool}
                            {counts.get(tool) ? (
                                <b className="ml-1.5 tabular-nums text-primary">{counts.get(tool)}</b>
                            ) : null}
                        </li>
                    ))}
                </ul>
            </div>
            <Note>数字は記録に残っている範囲での呼び出し回数です。</Note>
        </Panel>
    )
}

function CachePanel({ cache }: { cache: AideCache }) {
    return (
        <Panel
            title="キャッシュ"
            className="xl:col-span-4"
            trailing={
                <>
                    <SeverityBadge severity={cache.severity} />
                    <Meta>{cache.key}</Meta>
                </>
            }
        >
            {cache.empty ? (
                <p className="text-[11px] text-muted-foreground">
                    まだ一度も巡回していません。zaim-sync が成功すると値が入ります。
                </p>
            ) : (
                <>
                    <DefList
                        rows={[
                            ["取得", cache.fetchedAt ? formatAideDateTime(cache.fetchedAt) : "—"],
                            ["経過", `${formatAideDuration(cache.ageMinutes ?? 0)}前`],
                            [
                                "鮮度",
                                <StatusBadge key="stale" tone={cache.stale ? "warn" : "ok"}>
                                    {cache.stale ? "期限切れ" : "期限内"}
                                </StatusBadge>,
                            ],
                            ["件数", `残高 ${cache.balances} 件 ／ 保有銘柄 ${cache.holdings} 件`],
                            [
                                "当日未更新の口座",
                                cache.staleAccounts.length === 0 ? "なし" : cache.staleAccounts.join("・"),
                            ],
                        ]}
                    />
                    <Note>金額は表示しません。鮮度と件数だけを出しています。</Note>
                </>
            )}
        </Panel>
    )
}

interface ProbeState {
    phase: "idle" | "running" | "done" | "error"
    results: Record<string, AideProbeResult>
    checkedAt: string | null
    message?: string
}

function ProbeCell({ connector, result }: { connector: AideConnector; result?: AideProbeResult }) {
    if (!connector.probeable) return <span className="text-muted-foreground">確認しない</span>
    if (!result) return <span className="font-mono text-muted-foreground">—</span>
    return result.ok ? (
        <span className={cn("font-mono", TEXT_TONES.ok)}>{result.ms}ms</span>
    ) : (
        <span className={cn("text-[11px]", TEXT_TONES.danger)}>{result.detail}</span>
    )
}

function ConnectorsPanel({ connectors, now }: { connectors: AideConnector[]; now: number }) {
    const [probe, setProbe] = useState<ProbeState>({ phase: "idle", results: {}, checkedAt: null })
    const missing = connectors.some((connector) => connector.configured === false)

    // 押したときだけAIDEが外部へ問い合わせる。自動取得には混ぜない
    const runChecks = async () => {
        setProbe((previous) => ({ ...previous, phase: "running", message: undefined }))
        try {
            const res = await fetch("/api/aide-status/checks", {
                method: "POST",
                headers: CSRF_HEADERS,
                cache: "no-store",
            })
            if (!res.ok) throw new Error(`/api/aide-status/checks が ${res.status} を返しました`)

            const body = (await res.json()) as AideProbeResponse
            if (body.status !== "ok") {
                setProbe((previous) => ({
                    ...previous,
                    phase: "error",
                    message: body.message ?? "疎通を確認できませんでした",
                }))
                return
            }
            setProbe({
                phase: "done",
                results: Object.fromEntries(body.results.map((result) => [result.key, result])),
                checkedAt: new Date().toISOString(),
            })
        } catch (error) {
            console.error("Failed to run AIDE checks:", error)
            setProbe((previous) => ({ ...previous, phase: "error", message: "疎通を確認できませんでした" }))
        }
    }

    const settingBadge = (connector: AideConnector) =>
        // worker 側（サブPC）の設定はAIDEのサーバーから判定できない。未設定と出すと常に未設定に見える
        connector.configured === null ? (
            <StatusBadge tone="neutral">worker側</StatusBadge>
        ) : connector.configured ? (
            <StatusBadge tone="ok">設定済み</StatusBadge>
        ) : (
            <StatusBadge tone="warn">未設定</StatusBadge>
        )

    return (
        <Panel
            title="接続先"
            className="xl:col-span-8"
            trailing={
                <>
                    <SeverityBadge severity={missing ? "warn" : "ok"} label={missing ? "未設定あり" : "正常"} />
                    {probe.checkedAt && <Meta>{formatAideLogTime(probe.checkedAt, now)} に疎通を確認</Meta>}
                </>
            }
        >
            <Table
                headers={["接続先", "設定", "疎通"]}
                rows={connectors.map((connector) => [
                    <span key="key" className="font-mono" title={connector.note}>
                        {connector.key}
                    </span>,
                    settingBadge(connector),
                    <ProbeCell key="probe" connector={connector} result={probe.results[connector.key]} />,
                ])}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => void runChecks()}
                    disabled={probe.phase === "running"}
                >
                    {probe.phase === "running" ? "確認中…" : probe.phase === "done" ? "再確認する" : "疎通を確認する"}
                </Button>
                {probe.phase === "error" && (
                    <span className={cn("text-[11px]", TEXT_TONES.danger)}>{probe.message}</span>
                )}
            </div>
            <Note>
                押したときだけAIDEが外部へ問い合わせます。worker（サブPC）側の設定はAIDEからは判定できないため、動いているかは定期ジョブの記録で確認してください。
            </Note>
        </Panel>
    )
}

/**
 * AIDEタブの中身（#237）。aide.gucchii.com/status と同じカードを、ダッシュボードの部品で並べる。
 *
 * 判定（正常・注意・異常）はAIDE側が持ち、ここは並べ方と色だけを決める。
 */
export function AideStatus() {
    const { aideStatus: snapshot, now } = useDashboardData()
    return (
        <div className="space-y-3">
            <AideWorkReports />
            <AideStatusView snapshot={snapshot} now={now} />
        </div>
    )
}

/** 取得済みの状態を並べる本体。取得元（DashboardDataProvider）から切り離し、確認用の画面からも描画できるようにしている */
export function AideStatusView({ snapshot, now }: { snapshot: AideStatusSnapshot | null; now: number }) {

    if (!snapshot) {
        return (
            <Panel title="AIDE の動作状況">
                <SkeletonGroup label="AIDEの動作状況" className="space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="h-3 w-1/2" />
                </SkeletonGroup>
            </Panel>
        )
    }

    if (snapshot.status === "unconfigured") {
        return (
            <Panel title="AIDE の動作状況">
                <p className="text-xs text-muted-foreground">{snapshot.message}</p>
            </Panel>
        )
    }

    const { health } = snapshot

    return (
        <div className="space-y-3">
            <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-12">
                {snapshot.status === "error" && <ErrorPanel snapshot={snapshot} now={now} />}
                {health && (
                    <>
                        <OverviewPanel health={health} />
                        <ServerPanel health={health} />
                        <JobsPanel jobs={health.jobs} />
                        <AccessPanel access={health.mcpAccess} now={now} />
                        <McpPanel health={health} tools={snapshot.tools} />
                        <CachePanel cache={health.cache} />
                        <ConnectorsPanel connectors={health.connectors} now={now} />
                    </>
                )}
            </div>
            {health && (
                <p className="text-[11px] text-muted-foreground">シークレットの値・残高の金額は表示しません。</p>
            )}
        </div>
    )
}
