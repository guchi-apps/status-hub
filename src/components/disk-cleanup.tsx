"use client"

import { useState } from "react"
import { useDashboardData } from "@/components/dashboard-data"
import { CSRF_HEADERS } from "@/lib/csrf-headers"
import { CLEANUP_TARGETS, type CleanupTargetInfo } from "@/lib/host-stats/cleanup-targets"
import { formatAge, formatBytes } from "@/lib/host-stats/format"
import { isStaleTmuxSession } from "@/lib/host-stats/tmux"
import { cn } from "@/lib/utils"
import type {
    HostCleanupPending,
    HostCleanupTargetId,
    HostStatsCleanupRun,
    HostStatsCleanupTarget,
    HostStatsHostView,
} from "@/types/host-stats"

/** tmux の閉じる依頼を出してから、消えなければ「閉じられなかった」とみなすまでの時間（tmux 一覧と同じ） */
const TMUX_CLOSE_TIMEOUT_MS = 180_000

/** 押した直後の画面だけの記録。サーバーの依頼一覧に載るまでのつなぎと、送信の失敗を出す */
interface LocalRequest {
    at: number
    sending?: boolean
    error?: string
}

type RowState =
    | { kind: "idle" }
    | { kind: "confirming" }
    | { kind: "sending" }
    | { kind: "queued" }
    | { kind: "running" }
    | { kind: "failed"; message: string }

interface Row {
    info: CleanupTargetInfo
    target: HostStatsCleanupTarget
    /** 容量の列。容量が無い対象（tmux）は件数で出す */
    size: { value: string; note?: string }
    /** これ以上消せるものが無い（放置セッションが0件など） */
    empty: boolean
}

function elapsedSeconds(iso: string | undefined, now: number): number | undefined {
    if (!iso) return undefined
    const time = Date.parse(iso)
    return Number.isNaN(time) ? undefined : Math.max(0, Math.floor((now - time) / 1000))
}

/** 前回の結果の1行。実行中・依頼中は状態の列で出すため、ここでは終わったものだけ */
function lastRunText(run: HostStatsCleanupRun | undefined, now: number): { text: string; failed: boolean } | null {
    if (!run || run.status === "running") return null
    const age = elapsedSeconds(run.finishedAt, now)
    const when = age === undefined ? "" : ` · ${formatAge(age)}`

    if (run.status === "failed") {
        return { text: `前回は失敗${run.message ? `（${run.message}）` : ""}${when}`, failed: true }
    }
    const parts = [run.freedBytes !== undefined ? `${formatBytes(run.freedBytes)} 解放` : "完了"]
    if (run.count !== undefined) parts.push(`${run.count.toLocaleString("ja-JP")}件`)
    return { text: `前回 ${parts.join(" · ")}${when}`, failed: false }
}

function stateOf(
    id: HostCleanupTargetId,
    {
        local,
        pending,
        run,
        confirmId,
        staleCount,
        hiddenCount,
        now,
    }: {
        local: LocalRequest | undefined
        pending: HostCleanupPending | undefined
        run: HostStatsCleanupRun | undefined
        confirmId: HostCleanupTargetId | null
        staleCount: number
        hiddenCount: number
        now: number
    }
): RowState {
    if (local?.sending) return { kind: "sending" }
    if (local?.error) return { kind: "failed", message: local.error }

    if (id === "tmux-stale") {
        // 完了の通知は無いので、放置セッションが一覧から消えたことで判断する（tmux 一覧と同じ）
        if (local && staleCount > 0) {
            if (now - local.at > TMUX_CLOSE_TIMEOUT_MS) {
                return { kind: "failed", message: "閉じられませんでした。ホストのエージェントが止まっている可能性があります" }
            }
            return { kind: "running" }
        }
        // 一覧に載らない分は、閉じ終わったか画面から分からない。閉じられなかったとは断定せず、待つだけにする
        if (local && hiddenCount > 0 && now - local.at <= TMUX_CLOSE_TIMEOUT_MS) return { kind: "running" }
    } else {
        if (run?.status === "running" && (!pending || run.requestedAt === pending.requestedAt)) return { kind: "running" }
        if (pending) return { kind: "queued" }
    }

    return confirmId === id ? { kind: "confirming" } : { kind: "idle" }
}

