"use client"

import { ChevronRight, Eye, EyeOff, RefreshCw, Table2, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { MENU_ITEM_CLASS, useHeaderMenu } from "@/components/header-menu"
import { ModelPriceWatch } from "@/components/model-price-watch"
import { Button } from "@/components/ui/button"
import { CSRF_HEADERS } from "@/lib/csrf-headers"
import { listModels, type ModelFamily, type ModelInfo } from "@/lib/ai-app-usage/models"
import type { PriceModelRow, PriceWatchView } from "@/lib/ai-app-usage/price-watch/run"
import type { PriceCandidate } from "@/lib/ai-app-usage/price-watch/types"
import { cn } from "@/lib/utils"

/**
 * ヘッダーメニューの「モデル単価表」の行と、押すと開く全画面のモーダル（#561）。
 *
 * 表は概算金額の計算に使う単価（100万トークンあたり・USD）をそのまま出す。「更新」は公式の料金ページを
 * 今すぐ確認し、新モデル・価格変更を候補として出す。単価表自体は自動では書き換えない（docs/model-price-watch.md）。
 * 表は連携先の取得結果に依存しないため、結果の取得に失敗しても表は出す。
 */

/** モデルの系統ごとの色。一覧に無いモデルは無彩色にして、色だけで区別しない（名前も必ず出す） */
const FAMILY_DOT: Record<ModelFamily, string> = {
    opus: "bg-[#8ea2ee]",
    sonnet: "bg-[#4cc5b6]",
    haiku: "bg-[#e3bd58]",
    jev: "bg-[#ee8fb0]",
    gpt: "bg-[#f0a15c]",
}

const PRICE_COLUMNS: { key: keyof ModelInfo["price"]; label: string }[] = [
    { key: "input", label: "入力" },
    { key: "output", label: "出力" },
    { key: "cacheWrite", label: "書き込み" },
    { key: "cacheRead", label: "読み出し" },
]

function formatPrice(value: number): string {
    if (value === 0) return "無料"
    return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`
}

export function ModelPriceMenuItem() {
    const menu = useHeaderMenu()
    const [open, setOpen] = useState(false)
    const focusMenuButton = menu?.focusMenuButton
    const close = useCallback(() => {
        setOpen(false)
        focusMenuButton?.()
    }, [focusMenuButton])

    return (
        <>
            <button
                type="button"
                onClick={() => {
                    menu?.closeMenu()
                    setOpen(true)
                }}
                aria-haspopup="dialog"
                className={MENU_ITEM_CLASS}
            >
                <Table2 className="size-3.5 text-muted-foreground" aria-hidden />
                <span className="flex-1">モデル単価表</span>
                <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
            </button>
            {open && <ModelPriceDialog onClose={close} />}
        </>
    )
}

function ModelPriceDialog({ onClose }: { onClose: () => void }) {
    const [filter, setFilter] = useState<string | null>(null)
    const [view, setView] = useState<PriceWatchView | null>(null)
    const [showHidden, setShowHidden] = useState(false)
    const [acting, setActing] = useState(false)
    // 追加・非表示を反映した一覧はサーバーが返す。取得できていない間は組み込みの一覧で表だけ出す
    const allModels: PriceModelRow[] = view?.models ?? listModels().map((info) => ({ ...info, hidden: false, added: false }))
    const hiddenCount = allModels.filter((info) => info.hidden).length
    const models = allModels.filter((info) => showHidden || !info.hidden)
    const providers = [...new Set(models.map((info) => info.provider))]
    const [failed, setFailed] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    const [message, setMessage] = useState<string | null>(null)
    const closeRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        closeRef.current?.focus()
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose()
        }
        document.addEventListener("keydown", onKeyDown)
        return () => document.removeEventListener("keydown", onKeyDown)
    }, [onClose])

    useEffect(() => {
        let cancelled = false
        fetch("/api/model-price-watch", { cache: "no-store" })
            .then((response) => (response.ok ? (response.json() as Promise<PriceWatchView>) : Promise.reject(new Error(String(response.status)))))
            .then((value) => !cancelled && setView(value))
            .catch(() => !cancelled && setFailed(true))
        return () => {
            cancelled = true
        }
    }, [])

    const refresh = async () => {
        setRefreshing(true)
        setMessage(null)
        try {
            const response = await fetch("/api/model-price-watch", { method: "POST", headers: CSRF_HEADERS })
            if (!response.ok) throw new Error(String(response.status))
            const body = (await response.json()) as { view: PriceWatchView; throttled: boolean }
            setView(body.view)
            setFailed(false)
            setMessage(body.throttled ? "直前に確認したばかりのため、その結果を表示しています。1分ほどあけてもう一度押してください。" : null)
        } catch (reason) {
            console.error("モデル単価の確認に失敗しました:", reason)
            setMessage("確認できませんでした。時間をおいてもう一度お試しください。")
        } finally {
            setRefreshing(false)
        }
    }

    const act = async (body: Record<string, string>) => {
        setActing(true)
        setMessage(null)
        try {
            const response = await fetch("/api/model-price-watch/actions", {
                method: "POST",
                headers: { ...CSRF_HEADERS, "Content-Type": "application/json" },
                body: JSON.stringify(body),
            })
            if (!response.ok) {
                const detail = (await response.json().catch(() => null)) as { error?: string } | null
                throw new Error(detail?.error ?? String(response.status))
            }
            setView((await response.json()) as PriceWatchView)
        } catch (reason) {
            console.error("モデル単価表の操作に失敗しました:", reason)
            setMessage(reason instanceof Error && reason.message ? `操作できませんでした（${reason.message}）` : "操作できませんでした。")
        } finally {
            setActing(false)
        }
    }

    const groups = providers
        .filter((provider) => filter === null || provider === filter)
        .map((provider) => ({ provider, models: models.filter((info) => info.provider === provider) }))

    return createPortal(
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-5" onClick={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                aria-label="モデル単価表"
                onClick={(event) => event.stopPropagation()}
                className="flex max-h-[92dvh] w-full max-w-[860px] flex-col overflow-hidden rounded-t-2xl border border-border bg-popover text-popover-foreground shadow-2xl sm:max-h-[min(88dvh,820px)] sm:rounded-2xl"
            >
                <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-3">
                    <h2 className="text-sm font-bold">モデル単価表</h2>
                    <span className="text-[11px] text-muted-foreground">100万トークンあたり・USD</span>
                    <div className="ml-auto flex items-center gap-2">
                        <Button type="button" size="sm" onClick={() => void refresh()} disabled={refreshing}>
                            <RefreshCw className={cn(refreshing && "animate-spin")} aria-hidden />
                            {refreshing ? "確認中…" : "更新して確認"}
                        </Button>
                        <button
                            ref={closeRef}
                            type="button"
                            onClick={onClose}
                            aria-label="閉じる"
                            className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                        >
                            <X aria-hidden />
                        </button>
                    </div>
                </div>

                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                    {message && (
                        <p role="status" className="text-[11px] text-muted-foreground">
                            {message}
                        </p>
                    )}
                    <ModelPriceWatch
                        view={view}
                        failed={failed}
                        busy={acting}
                        onAdd={(candidate: PriceCandidate) => void act({ action: "add-candidate", key: candidate.key })}
                        onHide={(candidate: PriceCandidate) => void act({ action: "hide-candidate", key: candidate.key })}
                    />

                    <div role="group" aria-label="提供元で絞り込み" className="flex flex-wrap gap-1.5">
                        {[null, ...providers].map((provider) => (
                            <button
                                key={provider ?? "all"}
                                type="button"
                                aria-pressed={filter === provider}
                                onClick={() => setFilter(provider)}
                                className={cn(
                                    "rounded-full border px-2.5 py-px text-[11px] focus-visible:outline-2 focus-visible:outline-ring",
                                    filter === provider
                                        ? "border-primary bg-primary font-semibold text-primary-foreground"
                                        : "border-border bg-card text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {provider ?? "すべて"}
                            </button>
                        ))}
                        {hiddenCount > 0 && (
                            <button
                                type="button"
                                aria-pressed={showHidden}
                                onClick={() => setShowHidden((value) => !value)}
                                className="ml-auto flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-px text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                            >
                                {showHidden ? <EyeOff className="size-3" aria-hidden /> : <Eye className="size-3" aria-hidden />}
                                {showHidden ? "非表示を隠す" : `非表示 ${hiddenCount}件を表示`}
                            </button>
                        )}
                    </div>

                    <div className="overflow-x-auto rounded-xl border border-border bg-card">
                        <table className="w-full border-collapse text-xs tabular-nums">
                            <thead>
                                <tr className="bg-muted text-[10px] tracking-[0.08em] text-muted-foreground">
                                    <th scope="col" className="px-2 py-2 text-left font-semibold sm:px-3">モデル</th>
                                    {PRICE_COLUMNS.map((column) => (
                                        <th key={column.key} scope="col" className="whitespace-nowrap px-1.5 py-2 text-right font-semibold sm:px-3">
                                            {column.label}
                                        </th>
                                    ))}
                                    <th scope="col" className="px-1.5 py-2 text-right font-semibold sm:px-3">
                                        <span className="sr-only">操作</span>
                                    </th>
                                </tr>
                            </thead>
                            {groups.map((group) => (
                                <tbody key={group.provider}>
                                    <tr className="bg-muted text-[10px] tracking-[0.08em] text-muted-foreground">
                                        <th scope="colgroup" colSpan={6} className="px-2 py-1 text-left font-normal sm:px-3">
                                            {group.provider}　{group.models.length} モデル
                                        </th>
                                    </tr>
                                    {group.models.map((info) => (
                                        <tr key={info.id} className={cn("border-t border-border", info.hidden && "opacity-50")}>
                                            <th scope="row" className="px-2 py-1.5 text-left font-normal sm:px-3">
                                                <span className="flex items-center gap-1.5">
                                                    <span className={cn("size-2 shrink-0 rounded-[2px]", FAMILY_DOT[info.family])} aria-hidden />
                                                    <b className="whitespace-nowrap text-[12px] font-semibold sm:text-[13px]">{info.label}</b>
                                                    {info.added && (
                                                        <span className="shrink-0 whitespace-nowrap rounded-full border border-emerald-500/40 px-1.5 text-[10px] text-emerald-400">
                                                            反映済み
                                                        </span>
                                                    )}
                                                    {info.note && (
                                                        <span className="shrink-0 whitespace-nowrap rounded-full border border-amber-500/40 px-1.5 text-[10px] text-amber-400">
                                                            {info.note}
                                                        </span>
                                                    )}
                                                </span>
                                                <span className="hidden font-mono text-[10px] text-muted-foreground sm:block">{info.id}</span>
                                            </th>
                                            {PRICE_COLUMNS.map((column) => (
                                                <td key={column.key} className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono sm:px-3">
                                                    {formatPrice(info.price[column.key])}
                                                </td>
                                            ))}
                                            <td className="px-1.5 py-1.5 text-right sm:px-3">
                                                <button
                                                    type="button"
                                                    disabled={acting}
                                                    onClick={() => void act({ action: info.hidden ? "show-model" : "hide-model", id: info.id })}
                                                    aria-label={`${info.label}を${info.hidden ? "再表示" : "非表示"}`}
                                                    className="whitespace-nowrap rounded-md border border-border px-1.5 py-px text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"
                                                >
                                                    {info.hidden ? "再表示" : "非表示"}
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            ))}
                        </table>
                    </div>

                    <p className="text-[11px] text-muted-foreground">
                        単価表に無いモデルの金額は「—」で、近いモデルの単価では推測しません。
                        「出典未確認」は公式の単価を確かめられていないモデルです。
                        「非表示」は表から隠すだけで、使用量の概算金額の計算には使い続けます。
                    </p>
                </div>
            </div>
        </div>,
        document.body
    )
}
