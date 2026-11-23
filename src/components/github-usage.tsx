"use client"

import { useState } from "react"
import { Lock } from "lucide-react"
import { useDashboardData } from "@/components/dashboard-data"
import { DashboardCard } from "@/components/dashboard-card"
import { AccessDenied, SkeletonBar, SkeletonGroup } from "@/components/skeleton"
import { SectionHeading } from "@/components/section-heading"
import { SECTION_ANCHORS } from "@/lib/section-anchors"
import { UsageBar } from "@/components/usage-bar"
import {
    formatRemaining,
    getActionsUsedPercent,
    getElapsedPercent,
    getRateLimitUsedPercent,
} from "@/lib/usage-format"
import type { GitHubActionsUsage, GitHubAppRateLimits, GitHubRateLimit } from "@/types/github-usage"

/** レート制限の枠の長さ（1時間）。経過位置の目印を出すのに使う */
const RATE_LIMIT_WINDOW_MS = 3_600_000

/** 内訳を並べるリポジトリ数の初期表示件数。これを超えた分は「他N件」ボタンを押すと開く */
const MAX_LISTED_REPOSITORIES = 6

function formatNumber(value: number): string {
    return value.toLocaleString("ja-JP")
}

function CardHeader({ title, badge }: { title: string; badge?: string }) {
    return (
        <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm sm:text-base font-bold">{title}</span>
            {badge && (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] sm:text-xs font-semibold">
                    {badge}
                </span>
            )}
        </div>
    )
}

/** 緑＝上の「無料枠」バーと同じ、無料枠を消費した分。控えめな色＝公開リポジトリの分（カウントしない） */
function RepositoryLegend() {
    return (
        <div className="flex flex-wrap gap-x-3 text-[9px] leading-relaxed text-muted-foreground sm:text-[10px]">
            <span className="inline-flex items-center gap-1">
                <span className="size-2 rounded-[2px] bg-status-ok" aria-hidden />
                無料枠
            </span>
            <span className="inline-flex items-center gap-1">
                <span className="size-2 rounded-[2px] bg-border" aria-hidden />
                公開リポジトリはカウントしない
            </span>
            <span className="inline-flex items-center gap-1">
                <Lock className="size-2.5" aria-hidden />
                非公開
            </span>
        </div>
    )
}

function CardFooter({ rows }: { rows: { label: string; value: string }[] }) {
    return (
        <div className="mt-auto space-y-0.5 border-t border-border pt-2 text-[10px] sm:text-xs text-muted-foreground">
            {rows.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-2">
                    <span>{row.label}</span>
                    <span className="font-mono">{row.value}</span>
                </div>
            ))}
        </div>
    )
}

function RepositoryBreakdown({ actions }: { actions: GitHubActionsUsage }) {
    const [expanded, setExpanded] = useState(false)
    const listed = expanded ? actions.repositories : actions.repositories.slice(0, MAX_LISTED_REPOSITORIES)
    const hiddenCount = actions.repositories.length - Math.min(actions.repositories.length, MAX_LISTED_REPOSITORIES)
    // repositories は実行時間の多い順（src/lib/github-usage.ts）なので先頭が最大値
    const largestMinutes = actions.repositories[0]?.minutes ?? 0

    return (
        <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs sm:text-sm font-medium">今月の実行時間</span>
                <span className="whitespace-nowrap font-mono text-sm sm:text-base font-bold">
                    {formatNumber(actions.totalMinutes)}分
                </span>
            </div>

            {actions.repositories.length === 0 ? (
                <p className="text-[10px] sm:text-xs text-muted-foreground">
                    今月はまだ実行されていません
                </p>
            ) : (
                <>
                    <p className="text-[10px] sm:text-xs text-muted-foreground">
                        公開リポジトリのActionsは無制限に無料。無料枠を消費するのは非公開だった期間の分だけ
                    </p>
                    <RepositoryLegend />
                    <ul className="space-y-1 text-[10px] sm:text-xs">
                        {listed.map((repo) => (
                            <li key={repo.name} className="flex items-center gap-2">
                                <span
                                    className="inline-flex min-w-0 flex-1 items-center gap-1 truncate"
                                    aria-label={repo.isPrivate ? `${repo.name}（非公開）` : repo.name}
                                >
                                    {repo.isPrivate && (
                                        <Lock className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                                    )}
                                    <span className="truncate">{repo.name}</span>
                                </span>
                                <span className="flex h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-muted sm:w-16">
                                    <span
                                        className="block h-full bg-status-ok"
                                        style={{
                                            width: `${largestMinutes > 0 ? (repo.allowanceMinutes / largestMinutes) * 100 : 0}%`,
                                        }}
                                    />
                                    <span
                                        className="block h-full bg-border"
                                        style={{
                                            width: `${
                                                largestMinutes > 0
                                                    ? ((repo.minutes - repo.allowanceMinutes) / largestMinutes) * 100
                                                    : 0
                                            }%`,
                                        }}
                                    />
                                </span>
                                <span className="w-14 shrink-0 whitespace-nowrap text-right font-mono sm:w-16">
                                    {formatNumber(repo.minutes)}分
                                </span>
                            </li>
                        ))}
                    </ul>
                    {hiddenCount > 0 && (
                        <button
                            type="button"
                            onClick={() => setExpanded((value) => !value)}
                            className="rounded-full border border-border px-3 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                        >
                            {expanded ? "閉じる" : `他 ${hiddenCount} リポジトリを表示`}
                        </button>
                    )}
                </>
            )}
        </div>
    )
}

