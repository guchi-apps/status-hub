"use client"

import { Panel } from "@/components/panel"
import { Skeleton, SkeletonGroup } from "@/components/skeleton"
import { StatusBadge } from "@/components/status-badge"
import {
    AIDE_SEVERITY_LABEL,
    AIDE_SEVERITY_TONE,
    formatAideDuration,
    jobLabel,
} from "@/lib/aide-status-format"
import { SECTION_ANCHORS } from "@/lib/section-anchors"
import type { AideConnector, AideJob, AideSeverity, AideStatusSnapshot } from "@/types/aide-status"

/** 概要に出すジョブの件数。残りは「ほか N件」にまとめ、詳細はAIDEタブで見る */
const OVERVIEW_JOB_LIMIT = 5

const SEVERITY_RANK: Record<AideSeverity, number> = { danger: 0, warn: 1, unknown: 2, ok: 3 }

function worst(severities: AideSeverity[]): AideSeverity {
    if (severities.includes("danger")) return "danger"
    if (severities.includes("warn")) return "warn"
    return "ok"
}

/** 異常・注意のジョブを先に出す。同じ状態どうしは名前順で、並びが取得のたびに入れ替わらないようにする */
function sortJobs(jobs: AideJob[]): AideJob[] {
    return [...jobs].sort(
        (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.name.localeCompare(b.name)
    )
}

function Row({ children }: { children: React.ReactNode }) {
    return (
        <li className="flex items-center gap-2 border-t border-border py-1.5 text-xs first:border-t-0 first:pt-0">
            {children}
        </li>
    )
}

function Placeholder({ title, id, className }: { title: string; id: string; className?: string }) {
    return (
        <Panel title={title} id={id} className={className}>
            <SkeletonGroup label={title} className="space-y-2">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
            </SkeletonGroup>
        </Panel>
    )
}

/**
 * 概要タブの「定期ジョブ」「接続先」（#685）。AIDEタブと同じ `/api/aide-status` の取得結果を読むだけで、
 * 追加の取得はしない。判定（状態の色）はAIDE側が持つ。
 *
 * 取得前はスケルトン、取得に失敗したときは「取得不可」を出す。黙って消すと、AIDEが落ちていることが
 * 概要から見えなくなる。直前に取得できた値があればそれを残す（`health`）。
 */
export function AideOverviewPanels({
    snapshot,
    onOpen,
    className,
}: {
    snapshot: AideStatusSnapshot | null
    onOpen: (anchorId: string) => void
    className?: string
}) {
    if (!snapshot) {
        return (
            <>
                <Placeholder title="定期ジョブ" id="overview-aide-jobs" className={className} />
                <Placeholder title="接続先" id="overview-aide-connectors" className={className} />
            </>
        )
    }
    // 連携の設定自体が無い環境（DashboardShell の aideConfigured と同じ条件）では出さない
    if (snapshot.status === "unconfigured") return null

    const { health } = snapshot
    const failed = snapshot.status === "error"
    const failedBadge = failed ? (
        <StatusBadge tone="danger">{snapshot.denied ? "表示不可" : "取得不可"}</StatusBadge>
    ) : null
    const failedNote = failed ? (
        <p role="alert" className="mb-2 text-[11px] text-red-400">
            {snapshot.message ?? "AIDEの状態を取得できません"}
            {health && "（直前に取得できた値を表示しています）"}
        </p>
    ) : null

    return (
        <>
            <JobsOverview
                jobs={health?.jobs ?? null}
                failedBadge={failedBadge}
                failedNote={failedNote}
                onOpen={() => onOpen(SECTION_ANCHORS.aideJobs)}
                className={className}
            />
            <ConnectorsOverview
                connectors={health?.connectors ?? null}
                failedBadge={failedBadge}
                failedNote={failedNote}
                onOpen={() => onOpen(SECTION_ANCHORS.aideConnectors)}
                className={className}
            />
        </>
    )
}

function JobsOverview({
    jobs,
    failedBadge,
    failedNote,
    onOpen,
    className,
}: {
    jobs: AideJob[] | null
    failedBadge: React.ReactNode
    failedNote: React.ReactNode
    onOpen: () => void
    className?: string
}) {
    const sorted = jobs ? sortJobs(jobs) : []
    const shown = sorted.slice(0, OVERVIEW_JOB_LIMIT)
    const rest = sorted.length - shown.length
    const severity = jobs ? worst(jobs.map((job) => job.severity)) : null

    return (
        <Panel
            title="定期ジョブ"
            id="overview-aide-jobs"
            className={className}
            onOpen={onOpen}
            openLabel="定期ジョブの詳細をAIDEタブで開く"
            trailing={
                <>
                    {failedBadge}
                    {!failedBadge && severity && (
                        <StatusBadge tone={AIDE_SEVERITY_TONE[severity]} withDot>
                            {AIDE_SEVERITY_LABEL[severity]}
                        </StatusBadge>
                    )}
                    {jobs && <span className="font-mono text-[10px] text-muted-foreground">全{jobs.length}件</span>}
                </>
            }
        >
            {failedNote}
            {jobs && jobs.length === 0 && (
                <p className="text-xs text-muted-foreground">定期ジョブはありません</p>
            )}
            {jobs && jobs.length > 0 && (
                <ul>
                    {shown.map((job) => (
                        <Row key={job.name}>
                            <span className="min-w-0 flex-1 truncate font-mono" title={job.name}>
                                {job.name}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                                {job.interval}
                                {job.lastRun && ` · ${formatAideDuration(job.lastRun.ageMinutes)}前`}
                            </span>
                            <StatusBadge tone={AIDE_SEVERITY_TONE[job.severity]}>{jobLabel(job)}</StatusBadge>
                        </Row>
                    ))}
                    {rest > 0 && (
                        <li className="border-t border-border pt-1.5 text-[11px] text-muted-foreground">
                            ほか {rest}件
                        </li>
                    )}
                </ul>
            )}
        </Panel>
    )
}

function ConnectorsOverview({
    connectors,
    failedBadge,
    failedNote,
    onOpen,
    className,
}: {
    connectors: AideConnector[] | null
    failedBadge: React.ReactNode
    failedNote: React.ReactNode
    onOpen: () => void
    className?: string
}) {
    const missing = connectors?.some((connector) => connector.configured === false) ?? false

    return (
        <Panel
            title="接続先"
            id="overview-aide-connectors"
            className={className}
            onOpen={onOpen}
            openLabel="接続先の詳細・疎通確認をAIDEタブで開く"
            trailing={
                <>
                    {failedBadge}
                    {!failedBadge && connectors && (
                        <StatusBadge tone={missing ? "warn" : "ok"} withDot>
                            {missing ? "未設定あり" : "正常"}
                        </StatusBadge>
                    )}
                </>
            }
        >
            {failedNote}
            {connectors && (
                <ul>
                    {connectors.map((connector) => (
                        <Row key={connector.key}>
                            <span className="min-w-0 flex-1 truncate font-mono" title={connector.note}>
                                {connector.key}
                            </span>
                            {/* worker側の設定はAIDEのサーバーから判定できない（未設定と出すと常に未設定に見える） */}
                            {connector.configured === null ? (
                                <StatusBadge tone="neutral">worker側</StatusBadge>
                            ) : connector.configured ? (
                                <StatusBadge tone="ok">設定済み</StatusBadge>
                            ) : (
                                <StatusBadge tone="warn">未設定</StatusBadge>
                            )}
                        </Row>
                    ))}
                </ul>
            )}
        </Panel>
    )
}
