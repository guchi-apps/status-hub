"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useDashboardData } from "@/components/dashboard-data"
import { Panel } from "@/components/panel"
import { AccessDenied, Skeleton, SkeletonGroup } from "@/components/skeleton"
import { StatusBadge } from "@/components/status-badge"
import { formatAideDateTime, formatAideDuration, formatAideLogTime } from "@/lib/aide-status-format"
import { displayWork, safeLink, WORK_STATUS_LABEL } from "@/lib/aide-work-reports-format"
import { cn } from "@/lib/utils"
import type { AideWorkReportsSnapshot, WorkReport } from "@/types/aide-work-reports"

const TITLE = "dot の作業状況"

function minutesSince(iso: string, now: number): number {
    return Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
}

/** 「3分前」。最終報告からの経過。画面の取得時刻とは別に出す */
function ago(iso: string, now: number): string {
    const minutes = minutesSince(iso, now)
    return minutes < 1 ? "1分未満前" : `${formatAideDuration(minutes)}前`
}

/** 取得できた値で画面を出す本体。取得元から切り離し、確認用の画面からも描画できるようにしている */
export function AideWorkReportsView({ snapshot, now }: { snapshot: AideWorkReportsSnapshot | null; now: number }) {
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const close = useCallback(() => setSelectedId(null), [])

    if (!snapshot) {
        return (
            <Panel title={TITLE}>
                <SkeletonGroup label="dotの作業状況" className="space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-2/3" />
                </SkeletonGroup>
            </Panel>
        )
    }
    // 未設定の環境（worktree・開発機）では節ごと出さない
    if (snapshot.status === "unconfigured") return null

    const { listing } = snapshot
    const failed = snapshot.status === "error"
    const selected = listing?.works.find((work) => work.workId === selectedId) ?? null

    return (
        <Panel
            title={TITLE}
            className={cn(failed && "border-l-[3px]", failed && (snapshot.denied ? "border-l-amber-500" : "border-l-red-500"))}
            trailing={
                <>
                    {failed && (
                        <StatusBadge tone={snapshot.denied ? "warn" : "danger"} withDot>
                            {snapshot.denied ? "権限不足" : "取得できません"}
                        </StatusBadge>
                    )}
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                        {formatAideLogTime(snapshot.fetchedAt, now)} に確認
                    </span>
                </>
            }
        >
            <p className="mb-2 text-[11px] text-muted-foreground">
                dotが<b>明示的に報告した作業だけ</b>を表示します。報告が無い間の活動は分からず、MCPアクセス履歴とは別の情報です。
            </p>

            {failed &&
                (snapshot.denied ? (
                    <AccessDenied reason={snapshot.message} />
                ) : (
                    <p className="text-[13px]">作業報告を取得できませんでした。{snapshot.message}</p>
                ))}
            {failed && listing && snapshot.listingFetchedAt && (
                <p className="mt-1 text-[11px] text-amber-400">
                    以下は {formatAideDateTime(snapshot.listingFetchedAt)} に取得できた値で、最新とは限りません。
                </p>
            )}

            {listing && listing.reportState === "none" && !failed && (
                <p className="text-xs text-muted-foreground">
                    まだ報告された作業がありません。これは「作業が無い」ことを意味しません（dotが報告していないだけの場合があります）。
                </p>
            )}

            {listing && listing.works.length > 0 && (
                <>
                    {listing.staleCount > 0 && (
                        <p className="mb-1 text-[11px] text-amber-400">
                            {listing.staleCount}件は最後の報告から{listing.staleAfterMinutes}分以上更新がありません。
                            終わったか止まったかは分からないため、状態は断定しません。
                        </p>
                    )}
                    <ul className="divide-y divide-border">
                        {listing.works.map((work) => (
                            <WorkRow key={work.workId} work={work} now={now} onSelect={() => setSelectedId(work.workId)} />
                        ))}
                    </ul>
                    {listing.total > listing.works.length && (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                            新しい順に{listing.works.length}件まで表示（全{listing.total}件）。
                        </p>
                    )}
                </>
            )}

            {selected && <WorkDetailModal work={selected} now={now} onClose={close} />}
        </Panel>
    )
}