function ActionsCard({ actions, now }: { actions: GitHubActionsUsage; now: number }) {
    const usedPercent = getActionsUsedPercent(actions)

    const period = new Date(actions.periodStartsAt).toLocaleDateString("ja-JP", {
        year: "numeric",
        month: "long",
        timeZone: "UTC",
    })

    return (
        <DashboardCard className="h-full flex flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4">
            <CardHeader title="Actions" badge={period} />

            <UsageBar
                label="無料枠"
                usedPercent={usedPercent}
                elapsedPercent={getElapsedPercent(
                    new Date(actions.periodStartsAt).getTime(),
                    new Date(actions.resetsAt).getTime(),
                    now
                )}
                valueText={`残り ${formatNumber(
                    Math.max(0, actions.allowanceLimitMinutes - actions.allowanceMinutes)
                )}分`}
                usedText={`使用 ${formatNumber(actions.allowanceMinutes)} / ${formatNumber(
                    actions.allowanceLimitMinutes
                )}分`}
                remainingText={formatRemaining(actions.resetsAt, now)}
            />

            <RepositoryBreakdown actions={actions} />

            <CardFooter
                rows={[
                    // GitHubの課金画面と同じ「消費額 − 割引額 ＝ 課金額」を並べる
                    { label: "消費額", value: `$${actions.grossAmountUsd.toFixed(2)}` },
                    { label: "割引額", value: `-$${actions.discountAmountUsd.toFixed(2)}` },
                    { label: "今月の課金額", value: `$${actions.netAmountUsd.toFixed(2)}` },
                    // 無料枠は容量(MB)で決まるため割合は出せず、消費量の実績だけを添える
                    { label: "ストレージ", value: `${actions.storageGigabyteHours} GB時間` },
                ]}
            />
        </DashboardCard>
    )
}

function RateLimitCard({ rateLimit, now }: { rateLimit: GitHubRateLimit; now: number }) {
    const usedPercent = getRateLimitUsedPercent(rateLimit)
    const resetsAtMs = new Date(rateLimit.resetsAt).getTime()

    return (
        <DashboardCard className="h-full flex flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4">
            <CardHeader title="API レート制限（PAT・個人の枠）" badge={`${formatNumber(rateLimit.limit)} req/時`} />

            <UsageBar
                label="1時間あたり"
                usedPercent={usedPercent}
                elapsedPercent={getElapsedPercent(resetsAtMs - RATE_LIMIT_WINDOW_MS, resetsAtMs, now)}
                valueText={`残り ${formatNumber(rateLimit.remaining)}`}
                usedText={`使用 ${formatNumber(rateLimit.used)} / ${formatNumber(rateLimit.limit)} req`}
                remainingText={formatRemaining(rateLimit.resetsAt, now)}
            />

            <CardFooter
                rows={[
                    {
                        label: "リセット時刻",
                        value: new Date(rateLimit.resetsAt).toLocaleTimeString("ja-JP", {
                            hour: "2-digit",
                            minute: "2-digit",
                        }),
                    },
                ]}
            />
        </DashboardCard>
    )
}

