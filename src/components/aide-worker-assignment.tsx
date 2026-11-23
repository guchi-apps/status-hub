"use client"

import { useState } from "react"
import { Panel } from "@/components/panel"
import { StatusBadge, StatusDot } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { formatAideDateTime, formatAideDuration } from "@/lib/aide-status-format"
import {
    ASSIGNMENT_MODES,
    ASSIGNMENT_MODE_LABEL,
    PRIMARY_WORKER_HOST,
    SWITCH_REASON_LABEL,
    WORKER_HOST_LABEL,
    continuousMinutes,
    hostOutlook,
    lastSeenMinutes,
} from "@/lib/aide-worker-assignment"
import { CSRF_HEADERS } from "@/lib/csrf-headers"
import { cn } from "@/lib/utils"
import type {
    AideAssignmentMode,
    AideWorkerAssignment,
    AideWorkerAssignmentSnapshot,
    AideWorkerHostView,
} from "@/types/aide-status"

/**
 * 定期ジョブの担当ホスト（#668。AIDE側は guchi-apps/aide#891）。
 *
 * 状態の正はAIDEにあり、ここは `/api/aide-status` に載ってくる値を出すだけ。切り替えは管理者だけが
 * `POST /api/aide-status/worker-assignment` 経由でAIDEへ送る。**固定中は解除し忘れに気づけるよう、
 * パネルを橙で縁取り、タブ帯にも「固定」を出す**（dashboard-shell.tsx）。
 */

/** 切り替えの操作を出せるか。管理者でない・切り替え用トークンが無いときは理由の注記だけを出す */
export type WorkerSwitchAvailability = "available" | "not-admin" | "unconfigured"

function modeTone(mode: AideAssignmentMode): "ok" | "warn" {
    return mode === "auto" ? "ok" : "warn"
}

function describeMinutes(minutes: number | null): string {
    return minutes === null ? "—" : formatAideDuration(minutes)
}

function HostCard({
    assignment,
    host,
    now,
}: {
    assignment: AideWorkerAssignment
    host: AideWorkerHostView
    now: number
}) {
    const isOwner = host.host === assignment.owner
    const outlook = hostOutlook(assignment, host, now)
    const silent = lastSeenMinutes(host, now)
    return (
        <div
            className={cn(
                "rounded-lg border px-2.5 py-2",
                isOwner ? "border-highlight shadow-[inset_0_0_0_1px] shadow-highlight/35" : "border-border"
            )}
        >
            <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-bold">
                <StatusDot tone={host.alive ? "ok" : "danger"} />
                {WORKER_HOST_LABEL[host.host]}
                {isOwner && <StatusBadge tone="info">担当</StatusBadge>}
                {!host.alive && <StatusBadge tone="danger">応答なし</StatusBadge>}
                <StatusBadge tone="neutral" className="ml-auto">
                    {host.host === PRIMARY_WORKER_HOST ? "主" : "予備"}
                </StatusBadge>
            </div>
            <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 text-[11px]">
                <dt className="text-muted-foreground">最終問い合わせ</dt>
                <dd className="tabular-nums">
                    {host.lastSeenAt
                        ? `${describeMinutes(silent)}前（${formatAideDateTime(host.lastSeenAt)}）`
                        : "記録なし"}
                </dd>
                <dt className="text-muted-foreground">連続稼働</dt>
                <dd className="tabular-nums">{describeMinutes(continuousMinutes(host, now))}</dd>
            </dl>
            {outlook.progress !== null && (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <div
                        className={cn(
                            "h-full rounded-full",
                            outlook.tone === "ok"
                                ? "bg-status-ok"
                                : outlook.tone === "warn"
                                  ? "bg-amber-500"
                                  : "bg-red-500"
                        )}
                        style={{ width: `${Math.round(outlook.progress * 100)}%` }}
                    />
                </div>
            )}
            <p className={cn("text-[10px] text-muted-foreground", outlook.progress === null ? "mt-2" : "mt-1")}>
                {outlook.text}
            </p>
        </div>
    )
}

