"use client"

import type { ModelPrice } from "@/lib/ai-app-usage/models"
import type { PriceWatchView } from "@/lib/ai-app-usage/price-watch/run"
import type { CandidateKind, CheckOutcome, PriceCandidate } from "@/lib/ai-app-usage/price-watch/types"
import { cn } from "@/lib/utils"

/**
 * モデル単価表の定期チェック（#497）の結果。最終チェック・結果・更新候補を出す。
 * 単価表は自動では書き換えず、候補を人が確かめて `models.ts` へ反映する（手順は docs/model-price-watch.md）。
 */

const OUTCOME_LABEL: Record<CheckOutcome, { text: string; tone: string }> = {
    unchanged: { text: "変更なし", tone: "border-emerald-500/40 text-emerald-400" },
    candidates: { text: "更新候補あり", tone: "border-amber-500/40 text-amber-400" },
    partial: { text: "一部失敗", tone: "border-red-500/40 text-red-400" },
    failed: { text: "失敗", tone: "border-red-500/40 text-red-400" },
}

const KIND_LABEL: Record<CandidateKind, string> = {
    add: "追加",
    change: "価格変更",
    verify: "出典確認",
    delisted: "掲載終了",
}

const FIELD_LABEL: Record<keyof ModelPrice, string> = {
    input: "入力",
    output: "出力",
    cacheWrite: "書き込み",
    cacheRead: "読み出し",
}

const FIELD_ORDER: (keyof ModelPrice)[] = ["input", "output", "cacheWrite", "cacheRead"]

const price = (value: number | null) =>
    value === null ? "—" : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`

const formatDateTime = (iso: string) =>
    new Date(iso).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    })

/** 候補の単価の見せ方。価格変更は変わった項目の前後、追加・出典確認は4項目をそのまま出す */
function describePrices(candidate: PriceCandidate): string {
    if (candidate.kind === "delisted") return "公式の料金表に載っていません"
    if (!candidate.after) return "通常価格なし（条件付き価格のみ）"

    const fields = candidate.kind === "change" ? candidate.changedFields : FIELD_ORDER
    return fields
        .map((field) => {
            const after = price(candidate.after![field])
            return candidate.kind === "change" && candidate.before
                ? `${FIELD_LABEL[field]} ${price(candidate.before[field])}→${after}`
                : `${FIELD_LABEL[field]} ${after}`
        })
        .join(" / ")
}

/** 結果の取得は呼び出し側（モデル単価表のダイアログ）が行う。`view` が無い間は何も出さない */
export function ModelPriceWatch({ view, failed }: { view: PriceWatchView | null; failed: boolean }) {
    if (failed) return <p className="text-[11px] text-muted-foreground">定期チェックの結果を取得できませんでした。</p>
    if (!view) return null

    const run = view.lastRun
    const outcome = run ? OUTCOME_LABEL[run.outcome] : null
    const problems = run?.providers.filter((entry) => entry.status === "failed") ?? []
    const actionable = view.candidates.filter((entry) => entry.kind !== "delisted")
    const delisted = view.candidates.filter((entry) => entry.kind === "delisted")

    return (
        <div className="space-y-2 rounded-xl border border-border bg-card px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <b className="text-[13px]">定期チェック</b>
                {outcome && (
                    <span className={cn("whitespace-nowrap rounded-full border px-2 text-[10px]", outcome.tone)}>
                        {outcome.text}
                        {run?.outcome === "candidates" ? `（${actionable.length}件）` : ""}
                    </span>
                )}
                <span className="text-muted-foreground">{view.schedule}</span>
            </div>

            {!view.enabled ? (
                <p className="text-muted-foreground">この環境では定期チェックを実行していません（本番のみ）。</p>
            ) : !run ? (
                <p className="text-muted-foreground">まだチェックしていません。次回は {formatDateTime(view.nextRunAt)} の予定です。</p>
            ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
                    <dt>最終チェック</dt>
                    <dd>{formatDateTime(run.finishedAt)}</dd>
                    <dt>最終成功</dt>
                    <dd>{view.lastSuccessAt ? formatDateTime(view.lastSuccessAt) : "—（まだ成功していません）"}</dd>
                    <dt>次回予定</dt>
                    <dd>{formatDateTime(view.nextRunAt)}</dd>
                </dl>
            )}

            {run?.providers.map((entry) => {
                const note = entry.status === "ok" ? entry.warnings : [entry.reason ?? ""]
                if (note.length === 0) return null
                return (
                    <p key={entry.provider} className={cn("text-[11px]", entry.status === "failed" ? "text-red-400" : "text-muted-foreground")}>
                        {entry.provider}: {note.join(" / ")}
                    </p>
                )
            })}
            {problems.length > 0 && (
                <p className="text-[11px] text-muted-foreground">取得に失敗した提供元は前回の結果を表示しています（「変更なし」ではありません）。</p>
            )}

            {actionable.length > 0 && (
                <details open={actionable.length <= 6} className="border-t border-border">
                    <summary className="cursor-pointer py-2 text-[11px] text-muted-foreground">更新候補 {actionable.length}件</summary>
                <ul className="divide-y divide-border">
                    {actionable.map((candidate) => (
                        <li key={candidate.key} className="space-y-0.5 py-2">
                            <p className="flex flex-wrap items-center gap-x-2">
                                <span className="whitespace-nowrap rounded-full border border-amber-500/40 px-1.5 text-[10px] text-amber-400">
                                    {KIND_LABEL[candidate.kind]}
                                </span>
                                <b className="text-[13px]">{candidate.name}</b>
                                <span className="font-mono text-[10px] text-muted-foreground">{candidate.id ?? "ID未確定"}</span>
                                <span className="text-[10px] text-muted-foreground">{candidate.provider}</span>
                            </p>
                            <p className="font-mono tabular-nums">{describePrices(candidate)}</p>
                            <p className="text-[11px] text-muted-foreground">
                                {candidate.basis}
                                {candidate.note ? `・${candidate.note}` : ""}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                                出典{" "}
                                <a href={candidate.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                                    {candidate.sourceUrl}
                                </a>{" "}
                                ・確認 {formatDateTime(candidate.checkedAt)}
                            </p>
                        </li>
                    ))}
                </ul>
                </details>
            )}
            {delisted.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                    公式の料金表に載っていない登録済みモデル: {delisted.map((entry) => entry.name).join("・")}（過去の金額の換算に使うため残しています）
                </p>
            )}

            <p className="text-[11px] text-muted-foreground">
                単価表は自動では書き換えません。候補を確かめて反映すると、使用量の概算金額は過去の期間も新しい単価で計算し直されます
                （概算であり請求額ではありません）。手順は docs/model-price-watch.md。TypeSafeと、ChatGPT・Codex内だけのモデルは公開API単価が無いため対象外です。
            </p>
        </div>
    )
}
