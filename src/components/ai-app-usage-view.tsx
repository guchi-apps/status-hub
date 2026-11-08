"use client"

import { useState, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { SectionHeading } from "@/components/section-heading"
import { Button } from "@/components/ui/button"
import { findModel, modelLabel } from "@/lib/ai-app-usage/models"
import { modelColor } from "@/lib/ai-app-usage/model-colors"
import {
    appMetric,
    sortAppsByMetric,
    sumTotals,
    summarizeApps,
    summarizeModels,
    type AppMetric,
    type AppMetricValue,
    type AppSummary,
    type ModelSummary,
} from "@/lib/ai-app-usage/summarize"
import { formatTokens, formatUsd } from "@/lib/usage-format"
import { cn } from "@/lib/utils"
import type { AiAppFeatureUsage, AiAppPeriod, AiAppUsageApp, AiAppUsageSnapshot, AiAppUsageTotals } from "@/types/ai-app-usage"

const PERIODS: { id: AiAppPeriod; label: string; text: string }[] = [
    { id: "last24h", label: "24時間", text: "直近24時間" },
    { id: "last7d", label: "7日間", text: "直近7日間" },
]

const METRICS: { id: AppMetric; label: string; short: string }[] = [
    { id: "cost", label: "概算金額", short: "金額" },
    { id: "calls", label: "呼出回数", short: "回数" },
    { id: "tokens", label: "使用トークン", short: "トークン" },
]

const CACHE_NOTE = "キャッシュ未集計の可能性"

function formatCalls(calls: number): string {
    return `${calls.toLocaleString("ja-JP")}回`
}

/** 指標の値の文字列。不明は0ではなく「—」 */
function formatMetric(metric: AppMetric, value: number | null): string {
    if (value === null) return "—"
    if (metric === "cost") return formatUsd(value)
    if (metric === "calls") return formatCalls(value)
    return formatTokens(value)
}

function ModelDot({ model }: { model: string }) {
    return <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: modelColor(model) }} aria-hidden />
}

function ModelChip({ model }: { model: string }) {
    return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card py-px pl-1.5 pr-2 text-[11px]">
            <ModelDot model={model} />
            {modelLabel(model)}
        </span>
    )
}

function PeriodToggle({ period, onChange }: { period: AiAppPeriod; onChange: (period: AiAppPeriod) => void }) {
    return (
        <div role="group" aria-label="集計期間" className="inline-flex rounded-lg border border-border bg-card p-0.5">
            {PERIODS.map((item) => (
                <button
                    key={item.id}
                    type="button"
                    aria-pressed={period === item.id}
                    onClick={() => onChange(item.id)}
                    className={cn(
                        "min-h-8 rounded-md px-3 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                        period === item.id
                            ? "bg-primary font-semibold text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground"
                    )}
                >
                    {item.label}
                </button>
            ))}
        </div>
    )
}

function Stat({ value, label, notes, className }: { value: string; label: string; notes?: string[]; className?: string }) {
    return (
        <div className={cn("min-w-0 bg-card px-3 py-2 sm:px-4", className)}>
            <p className="truncate font-mono text-base font-bold tabular-nums sm:text-lg">{value}</p>
            <p className="truncate text-[10px] text-muted-foreground sm:text-[11px]">{label}</p>
            {notes?.map((note) => (
                <p key={note} className="text-[10px] leading-tight text-amber-400">
                    {note}
                </p>
            ))}
        </div>
    )
}