/** モード変更の確認文。固定は解除するまで続くこと、自動へ戻すときはすぐには戻らないことを先に伝える */
function confirmText(assignment: AideWorkerAssignment, mode: AideAssignmentMode): string {
    if (mode === "auto") {
        const primary = WORKER_HOST_LABEL[PRIMARY_WORKER_HOST]
        if (assignment.owner === PRIMARY_WORKER_HOST) {
            return `担当は${primary}のまま、止まったら自動で引き継ぐ状態に戻ります。`
        }
        return `担当はいったん${WORKER_HOST_LABEL[assignment.owner]}のまま据え置き、${primary}の問い合わせが${assignment.policy.failbackAfterMinutes}分続いたら${primary}へ戻ります。`
    }
    const other = WORKER_HOST_LABEL[mode === "subpc" ? "macmini" : "subpc"]
    return `担当を${WORKER_HOST_LABEL[mode]}にします。解除するまで自動では切り替わらず、${other}のジョブは見送られます。`
}

function ModeSwitcher({
    assignment,
    onChanged,
}: {
    assignment: AideWorkerAssignment
    onChanged: (assignment: AideWorkerAssignment) => void
}) {
    const [pending, setPending] = useState<AideAssignmentMode | null>(null)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const submit = async (mode: AideAssignmentMode) => {
        setSending(true)
        setError(null)
        try {
            const res = await fetch("/api/aide-status/worker-assignment", {
                method: "POST",
                headers: { "Content-Type": "application/json", ...CSRF_HEADERS },
                body: JSON.stringify({ mode }),
            })
            const payload = (await res.json().catch(() => null)) as
                | { assignment?: AideWorkerAssignment; error?: string }
                | null
            if (!res.ok || !payload?.assignment) {
                setError(payload?.error ?? `切り替えに失敗しました（${res.status}）`)
                return
            }
            setPending(null)
            onChanged(payload.assignment)
        } catch {
            setError("切り替えに失敗しました（接続できません）")
        } finally {
            setSending(false)
        }
    }

    return (
        <div className="mt-2">
            <div
                role="group"
                aria-label="担当ホストの決め方"
                className="flex overflow-hidden rounded-lg border border-border sm:inline-flex"
            >
                {ASSIGNMENT_MODES.map((mode) => {
                    const active = assignment.mode === mode
                    return (
                        <button
                            key={mode}
                            type="button"
                            aria-pressed={active}
                            disabled={sending}
                            onClick={() => {
                                setError(null)
                                setPending(active ? null : mode)
                            }}
                            className={cn(
                                "flex-1 border-r border-border px-2 py-2 text-xs last:border-r-0 sm:flex-none sm:px-3 sm:py-1.5",
                                active
                                    ? mode === "auto"
                                        ? "bg-highlight font-bold text-highlight-foreground"
                                        : "bg-amber-500 font-bold text-amber-950"
                                    : pending === mode
                                      ? "bg-muted text-foreground"
                                      : "text-muted-foreground hover:bg-muted/60"
                            )}
                        >
                            {ASSIGNMENT_MODE_LABEL[mode]}
                        </button>
                    )
                })}
            </div>
            {pending && (
                <div className="mt-2 rounded-lg border border-border bg-muted/60 px-2.5 py-2 text-xs">
                    <p className="font-bold">「{ASSIGNMENT_MODE_LABEL[pending]}」に切り替えますか？</p>
                    <p className="mt-0.5 text-muted-foreground">{confirmText(assignment, pending)}</p>
                    {error && <p className="mt-1 text-red-300">{error}</p>}
                    <div className="mt-2 flex gap-1.5">
                        <Button size="sm" disabled={sending} onClick={() => submit(pending)}>
                            {sending ? "切り替え中…" : "切り替える"}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={sending}
                            onClick={() => {
                                setPending(null)
                                setError(null)
                            }}
                        >
                            やめる
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}

export function AideWorkerAssignmentPanel({
    snapshot,
    now,
    availability,
    className,
}: {
    snapshot: AideWorkerAssignmentSnapshot
    now: number
    availability: WorkerSwitchAvailability
    className?: string
}) {
    // 切り替えた直後は、次のポーリングを待たずAIDEが返した結果を出す。
    // 取得し直した値（assignmentFetchedAt が進んだ値）が届いたらそちらへ戻す
    const [override, setOverride] = useState<{ assignment: AideWorkerAssignment; basedOn: string | null } | null>(
        null
    )
    const assignment =
        override && override.basedOn === snapshot.assignmentFetchedAt ? override.assignment : snapshot.assignment

    if (!assignment) {
        return (
            <Panel
                title="定期ジョブの担当ホスト"
                className={className}
                trailing={<StatusBadge tone="danger">取得不可</StatusBadge>}
            >
                <p className="text-xs text-muted-foreground">{snapshot.message ?? "担当ホストを取得できませんでした"}</p>
            </Panel>
        )
    }

    const fixed = assignment.mode !== "auto"
    const lastSwitch = assignment.lastSwitch

    return (
        <Panel
            title="定期ジョブの担当ホスト"
            className={cn(fixed && "border-amber-500/55", className)}
            trailing={
                <>
                    <StatusBadge tone={modeTone(assignment.mode)} withDot>
                        {ASSIGNMENT_MODE_LABEL[assignment.mode]}
                    </StatusBadge>
                    {snapshot.status === "error" && <StatusBadge tone="danger">取得不可</StatusBadge>}
                    {snapshot.assignmentFetchedAt && (
                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                            取得 {formatAideDateTime(snapshot.assignmentFetchedAt)}
                        </span>
                    )}
                </>
            }
        >
            {snapshot.status === "error" && (
                <p className="mb-2 rounded-lg border-l-[3px] border-l-red-500 bg-red-500/10 px-2.5 py-1.5 text-xs">
                    {snapshot.message}（直前に取得できた状態を表示しています）
                </p>
            )}
            <p className="text-lg font-bold leading-snug md:text-xl">
                {WORKER_HOST_LABEL[assignment.owner]} が担当中
            </p>
            {fixed && (
                <div className="my-2 rounded-lg border-l-[3px] border-l-amber-500 bg-amber-500/10 px-2.5 py-2 text-[13px]">
                    <b>
                        固定中です
                        {assignment.modeChangedAt && `（${formatAideDateTime(assignment.modeChangedAt)} から）`}。
                    </b>
                    解除するまで自動では切り替わりません。
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        作業が終わったら「自動」に戻してください。
                    </span>
                </div>
            )}
            <p className="font-mono text-[11px] text-muted-foreground">
                {lastSwitch
                    ? `最後の切り替え ${formatAideDateTime(lastSwitch.at)}（${SWITCH_REASON_LABEL[lastSwitch.reason]}：${WORKER_HOST_LABEL[lastSwitch.from]} → ${WORKER_HOST_LABEL[lastSwitch.to]}）`
                    : "切り替えの記録はありません"}
            </p>
            {availability === "available" && (
                <ModeSwitcher
                    // 状態が変わったら開いていた確認を閉じる
                    key={`${assignment.mode}:${assignment.owner}`}
                    assignment={assignment}
                    onChanged={(next) => setOverride({ assignment: next, basedOn: snapshot.assignmentFetchedAt })}
                />
            )}
            <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {assignment.hosts.map((host) => (
                    <HostCard key={host.host} assignment={assignment} host={host} now={now} />
                ))}
            </div>
            <p className="mt-2.5 border-t border-border pt-2 text-[11px] text-muted-foreground">
                自動: 担当ホストの問い合わせが{assignment.policy.failoverAfterMinutes}分途切れ、もう一方が動いていれば移ります。
                {WORKER_HOST_LABEL[PRIMARY_WORKER_HOST]}の問い合わせが{assignment.policy.failbackAfterMinutes}分続いたら戻ります。
                {availability === "not-admin" && " 担当の切り替えは管理者だけが行えます。"}
                {availability === "unconfigured" && " 切り替え用のトークン（AIDE_WORKER_CONTROL_TOKEN）が未設定のため、ここからは切り替えられません。"}
            </p>
        </Panel>
    )
}