function WorkRow({ work, now, onSelect }: { work: WorkReport; now: number; onSelect: () => void }) {
    const display = displayWork(work)
    // 一覧には短い1行だけ。長い内容は詳細で読む
    const summary = work.waitReason ?? work.resultSummary ?? work.progress
    return (
        <li>
            <button
                type="button"
                onClick={onSelect}
                className="flex w-full flex-col gap-px py-2 text-left active:bg-primary/10 focus-visible:bg-primary/10 focus-visible:outline-none"
            >
                <span className="flex items-center gap-2">
                    <span className="min-w-0 text-xs font-medium [overflow-wrap:anywhere]">{work.title}</span>
                    <span className="ml-auto shrink-0">
                        <StatusBadge tone={display.tone} withDot>
                            {display.label}
                        </StatusBadge>
                    </span>
                </span>
                {summary && (
                    <span className="line-clamp-2 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                        {display.stale ? `最後の報告（${WORK_STATUS_LABEL[work.status]}）: ` : ""}
                        {summary}
                    </span>
                )}
                <span className="text-[11px] tabular-nums text-muted-foreground">
                    最終報告 {formatAideLogTime(work.receivedAt, now)}（{ago(work.receivedAt, now)}）
                </span>
            </button>
        </li>
    )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">{children}</dd>
        </div>
    )
}

/**
 * 作業1件の詳細。タブ切り替えの transform の中では `fixed` が画面基準にならないため、
 * body 直下へ portal で出す（JobHistoryModal と同じ）。内容はすべてテキストとして描画する
 */
function WorkDetailModal({ work, now, onClose }: { work: WorkReport; now: number; onClose: () => void }) {
    const closeRef = useRef<HTMLButtonElement>(null)
    const display = displayWork(work)
    const links = work.links.map(safeLink).filter((link) => link !== null)

    useEffect(() => {
        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        closeRef.current?.focus()
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose()
        }
        document.addEventListener("keydown", onKeyDown)
        return () => {
            document.removeEventListener("keydown", onKeyDown)
            document.body.style.overflow = previousOverflow
            previouslyFocused?.focus()
        }
    }, [onClose])

    return createPortal(
        <div
            className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-5"
            onClick={onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`${work.title} の作業状況`}
                onClick={(event) => event.stopPropagation()}
                className="flex max-h-[82dvh] w-full max-w-[480px] flex-col overflow-hidden rounded-t-2xl border border-border bg-popover text-popover-foreground shadow-2xl sm:max-h-[min(80dvh,720px)] sm:rounded-2xl"
            >
                <div className="flex shrink-0 items-start gap-2.5 border-b border-border px-4 pb-3 pt-3.5">
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold [overflow-wrap:anywhere]">{work.title}</div>
                        <div className="mt-1">
                            <StatusBadge tone={display.tone} withDot>
                                {display.label}
                            </StatusBadge>
                        </div>
                    </div>
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={onClose}
                        aria-label="閉じる"
                        className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                    >
                        ✕
                    </button>
                </div>
                <dl className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
                    {display.stale && (
                        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-300">
                            最後の報告から {formatAideDuration(minutesSince(work.receivedAt, now))} 更新がありません。
                            最後に報告された状態は「{WORK_STATUS_LABEL[work.status]}」ですが、現在の状態は分かりません
                            （終わったとも失敗したとも判断していません）。
                        </p>
                    )}
                    <Field label="最後に報告された状態">{WORK_STATUS_LABEL[work.status]}</Field>
                    {work.progress && <Field label="進捗">{work.progress}</Field>}
                    {work.waitReason && <Field label="待機理由">{work.waitReason}</Field>}
                    {work.resultSummary && <Field label="結果">{work.resultSummary}</Field>}
                    {links.length > 0 && (
                        <Field label="関連リンク">
                            <ul className="space-y-1">
                                {links.map((link) => (
                                    <li key={link.href}>
                                        <a
                                            href={link.href}
                                            target="_blank"
                                            rel="noopener noreferrer nofollow"
                                            className="text-primary underline underline-offset-2"
                                        >
                                            {link.host}
                                        </a>{" "}
                                        <span className="text-[10px] text-muted-foreground">{link.href}</span>
                                    </li>
                                ))}
                            </ul>
                        </Field>
                    )}
                    <Field label="最終報告（AIDEの受信）">
                        {formatAideDateTime(work.receivedAt)}（{ago(work.receivedAt, now)}）
                    </Field>
                    <Field label="dotが申告した発生時刻">{formatAideDateTime(work.occurredAt)}</Field>
                    <Field label="作業ID・版">
                        <span className="font-mono">
                            {work.workId} · v{work.version}
                        </span>
                    </Field>
                </dl>
            </div>
        </div>,
        document.body
    )
}

/** AIDEタブ上部の「dotの作業状況」。取得元は DashboardDataProvider */
export function AideWorkReports() {
    const { aideWorkReports: snapshot, now } = useDashboardData()
    return <AideWorkReportsView snapshot={snapshot} now={now} />
}