/** 合計を1本の帯にまとめる。スマホでは「使用モデル」を省いて3項目にする */
function Summary({
    apps,
    period,
    modelCount,
    periodText,
}: {
    apps: AiAppUsageApp[]
    period: AiAppPeriod
    modelCount: number
    periodText: string
}) {
    const totals = sumTotals(apps.flatMap((app) => app.features.map((feature) => feature[period])))
    const metrics = apps.map((app) => appMetric(app, period, "tokens"))
    const known = metrics.filter((metric) => metric.value !== null)
    const tokens = known.length > 0 ? known.reduce((sum, metric) => sum + (metric.value ?? 0), 0) : null
    const tokensPartial = metrics.some((metric) => metric.partial)

    const costNotes: string[] = []
    if (totals.costUsd !== null) {
        if (totals.costIncomplete) costNotes.push("単価不明のモデルを除く")
        if (totals.inputIncomplete) costNotes.push("トークン未集計のアプリを除く")
        if (totals.cacheIncomplete) costNotes.push(CACHE_NOTE)
    }
    const tokenNotes: string[] = []
    if (tokens !== null) {
        if (tokensPartial) tokenNotes.push("未集計の分を除く")
        if (totals.cacheIncomplete) tokenNotes.push(CACHE_NOTE)
    }

    return (
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
            <Stat value={totals.costUsd === null ? "—" : formatUsd(totals.costUsd)} label="概算金額（API換算）" notes={costNotes} />
            <Stat value={totals.calls.toLocaleString("ja-JP")} label={`呼出回数（${periodText}）`} />
            <Stat value={tokens === null ? "—" : formatTokens(tokens)} label="使用トークン" notes={tokenNotes} />
            <Stat value={`${modelCount} 種`} label={`モデル · ${apps.length} アプリ`} className="hidden sm:block" />
        </div>
    )
}

/** モデル別の積み上げ棒。幅は全アプリ共通の最大値を基準にし、アプリ同士を同じ尺度で比べる */
function StackBar({ name, metric, value, max }: { name: string; metric: AppMetric; value: AppMetricValue; max: number }) {
    if (value.value === null) {
        return <span className="text-[11px] text-muted-foreground">{metric === "tokens" ? "トークン未集計" : "単価不明"}</span>
    }

    const label = `${name} ${METRICS.find((item) => item.id === metric)?.label} ${formatMetric(metric, value.value)}（${value.segments
        .map((segment) => `${modelLabel(segment.model)} ${formatMetric(metric, segment.value)}`)
        .join("、")}）${value.partial ? "。不明な分を除いた部分集計" : ""}`

    return (
        <div className="h-3 overflow-hidden rounded-[3px] bg-muted" role="img" aria-label={label}>
            <div className="flex h-full gap-px" style={{ width: `${max > 0 ? (value.value / max) * 100 : 0}%` }}>
                {value.segments.map((segment) => (
                    <span
                        key={segment.model}
                        className="h-full"
                        style={{ flexGrow: segment.value, flexBasis: 0, backgroundColor: modelColor(segment.model) }}
                        title={`${modelLabel(segment.model)} ${formatMetric(metric, segment.value)}`}
                    />
                ))}
            </div>
        </div>
    )
}

function TokenLine({ label, value, note }: { label: string; value: number | null; note?: string }) {
    return (
        <span className="whitespace-nowrap">
            <span className="font-sans text-muted-foreground">{label} </span>
            {value === null ? "不明" : formatTokens(value)}
            {note && <span className="font-sans text-[10px] text-muted-foreground"> {note}</span>}
        </span>
    )
}

function FeatureRows({ features, period }: { features: AiAppFeatureUsage[]; period: AiAppPeriod }) {
    const rows = features.filter((feature) => feature[period].calls > 0).sort((a, b) => b[period].calls - a[period].calls)
    if (rows.length === 0) {
        return <p className="py-1 text-xs text-muted-foreground">この期間は呼び出しがありません</p>
    }

    return (
        <ul className="divide-y divide-dashed divide-border">
            {rows.map((feature) => {
                const totals: AiAppUsageTotals = feature[period]
                return (
                    <li key={`${feature.label}\n${feature.model}`} className="ai-app-feature py-1.5 text-xs">
                        <span data-area="feat" className="min-w-0 break-words">
                            {feature.label}
                        </span>
                        <span data-area="model">
                            <ModelChip model={feature.model} />
                        </span>
                        <span data-area="calls" className="hidden text-right font-mono tabular-nums md:block">
                            {totals.calls.toLocaleString("ja-JP")}
                        </span>
                        <span data-area="tok" className="font-mono tabular-nums md:text-right">
                            <span className="md:hidden">{totals.calls.toLocaleString("ja-JP")}回 · </span>
                            {totals.inputTokens === null ? "—" : formatTokens(totals.inputTokens)} /{" "}
                            {totals.outputTokens === null ? "—" : formatTokens(totals.outputTokens)}
                        </span>
                        <span data-area="cost" className="text-right font-mono tabular-nums max-md:font-semibold">
                            {totals.costUsd === null ? "—" : formatUsd(totals.costUsd)}
                        </span>
                    </li>
                )
            })}
        </ul>
    )
}