const SPINNER = (
    <span
        aria-hidden
        className="inline-block size-2.5 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
    />
)

function StatusText({ state }: { state: RowState }) {
    switch (state.kind) {
        case "sending":
            return <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">{SPINNER}依頼しています…</span>
        case "queued":
            return <span className="inline-flex items-center gap-1.5 text-[11px] text-sky-300">{SPINNER}実行待ち（次の送信で開始）</span>
        case "running":
            return <span className="inline-flex items-center gap-1.5 text-[11px] text-sky-300">{SPINNER}実行中…</span>
        default:
            return null
    }
}

const BUTTON_CLASS =
    "rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
const DANGER_BUTTON_CLASS = cn(BUTTON_CLASS, "border-red-900 bg-red-950/60 text-red-200 hover:bg-red-900/60")
const PLAIN_BUTTON_CLASS = cn(BUTTON_CLASS, "border-border bg-muted text-foreground hover:bg-accent")

/**
 * ディスクの掃除（#657）。ディスク詳細の「Disk · 場所別」の下に置く。
 *
 * エージェントが掃除できる対象（`cleanup`）を送ってくるホストだけに出す。押すと行の中で確認し、
 * もう一度押すと依頼する。実行するのはホストのエージェントで、依頼は次の受信の応答で渡る（最大1分ほど）。
 */
export function DiskCleanup({ host }: { host: HostStatsHostView }) {
    const cleanup = host.latest.cleanup
    if (!cleanup || cleanup.targets.length === 0) return null
    return <DiskCleanupBody host={host} />
}

