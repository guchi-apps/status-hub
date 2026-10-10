"use client"

import { RefreshCw } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { AideStatus } from "@/components/aide-status"
import { AiUsage } from "@/components/ai-usage"
import { AiAppUsage } from "@/components/ai-app-usage"
import { useDashboardData, type RefreshState } from "@/components/dashboard-data"
import { GitHubUsage } from "@/components/github-usage"
import { HeaderMenu } from "@/components/header-menu"
import { HostCard } from "@/components/host-card"
import { HostStats } from "@/components/host-stats"
import { useIncidentBadgeSync } from "@/components/incidents"
import { ModelPriceMenuItem } from "@/components/model-price-dialog"
import { MonitorSections } from "@/components/monitor-sections"
import { MonitorTiles, getMonitorStatusText } from "@/components/monitor-tiles"
import { OnePasswordUsage } from "@/components/onepassword-usage"
import { Panel } from "@/components/panel"
import { SkeletonBar, SkeletonGroup } from "@/components/skeleton"
import { StatusBadge, TEXT_TONES, type StatusTone } from "@/components/status-badge"
import { SwipeTabs } from "@/components/swipe-tabs"
import { TmuxLegend, TmuxSessionList, TmuxSessionTable } from "@/components/tmux-sessions"
import { Button } from "@/components/ui/button"
import { AiUsageCompact, GitHubUsageCompact } from "@/components/usage-compact"
import { UsageNotifications } from "@/components/usage-notifications"
import { AIDE_SEVERITY_TONE } from "@/lib/aide-status-format"
import { formatAge } from "@/lib/host-stats/format"
import { collectTmuxSessions, summarizeTmux } from "@/lib/host-stats/tmux"
import { cn } from "@/lib/utils"

/** 選んだタブは端末ごとに覚える。毎回「概要」に戻ると、見たい場所へ都度たどり直すことになる */
const ACTIVE_TAB_STORAGE_KEY = "ops-dashboard:active-tab"

type TabId = "overview" | "hosts" | "tmux" | "usage" | "monitors" | "aide"

/** AIDEはAIDEへの接続設定がある環境でだけ出す（DashboardShell の aideConfigured） */
const TAB_IDS: TabId[] = ["overview", "hosts", "tmux", "usage", "monitors", "aide"]

/**
 * 選択中のタブ。localStorage はサーバー側に無いため、外部ストアとして読む。
 * useState + useEffect で復元すると、初期HTMLと食い違ううえ余分な再描画を挟むことになる。
 */
const tabListeners = new Set<() => void>()

function subscribeActiveTab(listener: () => void): () => void {
    tabListeners.add(listener)
    return () => {
        tabListeners.delete(listener)
    }
}

function getStoredTab(): TabId {
    const stored = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY)
    return stored && TAB_IDS.includes(stored as TabId) ? (stored as TabId) : "overview"
}

/** サーバー側の描画では常に概要。端末に保存した選択はハイドレート後に反映される */
function getInitialTab(): TabId {
    return "overview"
}

function storeActiveTab(tab: TabId) {
    window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab)
    for (const listener of tabListeners) listener()
}

const TAB_LABELS: Record<TabId, string> = {
    overview: "概要",
    hosts: "ホスト",
    tmux: "tmux",
    usage: "AI・GitHub・1Password",
    monitors: "監視",
    aide: "AIDE",
}

/**
 * 狭い画面用の短い名前。長い名前のままだと5つのタブが画面に収まらず、
 * 右端の「監視」がスクロールしないと見えなくなる（#96）
 */
const TAB_SHORT_LABELS: Partial<Record<TabId, string>> = {
    usage: "利用枠",
}

/**
 * ヘッダーの更新時刻と更新ボタン。
 *
 * 押すとホスト・AI・GitHub・1Password・監視をまとめて取り直す。押した結果は時刻が進むことで分かるため、
 * 狭い画面でも時刻だけは出す（ボタンはアイコンのみにして幅を詰める）。
 * 通知の設定とログアウトはここに並べず、右隣のメニューへまとめてある（#268）。
 */