/** 開いたときの詳細。トークンの定義（入力にキャッシュ読出・書込を含み、出力と足したものが使用トークン）を示す */
function AppDetail({ summary, period }: { summary: AppSummary; period: AiAppPeriod }) {
    const { totals, app } = summary
    const tokens = appMetric(app, period, "tokens")
    const notes: string[] = []
    if (totals.costIncomplete) notes.push("単価が分からないモデルの金額は含めていません（部分集計）。")
    if (totals.inputIncomplete) notes.push("連携先がトークン数を数えていない分は、トークンにも金額にも含めていません（部分集計）。")
    if (totals.cacheIncomplete) notes.push("連携先がキャッシュの内訳を返していない分があり、入力トークンと金額はキャッシュ0として計算しています。")

    return (
        <div className="grid gap-2 border-t border-border bg-muted/50 px-3.5 py-2.5 sm:px-4 md:pl-9">
            <p className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] tabular-nums">
                <TokenLine label="入力（キャッシュ込み）" value={totals.inputTokens} />
                <TokenLine label="うち読出" value={totals.cacheReadTokens} />
                <TokenLine label="うち書込" value={totals.cacheWriteTokens} />
                <TokenLine label="出力" value={totals.outputTokens} />
                <TokenLine label="使用トークン" value={tokens.value} note={tokens.partial ? "（部分集計）" : undefined} />
            </p>
            <FeatureRows features={app.features} period={period} />
            {notes.map((note) => (
                <p key={note} className="text-[11px] text-amber-400">
                    {note}
                </p>
            ))}
        </div>
    )
}

function AppItem({
    summary,
    period,
    metric,
    max,
    open,
    onToggle,
}: {
    summary: AppSummary
    period: AiAppPeriod
    metric: AppMetric
    max: number
    open: boolean
    onToggle: () => void
}) {
    const { app, totals } = summary

    if (app.status !== "ok") {
        return (
            <li className="border-t border-border first:border-t-0">
                <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 px-3.5 py-2 sm:px-4">
                    <b className="min-w-0 truncate text-sm font-semibold">{app.app}</b>
                    <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-px text-[10px] font-semibold text-amber-400">
                        取得不可
                    </span>
                    <span className="text-xs text-muted-foreground">{app.message ?? "取得できませんでした"}。次の更新で取り直します</span>
                </div>
            </li>
        )
    }

    const value = appMetric(app, period, metric)
    const cost = appMetric(app, period, "cost")
    const sub = metric === "calls" || metric === "tokens" ? formatMetric("cost", cost.value) : formatCalls(totals.calls)
    const mark = value.partial && value.value !== null ? "+" : ""
    const flagged = totals.cacheIncomplete && metric !== "calls"

    return (
        <li className="border-t border-border first:border-t-0">
            <button
                type="button"
                aria-expanded={open}
                onClick={onToggle}
                className="ai-app-row w-full px-3.5 py-2 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-4"
            >
                <span data-area="name" className="flex min-w-0 items-center gap-1">
                    <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                    <b className="truncate text-[13px] font-semibold">{app.app}</b>
                </span>
                <span data-area="bar" className="min-w-0">
                    <StackBar name={app.app} metric={metric} value={value} max={max} />
                </span>
                <span data-area="val" className="text-right font-mono tabular-nums">
                    <span className="block text-sm font-bold leading-tight">
                        {formatMetric(metric, value.value)}
                        {mark && <span aria-hidden>{mark}</span>}
                        {flagged && (
                            <span className="ml-0.5 font-sans text-[10px] font-normal text-amber-400" title={CACHE_NOTE} aria-label={CACHE_NOTE}>
                                ※
                            </span>
                        )}
                    </span>
                    <span className="block text-[10.5px] font-normal leading-tight text-muted-foreground">{sub}</span>
                </span>
            </button>
            {open && <AppDetail summary={summary} period={period} />}
        </li>
    )
}