/** GitHub Appの枠（issue-deck経由）。issue-deckの「GitHub使用量」と同じ数字で、PATの枠とは別 */
function AppRateLimitCards({ appRateLimits, now }: { appRateLimits: GitHubAppRateLimits; now: number }) {
    if (appRateLimits.status === "error") {
        return (
            <DashboardCard className="px-3 py-3 sm:px-4 sm:py-4">
                <CardHeader title="GitHub App のレート制限" />
                <p className="mt-2 text-[11px] sm:text-xs text-destructive">
                    取得不可（{appRateLimits.message ?? "原因不明"}）
                </p>
            </DashboardCard>
        )
    }

    return (
        <>
            {appRateLimits.installations.map((installation) => (
                <DashboardCard
                    key={installation.accountLogin}
                    className="h-full flex flex-col gap-3 px-3 py-3 sm:px-4 sm:py-4"
                >
                    <CardHeader title={`${installation.accountLogin}（GitHub App）`} badge="issue-deck経由" />
                    {installation.resources.map((resource) => {
                        const resetsAtMs = new Date(resource.resetsAt).getTime()
                        return (
                            <UsageBar
                                key={resource.key}
                                label={resource.label}
                                usedPercent={getRateLimitUsedPercent(resource)}
                                elapsedPercent={getElapsedPercent(resetsAtMs - RATE_LIMIT_WINDOW_MS, resetsAtMs, now)}
                                valueText={`残り ${formatNumber(resource.remaining)}`}
                                usedText={`使用 ${formatNumber(resource.used)} / ${formatNumber(resource.limit)} req`}
                                remainingText={formatRemaining(resource.resetsAt, now)}
                            />
                        )
                    })}
                </DashboardCard>
            ))}
        </>
    )
}

export function GitHubUsage() {
    const { githubUsage: snapshot, now } = useDashboardData()

    // 未設定のときは、使わない環境で「未設定」のカードが出続けないようセクションごと隠す
    if (snapshot?.status === "unconfigured" && snapshot.appRateLimits?.status !== "ok") return null

    if (!snapshot) {
        return (
            <section id={SECTION_ANCHORS.githubUsage} className="scroll-mt-28 space-y-3 sm:space-y-4">
                <SectionHeading title="GitHub" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                    {[0, 1].map((index) => (
                        <DashboardCard key={index} className="px-3 py-3 sm:px-4 sm:py-4">
                            <SkeletonGroup label="GitHub使用状況" className="space-y-3">
                                <SkeletonBar />
                                <SkeletonBar />
                            </SkeletonGroup>
                        </DashboardCard>
                    ))}
                </div>
            </section>
        )
    }

    return (
        <section id={SECTION_ANCHORS.githubUsage} className="scroll-mt-28 space-y-3 sm:space-y-4">
            <SectionHeading
                title="GitHub"
                trailing={
                    <span className="text-xs font-mono text-muted-foreground truncate">
                        {new Date(snapshot.fetchedAt).toLocaleTimeString("ja-JP", {
                            hour: "2-digit",
                            minute: "2-digit",
                        })}{" "}
                        時点
                    </span>
                }
            />

            {snapshot.status === "unconfigured" ? null : snapshot.status === "error" && snapshot.denied ? (
                <DashboardCard className="px-3 py-3 sm:px-4 sm:py-4">
                    <AccessDenied
                        reason={`${snapshot.message ?? "GitHubの課金レポートを読む権限がありません"}。GH_USAGE_TOKEN は classic PAT（repo と read:org）が必要です`}
                    />
                </DashboardCard>
            ) : snapshot.status === "error" ? (
                <DashboardCard className="px-3 py-3 sm:px-4 sm:py-4">
                    <p className="text-[11px] sm:text-xs text-muted-foreground">
                        {snapshot.message ?? "使用状況を取得できませんでした"}
                    </p>
                </DashboardCard>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                    {snapshot.actions && <ActionsCard actions={snapshot.actions} now={now} />}
                    {snapshot.rateLimit && <RateLimitCard rateLimit={snapshot.rateLimit} now={now} />}
                </div>
            )}

            {snapshot.appRateLimits && snapshot.appRateLimits.status !== "unconfigured" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                    <AppRateLimitCards appRateLimits={snapshot.appRateLimits} now={now} />
                </div>
            )}
        </section>
    )
}
