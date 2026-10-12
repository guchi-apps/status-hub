"use client"

import { AccessDenied } from "@/components/skeleton"
import { UsageBar } from "@/components/usage-bar"
import {
    formatRemaining,
    getActionsUsedPercent,
    getElapsedPercent,
    getRateLimitUsedPercent,
} from "@/lib/usage-format"
import type { AiProviderMeteredUsage, AiUsageSnapshot, AiUsageWindow } from "@/types/ai-usage"
import type { GitHubUsageSnapshot } from "@/types/github-usage"

/** 概要タブに並べる内訳リポジトリの数。詳細は利用枠タブで見る */
const MAX_LISTED_REPOSITORIES = 3

/** レート制限の枠の長さ（1時間）。経過位置の目印を出すのに使う */
const RATE_LIMIT_WINDOW_MS = 3_600_000

function windowElapsedPercent(usageWindow: AiUsageWindow, now: number): number | null {
    if (!usageWindow.resetsAt || !usageWindow.windowSeconds) return null

    const resetsAtMs = new Date(usageWindow.resetsAt).getTime()
    if (Number.isNaN(resetsAtMs)) return null

    return getElapsedPercent(resetsAtMs - usageWindow.windowSeconds * 1000, resetsAtMs, now)
}

function formatTokens(tokens: number): string {
    return new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 }).format(tokens)
}

function formatUsd(value: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: value < 0.01 ? 4 : 2,
    }).format(value)
}

function MeteredUsageCompact({ usage }: { usage: AiProviderMeteredUsage }) {
    return (
        <p className="text-[10px] text-muted-foreground">
            <span className="font-mono text-foreground">{formatTokens(usage.last24h.inputTokens)}</span> トークン ·{" "}
            <span className="font-mono text-foreground">{formatUsd(usage.last24h.estimatedCostUsd)}</span>（24時間）
            <br />
            {usage.last24h.calls.toLocaleString("ja-JP")} 回 · 直近7日 {formatUsd(usage.last7d.estimatedCostUsd)}
        </p>
    )
}

/** 概要タブのAI使用状況。提供元ごとの枠を、カードの器を挟まずに縦に並べる */
export function AiUsageCompact({ snapshot, now }: { snapshot: AiUsageSnapshot; now: number }) {
    return (
        <div className="space-y-2.5">
            {snapshot.providers
                .filter((provider) => provider.id !== "typesafe" || provider.status !== "unconfigured")
                .map((provider, index) => (
                <div key={provider.id} className={index > 0 ? "border-t border-border pt-2.5" : undefined}>
                    <div className="mb-1 flex items-center gap-2">
                        <span className="text-xs font-bold">{provider.name}</span>
                        {provider.plan && (
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground">
                                {provider.plan}
                            </span>
                        )}
                    </div>

                    {provider.metered ? (
                        <MeteredUsageCompact usage={provider.metered} />
                    ) : provider.windows.length === 0 && provider.denied ? (
                        <AccessDenied reason={provider.message} compact />
                    ) : provider.windows.length === 0 ? (
                        <p className="text-[10px] text-muted-foreground">
                            {provider.message ?? "使用状況を取得できませんでした"}
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {provider.windows.map((usageWindow, windowIndex) => (
                                <UsageBar
                                    key={`${usageWindow.label}-${windowIndex}`}
                                    label={usageWindow.label}
                                    note={usageWindow.note}
                                    usedPercent={usageWindow.usedPercent}
                                    elapsedPercent={windowElapsedPercent(usageWindow, now)}
                                    remainingText={
                                        usageWindow.resetsAt
                                            ? formatRemaining(usageWindow.resetsAt, now)
                                            : null
                                    }
                                />
                            ))}
                        </div>
                    )}
                </div>
                ))}
        </div>
    )
}

/** 概要タブのGitHub使用状況。無料枠とAPIレートに絞り、内訳は上位数件だけ添える */
export function GitHubUsageCompact({
    snapshot,
    now,
}: {
    snapshot: GitHubUsageSnapshot
    now: number
}) {
    if (snapshot.status === "error" && snapshot.denied) {
        return <AccessDenied reason={snapshot.message} compact />
    }

    if (snapshot.status !== "ok") {
        return (
            <p className="text-[10px] text-muted-foreground">
                {snapshot.message ?? "使用状況を取得できませんでした"}
            </p>
        )
    }

    const { actions, rateLimit } = snapshot
    const listed = actions?.repositories.slice(0, MAX_LISTED_REPOSITORIES) ?? []
    const hiddenCount = (actions?.repositories.length ?? 0) - listed.length

    return (
        <div className="space-y-3">
            {actions && (
                <UsageBar
                    label="Actions"
                    note="今月・private"
                    usedPercent={getActionsUsedPercent(actions)}
                    elapsedPercent={getElapsedPercent(
                        new Date(actions.periodStartsAt).getTime(),
                        new Date(actions.resetsAt).getTime(),
                        now
                    )}
                    usedText={`${actions.allowanceMinutes.toLocaleString("ja-JP")} / ${actions.allowanceLimitMinutes.toLocaleString("ja-JP")} 分`}
                    remainingText={formatRemaining(actions.resetsAt, now)}
                />
            )}

            {rateLimit && (
                <UsageBar
                    label="API レート"
                    note="PAT・REST"
                    usedPercent={getRateLimitUsedPercent(rateLimit)}
                    elapsedPercent={getElapsedPercent(
                        new Date(rateLimit.resetsAt).getTime() - RATE_LIMIT_WINDOW_MS,
                        new Date(rateLimit.resetsAt).getTime(),
                        now
                    )}
                    usedText={`${rateLimit.used.toLocaleString("ja-JP")} / ${rateLimit.limit.toLocaleString("ja-JP")}`}
                    remainingText={formatRemaining(rateLimit.resetsAt, now)}
                />
            )}

            {snapshot.appRateLimits?.status === "error" && (
                <p className="text-[10px] text-destructive">
                    GitHub App の枠: 取得不可（{snapshot.appRateLimits.message ?? "原因不明"}）
                </p>
            )}
            {snapshot.appRateLimits?.installations.flatMap((installation) =>
                installation.resources.map((resource) => {
                    const resetsAtMs = new Date(resource.resetsAt).getTime()
                    return (
                        <UsageBar
                            key={`${installation.accountLogin}:${resource.key}`}
                            label={resource.label}
                            note={`${installation.accountLogin}・App`}
                            usedPercent={getRateLimitUsedPercent(resource)}
                            elapsedPercent={getElapsedPercent(resetsAtMs - RATE_LIMIT_WINDOW_MS, resetsAtMs, now)}
                            usedText={`${resource.used.toLocaleString("ja-JP")} / ${resource.limit.toLocaleString("ja-JP")}`}
                            remainingText={formatRemaining(resource.resetsAt, now)}
                        />
                    )
                })
            )}

            {listed.length > 0 && (
                <ul className="space-y-0.5 border-t border-border pt-2 text-[10px] text-muted-foreground">
                    {listed.map((repository) => (
                        <li key={repository.name} className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 truncate">{repository.name}</span>
                            <span className="shrink-0 whitespace-nowrap font-mono">
                                {repository.minutes.toLocaleString("ja-JP")}分
                            </span>
                        </li>
                    ))}
                    {hiddenCount > 0 && <li className="opacity-70">ほか {hiddenCount} リポジトリ</li>}
                </ul>
            )}
        </div>
    )
}