function Legend({ models }: { models: string[] }) {
    return (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 border-b border-border px-3.5 py-1.5 text-[11px] text-muted-foreground sm:px-4" aria-label="モデルの凡例">
            {models.map((model) => (
                <li key={model} className="inline-flex items-center gap-1.5">
                    <ModelDot model={model} />
                    {modelLabel(model)}
                </li>
            ))}
        </ul>
    )
}

/** 指標を切り替えて共有する1つの比較グラフ。3つの指標を並べず、縦の高さを増やさない */
function ComparisonChart({
    summaries,
    period,
    models,
}: {
    summaries: AppSummary[]
    period: AiAppPeriod
    models: ModelSummary[]
}) {
    const [metric, setMetric] = useState<AppMetric>("cost")
    const [sort, setSort] = useState<AppMetric>("cost")
    // 行を開閉した結果だけを持つ。初期はすべて閉じる
    const [opened, setOpened] = useState<Record<string, boolean>>({})

    const rows = sortAppsByMetric(summaries, period, sort)
    const max = Math.max(0, ...rows.filter((row) => row.app.status === "ok").map((row) => appMetric(row.app, period, metric).value ?? 0))
    const unknownRows = rows.filter((row) => row.app.status === "ok" && appMetric(row.app, period, metric).value === null)
    const partialRows = rows.filter((row) => row.app.status === "ok" && appMetric(row.app, period, metric).partial && appMetric(row.app, period, metric).value !== null)

    return (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2 sm:px-4">
                <div role="group" aria-label="グラフの指標" className="inline-flex rounded-lg border border-border bg-background p-0.5">
                    {METRICS.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            aria-pressed={metric === item.id}
                            onClick={() => {
                                setMetric(item.id)
                                setSort(item.id)
                            }}
                            className={cn(
                                "min-h-8 rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                                metric === item.id ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <span className="sm:hidden">{item.short}</span>
                            <span className="hidden sm:inline">{item.label}</span>
                        </button>
                    ))}
                </div>
                <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    並べ替え
                    <select
                        value={sort}
                        onChange={(event) => setSort(event.target.value as AppMetric)}
                        className="min-h-8 rounded-md border border-input bg-background px-1.5 text-xs text-foreground"
                    >
                        {METRICS.map((item) => (
                            <option key={item.id} value={item.id}>
                                {item.label}順
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <Legend models={models.map((entry) => entry.model)} />
            <ul>
                {rows.map((summary) => (
                    <AppItem
                        key={summary.app.app}
                        summary={summary}
                        period={period}
                        metric={metric}
                        max={max}
                        open={opened[summary.app.app] ?? false}
                        onToggle={() => setOpened((current) => ({ ...current, [summary.app.app]: !current[summary.app.app] }))}
                    />
                ))}
            </ul>
            {(unknownRows.length > 0 || partialRows.length > 0) && (
                <p className="border-t border-border px-3.5 py-1.5 text-[11px] text-amber-400 sm:px-4">
                    {unknownRows.length > 0 && <>棒を出せないアプリ（{metric === "tokens" ? "トークン未集計" : "単価不明"}）: {unknownRows.map((row) => row.app.app).join("・")}。 </>}
                    {partialRows.length > 0 && <>「+」は不明な分を除いた部分集計です。</>}
                </p>
            )}
        </div>
    )
}

/** 補助情報の折りたたみ。見出しに件数や状態を残し、開かなくても概要が分かるようにする */
function Disclosure({ title, summary, children }: { title: string; summary?: ReactNode; children: ReactNode }) {
    const [open, setOpen] = useState(false)

    return (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((current) => !current)}
                className="flex min-h-11 w-full items-center gap-2 px-3.5 py-2 text-left text-sm font-medium hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-4"
            >
                <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                {title}
                <span className="ml-auto flex min-w-0 flex-wrap justify-end gap-1.5 text-[11px] font-normal text-muted-foreground">{summary}</span>
            </button>
            {open && <div className="border-t border-border">{children}</div>}
        </div>
    )
}

function ModelPanel({ models, period, apps }: { models: ModelSummary[]; period: AiAppPeriod; apps: AiAppUsageApp[] }) {
    if (models.length === 0) return <p className="px-4 py-3 text-xs text-muted-foreground">この期間の呼び出しはありません</p>

    return (
        <ul className="divide-y divide-border">
            {models.map((entry) => {
                const info = findModel(entry.model)
                const cost = apps.reduce<AppMetricValue[]>((list, app) => (app.status === "ok" ? [...list, appMetric(app, period, "cost")] : list), [])
                const modelCost = cost.flatMap((value) => value.segments).filter((segment) => segment.model === entry.model)
                const total = modelCost.length > 0 ? modelCost.reduce((sum, segment) => sum + segment.value, 0) : null
                return (
                    <li key={entry.model} className="grid gap-0.5 px-3.5 py-2 sm:px-4">
                        <div className="flex items-center gap-2">
                            <ModelDot model={entry.model} />
                            <b className="min-w-0 truncate text-[13px] font-semibold">{modelLabel(entry.model)}</b>
                            {info && <span className="text-[11px] text-muted-foreground">{info.provider}</span>}
                            <span className="ml-auto shrink-0 font-mono text-xs tabular-nums">
                                {formatCalls(entry.calls)} · {total === null ? "—" : formatUsd(total)}
                            </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                            使用アプリ: <span className="font-medium text-foreground">{entry.apps.join("・")}</span>
                        </p>
                    </li>
                )
            })}
        </ul>
    )
}

/** 取得済みのスナップショットを描く部分。取得（`useDashboardData`）から切り離してあり、画面確認で作り物の値を渡せる */
export function AiAppUsageView({
    snapshot,
    onManageSources,
}: {
    snapshot: AiAppUsageSnapshot
    onManageSources?: () => void
}) {
    const [period, setPeriod] = useState<AiAppPeriod>("last24h")

    if (snapshot.apps.length === 0) {
        return (
            <section className="space-y-3 sm:space-y-4">
                <SectionHeading
                    title="アプリ別のAI利用"
                    trailing={onManageSources && <Button type="button" variant="outline" size="sm" onClick={onManageSources}>連携先を管理</Button>}
                />
                <p className="rounded-xl border border-border bg-card px-4 py-5 text-center text-xs text-muted-foreground">
                    連携先を追加すると、アプリ別のAI利用をここに表示します。
                </p>
            </section>
        )
    }

    const periodText = PERIODS.find((item) => item.id === period)?.text ?? ""
    const summaries = summarizeApps(snapshot.apps, period)
    const models = summarizeModels(snapshot.apps, period)
    const ok = snapshot.apps.filter((app) => app.status === "ok")
    const failedCount = snapshot.apps.length - ok.length

    return (
        <section className="space-y-2.5 sm:space-y-3">
            <SectionHeading
                title="アプリ別のAI利用"
                trailing={
                    <>
                        {onManageSources && <Button type="button" variant="outline" size="sm" onClick={onManageSources}>連携先を管理</Button>}
                        <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">
                            {new Date(snapshot.fetchedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} 時点
                        </span>
                        <PeriodToggle period={period} onChange={setPeriod} />
                    </>
                }
            />

            <Summary apps={ok} period={period} modelCount={models.length} periodText={periodText} />
            {failedCount > 0 && (
                <p className="text-[11px] text-muted-foreground">取得できなかった {failedCount} アプリは合計に含めていません。</p>
            )}

            <ComparisonChart summaries={summaries} period={period} models={models} />

            <Disclosure title="使用中のモデル" summary={`${models.length} 種`}>
                <ModelPanel models={models} period={period} apps={snapshot.apps} />
            </Disclosure>

            <p className="text-[11px] text-muted-foreground">
                概算金額は、各アプリが数えたトークン数と単価表からの推計で、請求額そのものではありません。
                GPT-5.6系（Codex経由）はChatGPTの定額枠で動くため請求は発生せず、公開API単価での換算の目安です。
                使用トークンは入力（キャッシュ読出・書込を含む）と出力の合計で、棒の色はモデルごとです。行を押すと内訳を開閉します。
            </p>
        </section>
    )
}