function RefreshControl({
    updatedAt,
    state,
    cooldownSeconds,
    onRefresh,
}: {
    updatedAt: number | null
    state: RefreshState
    cooldownSeconds: number
    onRefresh: () => void
}) {
    const time = updatedAt
        ? new Date(updatedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
        : null
    const busy = state === "refreshing"
    const failed = state === "error"

    const label = busy
        ? "更新中"
        : cooldownSeconds > 0
          ? `あと${cooldownSeconds}秒で更新できます`
          : "最新の状態に更新"

    return (
        <>
            {(time || failed) && (
                <span
                    aria-live="polite"
                    className={cn(
                        "font-mono text-[11px]",
                        failed ? "text-destructive" : "text-muted-foreground"
                    )}
                >
                    {failed ? (
                        <>
                            <span className="sm:hidden">更新できません</span>
                            <span className="hidden sm:inline">
                                更新できませんでした{time && `（${time} 時点の値）`}
                            </span>
                        </>
                    ) : (
                        `${time} 更新`
                    )}
                </span>
            )}
            <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={onRefresh}
                disabled={busy || cooldownSeconds > 0}
                aria-label={label}
                title={label}
                className="px-2 sm:px-3"
            >
                <RefreshCw
                    className={cn("size-3.5", busy && "animate-spin motion-reduce:animate-none")}
                    aria-hidden
                />
                <span className="hidden sm:inline">
                    {busy ? "更新中" : cooldownSeconds > 0 ? cooldownSeconds : "更新"}
                </span>
            </Button>
        </>
    )
}

export function DashboardShell({
    userEmail,
    isAdmin,
    addMonitorUrl,
    canAddMonitor,
    aideConfigured,
}: {
    userEmail: string
    /** 共通アクセス設定でStatusHubの管理者か（#489）。メニューに管理画面への行を出す */
    isAdmin: boolean
    addMonitorUrl: string | null
    /** Kumaの管理者認証情報が揃っていて、画面から直接モニターを登録できるか */
    canAddMonitor: boolean
    /** AIDEの動作状況を読むトークンがあるか。無ければAIDEタブを出さない */
    aideConfigured: boolean
}) {
    const data = useDashboardData()
    const {
        hostStats,
        aiUsage,
        githubUsage,
        uptimeKuma,
        uptimeRobot,
        aideStatus,
        now,
        updatedAt,
        refresh,
        refreshState,
        refreshCooldownSeconds,
    } = data

    // AIDEへの接続設定が無い環境ではタブごと出さない。端末に保存した選択がAIDEだった場合は概要へ戻す
    const tabIds = useMemo(
        () => (aideConfigured ? TAB_IDS : TAB_IDS.filter((tab) => tab !== "aide")),
        [aideConfigured]
    )
    useIncidentBadgeSync()
    const storedTab = useSyncExternalStore(subscribeActiveTab, getStoredTab, getInitialTab)
    const activeTab: TabId = tabIds.includes(storedTab) ? storedTab : "overview"

    // スワイプで切り替えたときにタブ帯が動かないと、いまどこにいるのかが分からなくなる（#136）
    const tabListRef = useRef<HTMLDivElement>(null)
    const activeIndex = tabIds.indexOf(activeTab)

    const goToTabAt = useCallback(
        (index: number) => {
            const tab = tabIds[index]
            if (tab) storeActiveTab(tab)
        },
        [tabIds]
    )

    const goPrevious = useCallback(() => goToTabAt(activeIndex - 1), [goToTabAt, activeIndex])
    const goNext = useCallback(() => goToTabAt(activeIndex + 1), [goToTabAt, activeIndex])

    // 通知をタップして開いたときは、通知が指したタブを出す（#263）。
    // アプリが閉じていれば `?tab=` 付きで開き、開いていればService Workerからメッセージで届く
    useEffect(() => {
        const openTab = (tab: unknown) => {
            if (typeof tab === "string" && tabIds.includes(tab as TabId)) storeActiveTab(tab as TabId)
        }

        const url = new URL(window.location.href)
        // `panel` は旧版の通知・リンクが付けていた（#559で一覧を削除）。値は見ず、URLから消すだけ
        if (url.searchParams.has("tab") || url.searchParams.has("panel")) {
            openTab(url.searchParams.get("tab"))
            url.searchParams.delete("tab")
            url.searchParams.delete("panel")
            window.history.replaceState(null, "", url.pathname + url.search + url.hash)
        }

        const onMessage = (event: MessageEvent) => {
            const data = event.data as { type?: string; tab?: unknown } | null
            if (data?.type === "open-tab") openTab(data.tab)
        }
        navigator.serviceWorker?.addEventListener("message", onMessage)
        return () => navigator.serviceWorker?.removeEventListener("message", onMessage)
    }, [tabIds])

    useEffect(() => {
        const list = tabListRef.current
        const button = list?.querySelector<HTMLElement>(`[data-tab-id="${activeTab}"]`)
        if (!list || !button) return

        // 選択中のタブが帯からはみ出していたら、少し余白を残して見える位置まで寄せる
        const listRect = list.getBoundingClientRect()
        const buttonRect = button.getBoundingClientRect()
        if (buttonRect.left < listRect.left) {
            list.scrollBy({ left: buttonRect.left - listRect.left - 16, behavior: "smooth" })
        } else if (buttonRect.right > listRect.right) {
            list.scrollBy({ left: buttonRect.right - listRect.right + 16, behavior: "smooth" })
        }
    }, [activeTab])

    const hosts = useMemo(() => hostStats?.hosts ?? [], [hostStats])
    const tmuxSessions = useMemo(() => collectTmuxSessions(hosts, now), [hosts, now])
    const tmuxSummary = useMemo(() => summarizeTmux(hosts, tmuxSessions), [hosts, tmuxSessions])
    const monitorStatus = getMonitorStatusText(uptimeKuma, uptimeRobot)

    const aideHealth = aideStatus?.status === "ok" ? aideStatus.health : null

    const counts: Partial<Record<TabId, number>> = {
        hosts: hosts.length,
        tmux: tmuxSummary.total,
        monitors: uptimeKuma.monitors.length + uptimeRobot.monitors.length,
        aide: aideHealth?.attention.length,
    }

    // AIDEの数字は総数ではなく注意・異常の件数なので、他のタブと違って状態の色を付ける
    const countTones: Partial<Record<TabId, StatusTone>> = {
        aide: aideHealth ? AIDE_SEVERITY_TONE[aideHealth.severity] : undefined,
        // 監視の取得が止まっているときは、件数が0でも見過ごさないよう色を付ける（#276）
        monitors: monitorStatus.failed ? "danger" : undefined,
    }

    // ホストが2台以上なら3列（ホスト・ホスト・tmux）、1台なら2列で割り付ける
    const hostSpan = hosts.length >= 2 ? "xl:col-span-4" : "xl:col-span-6"

    // 全体の高さは body 側の min-h-screen に任せる。
    // ここでも画面高を確保すると、フッターの分だけ必ずスクロールが出てしまう
    return (
        <div className="mx-auto w-full max-w-[1600px] px-3 pb-3 sm:px-5 sm:pb-4">
            {/* ヘッダーとタブ帯をまとめて画面上部に固定する（#382）。z-indexはHeaderMenuの
                ドロップダウン（z-50）より低くし、重なり順を崩さない */}
            <div className="sticky top-0 z-30 -mx-3 bg-background px-3 pt-3 sm:-mx-5 sm:px-5 sm:pt-4">
                <header className="mb-2.5 flex items-center gap-2 sm:gap-3">
                    <span className="h-5 w-1 shrink-0 rounded-full bg-highlight" aria-hidden />
                    <h1 className="shrink-0 text-base font-bold sm:text-lg">StatusHub</h1>
                    <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
                        <span className="hidden items-center gap-1.5 text-[9px] font-bold tracking-[0.16em] text-status-ok sm:inline-flex">
                            <span className="size-1.5 rounded-full bg-status-ok" aria-hidden />
                            LIVE
                        </span>
                        <RefreshControl
                            updatedAt={updatedAt}
                            state={refreshState}
                            cooldownSeconds={refreshCooldownSeconds}
                            onRefresh={refresh}
                        />
                        <HeaderMenu userEmail={userEmail} isAdmin={isAdmin}>
                            <ModelPriceMenuItem />
                            <UsageNotifications isAdmin={isAdmin} />
                        </HeaderMenu>
                    </div>
                </header>

                <div
                    ref={tabListRef}
                    role="tablist"
                    aria-label="表示の切り替え"
                    className="-mx-3 mb-2.5 mt-1.5 flex gap-1 overflow-x-auto border-b border-border px-3 sm:mx-0 sm:px-0"
                >
                    {tabIds.map((tab) => (
                        <button
                            key={tab}
                            type="button"
                            role="tab"
                            data-tab-id={tab}
                            aria-selected={activeTab === tab}
                            onClick={() => storeActiveTab(tab)}
                            className={cn(
                                "shrink-0 border-b-2 px-3 py-1.5 text-[13px] transition-colors",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                activeTab === tab
                                    ? "border-highlight font-bold text-foreground"
                                    : "border-transparent text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <span className="sm:hidden">{TAB_SHORT_LABELS[tab] ?? TAB_LABELS[tab]}</span>
                            <span className="hidden sm:inline">{TAB_LABELS[tab]}</span>
                            {counts[tab] !== undefined && counts[tab]! > 0 && (
                                <span
                                    className={cn(
                                        "ml-1.5 text-[10px]",
                                        countTones[tab]
                                            ? cn("font-bold", TEXT_TONES[countTones[tab]!])
                                            : "text-muted-foreground"
                                    )}
                                >
                                    {counts[tab]}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            </div>

            <SwipeTabs
                label={TAB_LABELS[activeTab]}
                contentKey={activeTab}
                canGoPrevious={activeIndex > 0}
                canGoNext={activeIndex < tabIds.length - 1}
                onPrevious={goPrevious}
                onNext={goNext}
            >
                {activeTab === "overview" && (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-12">
                        {hosts.map((host) => (
                            <div key={host.id} className={hostSpan}>
                                <HostCard host={host} historyHours={hostStats?.historyHours ?? 24} />
                            </div>
                        ))}

                        {tmuxSummary.available && (
                            <Panel
                                title="tmux セッション"
                                className={hosts.length >= 2 ? "xl:col-span-4" : "xl:col-span-6"}
                                trailing={
                                    <>
                                        <StatusBadge tone={tmuxSummary.running > 0 ? "ok" : "neutral"}>
                                            稼働 {tmuxSummary.running}
                                        </StatusBadge>
                                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                                            入力待ち {tmuxSummary.waiting} · 待機{" "}
                                            {tmuxSummary.idle + tmuxSummary.stale} · 全
                                            {tmuxSummary.total}件
                                            {/* 上限で届かなかった分は一覧に出せないので、内訳が合わない理由を書いておく */}
                                            {tmuxSummary.untracked > 0 &&
                                                `（うち ${tmuxSummary.untracked}件 未取得）`}
                                        </span>
                                    </>
                                }
                            >
                                <TmuxSessionList
                                    sessions={tmuxSessions}
                                    withHostLabel={
                                        new Set(tmuxSessions.map((session) => session.hostId)).size > 1
                                    }
                                />
                            </Panel>
                        )}

                        {!hostStats && (
                            <Panel title="ホスト" className={hostSpan}>
                                <SkeletonGroup label="ホストのメトリクス" className="space-y-3">
                                    <SkeletonBar />
                                    <SkeletonBar />
                                    <SkeletonBar />
                                </SkeletonGroup>
                            </Panel>
                        )}

                        {aiUsage ? (
                            <Panel
                                title="AI 使用状況"
                                className="xl:col-span-3"
                                trailing={
                                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                                        {new Date(aiUsage.fetchedAt).toLocaleTimeString("ja-JP", {
                                            hour: "2-digit",
                                            minute: "2-digit",
                                        })}{" "}
                                        時点
                                    </span>
                                }
                            >
                                <AiUsageCompact snapshot={aiUsage} now={now} />
                            </Panel>
                        ) : (
                            <Panel title="AI 使用状況" className="xl:col-span-3">
                                <SkeletonGroup label="AI使用状況" className="space-y-3">
                                    <SkeletonBar />
                                    <SkeletonBar />
                                </SkeletonGroup>
                            </Panel>
                        )}

                        {githubUsage?.status === "unconfigured" ? null : githubUsage ? (
                            <Panel
                                title="GitHub"
                                className="xl:col-span-3"
                                trailing={
                                    <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                                        {githubUsage.org ?? ""}
                                    </span>
                                }
                            >
                                <GitHubUsageCompact snapshot={githubUsage} now={now} />
                            </Panel>
                        ) : (
                            <Panel title="GitHub" className="xl:col-span-3">
                                <SkeletonGroup label="GitHub使用状況" className="space-y-3">
                                    <SkeletonBar />
                                    <SkeletonBar />
                                </SkeletonGroup>
                            </Panel>
                        )}

                        <Panel
                            title="監視"
                            className="md:col-span-2 xl:col-span-6"
                            trailing={
                                <>
                                    {monitorStatus.down > 0 && (
                                        <StatusBadge tone="danger">DOWN {monitorStatus.down}</StatusBadge>
                                    )}
                                    {monitorStatus.failed && (
                                        <StatusBadge tone="danger">取得不可</StatusBadge>
                                    )}
                                    {monitorStatus.text !== null && (
                                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                                            {monitorStatus.text}
                                        </span>
                                    )}
                                </>
                            }
                        >
                            <MonitorTiles kuma={uptimeKuma} robot={uptimeRobot} />
                        </Panel>
                    </div>
                )}

                {activeTab === "hosts" && (
                    <div className="space-y-5">
                        <HostStats />
                    </div>
                )}

                {activeTab === "tmux" && (
                    <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
                        <Panel
                            title="tmux セッション"
                            className="xl:col-span-2"
                            trailing={
                                <>
                                    <StatusBadge tone={tmuxSummary.running > 0 ? "ok" : "neutral"}>
                                        稼働 {tmuxSummary.running}
                                    </StatusBadge>
                                    {/*
                                        セッションを詳しく見る場所なので、総数まで出す（#61）。
                                        エージェントは送信を上限で打ち切るため、一覧の行数だけでは
                                        積み上がっていることに気づけない
                                    */}
                                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                                        入力待ち {tmuxSummary.waiting} · 待機 {tmuxSummary.idle} · 放置{" "}
                                        {tmuxSummary.stale} · 全{tmuxSummary.total}件
                                        {tmuxSummary.untracked > 0 &&
                                            `（うち ${tmuxSummary.untracked}件 未取得）`}
                                    </span>
                                </>
                            }
                        >
                            <TmuxSessionTable sessions={tmuxSessions} />
                            <div className="mt-3">
                                <TmuxLegend />
                            </div>
                        </Panel>

                        <Panel title="内訳">
                            <TmuxBreakdown sessions={tmuxSessions} hosts={hosts.map((host) => host.label)} />
                        </Panel>
                    </div>
                )}

                {activeTab === "usage" && (
                    <div className="space-y-5">
                        <AiUsage />
                        <AiAppUsage />
                        <GitHubUsage />
                        <OnePasswordUsage />
                    </div>
                )}

                {activeTab === "monitors" && (
                    <MonitorSections
                        addMonitorUrl={addMonitorUrl}
                        canAddMonitor={canAddMonitor}
                    />
                )}

                {activeTab === "aide" && <AideStatus />}
            </SwipeTabs>
        </div>
    )
}

/** tmuxタブの右側。ホスト別の内訳と、実行中コマンドの多い順を出す */
function TmuxBreakdown({
    sessions,
    hosts,
}: {
    sessions: ReturnType<typeof collectTmuxSessions>
    hosts: string[]
}) {
    const commandCounts = new Map<string, number>()
    for (const session of sessions) {
        for (const command of session.commands ?? []) {
            commandCounts.set(command, (commandCounts.get(command) ?? 0) + 1)
        }
    }

    const stale = sessions.filter((session) => session.state === "stale")

    return (
        <div className="space-y-3 text-[11px]">
            <div className="space-y-1">
                {hosts.map((host) => {
                    const forHost = sessions.filter((session) => session.hostLabel === host)
                    const running = forHost.filter((session) => session.state === "running").length
                    const waiting = forHost.filter((session) => session.state === "waiting").length

                    return (
                        <div key={host} className="flex items-baseline justify-between gap-2">
                            <span className="text-muted-foreground">{host}</span>
                            <span className="font-mono">
                                {forHost.length === 0
                                    ? "セッションなし"
                                    : `稼働 ${running} · 入力待ち ${waiting} · 待機 ${
                                          forHost.length - running - waiting
                                      }`}
                            </span>
                        </div>
                    )
                })}
            </div>

            {commandCounts.size > 0 && (
                <div className="border-t border-border pt-2.5">
                    <div className="mb-1.5 text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                        実行中コマンド
                    </div>
                    <div className="space-y-1">
                        {[...commandCounts.entries()]
                            .sort((a, b) => b[1] - a[1])
                            .map(([command, count]) => (
                                <div key={command} className="flex items-baseline justify-between gap-2">
                                    <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[9px]">
                                        {command}
                                    </span>
                                    <span className="font-mono text-muted-foreground">
                                        {count}セッション
                                    </span>
                                </div>
                            ))}
                    </div>
                </div>
            )}

            <div className="border-t border-border pt-2.5">
                <div className="mb-1.5 text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                    放置しているセッション
                </div>
                {stale.length === 0 ? (
                    <p className="text-muted-foreground">ありません</p>
                ) : (
                    <div className="space-y-1">
                        {stale.map((session) => (
                            <div
                                key={`${session.hostId}/${session.name}`}
                                className="flex items-baseline justify-between gap-2"
                            >
                                <span className="min-w-0 truncate font-mono">{session.name}</span>
                                <span className="shrink-0 font-mono text-amber-400">
                                    {session.inactiveSeconds !== undefined
                                        ? formatAge(session.inactiveSeconds)
                                        : "-"}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