function DiskCleanupBody({ host }: { host: HostStatsHostView }) {
    const { now, refreshHostStats } = useDashboardData()
    const [confirmId, setConfirmId] = useState<HostCleanupTargetId | null>(null)
    const [local, setLocal] = useState<Partial<Record<HostCleanupTargetId, LocalRequest>>>({})

    const cleanup = host.latest.cleanup!
    const staleCount = (host.latest.tmuxSessions ?? []).filter(
        (session) => session.user !== undefined && isStaleTmuxSession(session, now)
    ).length
    // 送信上限で一覧に載らなかった分。放置かどうかは分からないが、依頼はエージェントが全件を見て閉じる
    const hiddenCount = Math.max(
        0,
        (host.latest.tmuxSessionTotal ?? (host.latest.tmuxSessions ?? []).length) -
            (host.latest.tmuxSessions ?? []).length
    )

    const rows: Row[] = CLEANUP_TARGETS.flatMap((info) => {
        const target = cleanup.targets.find((entry) => entry.id === info.id)
        if (!target) return []

        if (info.id === "tmux-stale") {
            return [
                {
                    info,
                    target,
                    size: {
                        value: `${staleCount}件`,
                        note: hiddenCount > 0 ? `放置 · 一覧外に${hiddenCount}件` : "放置",
                    },
                    empty: staleCount === 0 && hiddenCount === 0,
                },
            ]
        }
        const size =
            target.bytes === null
                ? { value: "—", note: info.id === "worktrees" ? "実行後に表示" : "未計測" }
                : {
                      value: formatBytes(target.bytes),
                      note: target.count === null ? undefined : `${target.count.toLocaleString("ja-JP")}件`,
                  }
        return [{ info, target, size, empty: target.bytes === 0 }]
    })

    const reclaimable = rows.reduce((sum, row) => sum + (row.target.bytes ?? 0), 0)
    const measuredAge = elapsedSeconds(cleanup.measuredAt, now)

    async function request(id: HostCleanupTargetId) {
        setConfirmId(null)
        setLocal((current) => ({ ...current, [id]: { at: Date.now(), sending: true } }))

        try {
            const response = await fetch("/api/host-cleanup", {
                method: "POST",
                headers: { "Content-Type": "application/json", ...CSRF_HEADERS },
                body: JSON.stringify({ hostId: host.id, target: id }),
            })
            if (!response.ok) {
                const body = (await response.json().catch(() => null)) as { error?: string } | null
                throw new Error(body?.error ?? `HTTP ${response.status}`)
            }
            // tmux は放置セッションが消えるまで画面だけで追う。他はサーバーの依頼一覧（cleanupPending）が引き継ぐ
            await refreshHostStats()
            setLocal((current) => {
                const rest = { ...current }
                if (id === "tmux-stale") rest[id] = { at: Date.now() }
                else delete rest[id]
                return rest
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : "依頼を送れませんでした"
            setLocal((current) => ({ ...current, [id]: { at: Date.now(), error: message } }))
        }
    }

    function ask(id: HostCleanupTargetId) {
        // 失敗の表示から押し直したときは、前回の記録を捨てて確認からやり直す
        setLocal((current) => {
            const rest = { ...current }
            delete rest[id]
            return rest
        })
        setConfirmId(id)
    }

    return (
        <div className="space-y-3 border-t border-border pt-4">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">掃除</span>
                {reclaimable > 0 && (
                    <span className="text-[11px] text-muted-foreground">消せる見込み 約 {formatBytes(reclaimable)}</span>
                )}
            </div>
            <ul className="overflow-hidden rounded-lg border border-border">
                {rows.map((row) => {
                    const id = row.info.id
                    const pending = host.cleanupPending?.find((entry) => entry.target === id)
                    const state = stateOf(id, {
                        local: local[id],
                        pending,
                        run: row.target.lastRun,
                        confirmId,
                        staleCount,
                        hiddenCount,
                        now,
                    })
                    const last = id === "tmux-stale" ? null : lastRunText(row.target.lastRun, now)
                    const busy = state.kind === "sending" || state.kind === "queued" || state.kind === "running"

                    return (
                        <li
                            key={id}
                            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 border-t border-border px-3 py-2.5 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_5.5rem_8rem] sm:items-center"
                        >
                            <div className="min-w-0">
                                <div className="text-[13px] font-semibold">{row.info.label}</div>
                                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{row.info.description}</p>
                                {row.info.location && (
                                    <p className="truncate font-mono text-[10.5px] text-muted-foreground/85">{row.info.location}</p>
                                )}
                                {last && (
                                    <p className={cn("mt-0.5 text-[11px]", last.failed ? "text-red-400" : "text-status-ok")}>
                                        {last.failed ? "✕ " : "✓ "}
                                        {last.text}
                                    </p>
                                )}
                            </div>
                            <div className="text-right font-mono text-[13px]">
                                {row.size.value}
                                {row.size.note && (
                                    <span className="block font-sans text-[10px] text-muted-foreground">{row.size.note}</span>
                                )}
                            </div>
                            <div className="col-span-2 flex justify-start sm:col-span-1 sm:justify-end">
                                {busy ? (
                                    <StatusText state={state} />
                                ) : (
                                    <button
                                        type="button"
                                        className={id === "tmux-stale" ? PLAIN_BUTTON_CLASS : DANGER_BUTTON_CLASS}
                                        disabled={row.empty || state.kind === "confirming"}
                                        onClick={() => ask(id)}
                                    >
                                        {id === "tmux-stale" ? "まとめて閉じる" : "削除する"}
                                    </button>
                                )}
                            </div>
                            {state.kind === "confirming" && (
                                <div
                                    role="alertdialog"
                                    aria-label={`${row.info.label}の確認`}
                                    className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs leading-relaxed"
                                >
                                    <span className="min-w-0 flex-[1_1_16rem]">
                                        {row.info.confirm}
                                        {row.target.bytes !== null && row.target.bytes > 0 && `（約 ${formatBytes(row.target.bytes)}）`}
                                    </span>
                                    <button type="button" className={PLAIN_BUTTON_CLASS} onClick={() => setConfirmId(null)}>
                                        やめる
                                    </button>
                                    <button type="button" className={DANGER_BUTTON_CLASS} onClick={() => void request(id)}>
                                        {id === "tmux-stale" ? "閉じる" : "削除を実行"}
                                    </button>
                                </div>
                            )}
                            {state.kind === "failed" && (
                                <p className="col-span-full text-[11px] text-red-400">✕ {state.message}</p>
                            )}
                        </li>
                    )
                })}
            </ul>
            <p className="border-t border-border pt-2.5 text-[10px] text-muted-foreground sm:text-[11px]">
                容量は{measuredAge === undefined ? "" : `${formatAge(measuredAge)}の`}計測値（1時間ごと）。実行はホストのエージェントが次の送信（約1分以内）で受け取り、終わると結果がこの欄に出ます。
                対象と消し方はエージェント側で固定してあり、画面からパスは指定できません。
            </p>
        </div>
    )
}
