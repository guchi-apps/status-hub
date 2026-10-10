"use client"

import { CSRF_HEADERS } from "@/lib/csrf-headers"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ArrowLeft, Pencil, Plus, Trash2, X } from "lucide-react"
import { AiAppUsageView } from "@/components/ai-app-usage-view"
import { useDashboardData } from "@/components/dashboard-data"
import { SkeletonBar, SkeletonGroup } from "@/components/skeleton"
import { SectionHeading } from "@/components/section-heading"
import { Button } from "@/components/ui/button"
import type { AiAppUsageSource } from "@/lib/ai-app-usage/sources"

export { AiAppUsageView }

type SourceDraft = AiAppUsageSource
type SourceScreen = { kind: "list" } | { kind: "edit"; index: number | null }

function emptySource(): SourceDraft {
    return { app: "", url: "" }
}

/**
 * 連携先は画面を開く人だけでなく、issue-deckなどのエージェントも設定APIから更新する。
 * タブ切り替えの transform に固定配置が閉じ込められないよう、モーダルは body へ出す。
 */
function AiAppUsageSourcesModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<boolean> }) {
    const closeRef = useRef<HTMLButtonElement>(null)
    const [sources, setSources] = useState<SourceDraft[]>([])
    const [screen, setScreen] = useState<SourceScreen>({ kind: "list" })
    const [draft, setDraft] = useState<SourceDraft>(emptySource)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        const controller = new AbortController()
        const load = async () => {
            try {
                const response = await fetch("/api/ai-app-usage/sources", { signal: controller.signal })
                const result = (await response.json()) as { sources?: unknown; error?: unknown }
                if (!response.ok || !Array.isArray(result.sources)) {
                    throw new Error(typeof result.error === "string" ? result.error : "連携先を読み込めません")
                }
                setSources(result.sources.map((source) => {
                    const value = source as Partial<AiAppUsageSource>
                    return { app: value.app ?? "", url: value.url ?? "" }
                }))
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "連携先を読み込めません")
            } finally {
                if (!controller.signal.aborted) setLoading(false)
            }
        }
        void load()

        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        closeRef.current?.focus()
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose()
        }
        document.addEventListener("keydown", onKeyDown)
        return () => {
            controller.abort()
            document.removeEventListener("keydown", onKeyDown)
            document.body.style.overflow = previousOverflow
            previouslyFocused?.focus()
        }
    }, [onClose])

    const saveSources = async (nextSources: SourceDraft[]): Promise<boolean> => {
        setSaving(true)
        setError(null)
        try {
            const response = await fetch("/api/ai-app-usage/sources", {
                method: "PUT",
                headers: { "Content-Type": "application/json", ...CSRF_HEADERS },
                body: JSON.stringify({ sources: nextSources }),
            })
            const result = (await response.json()) as { sources?: unknown; error?: unknown }
            if (!response.ok || !Array.isArray(result.sources)) {
                throw new Error(typeof result.error === "string" ? result.error : "連携先を保存できません")
            }
            setSources(result.sources.map((source) => {
                const value = source as Partial<AiAppUsageSource>
                return { app: value.app ?? "", url: value.url ?? "" }
            }))
            if (!(await onSaved())) setError("設定は保存しましたが、使用量を取得できませんでした。")
            return true
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "連携先を保存できません")
            return false
        } finally {
            setSaving(false)
        }
    }

    const openNew = () => {
        setDraft(emptySource())
        setError(null)
        setScreen({ kind: "edit", index: null })
    }

    const openEdit = (index: number) => {
        setDraft(sources[index])
        setError(null)
        setScreen({ kind: "edit", index })
    }

    const saveDraft = async () => {
        if (screen.kind !== "edit") return
        const nextSources = screen.index === null
            ? [...sources, draft]
            : sources.map((source, index) => (index === screen.index ? draft : source))
        if (await saveSources(nextSources)) setScreen({ kind: "list" })
    }

    const removeDraft = async () => {
        if (screen.kind !== "edit" || screen.index === null) return
        if (await saveSources(sources.filter((_, index) => index !== screen.index))) setScreen({ kind: "list" })
    }

    return createPortal(
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-5" onClick={onClose}>
            <div role="dialog" aria-modal="true" aria-label="AI利用の連携先を管理" onClick={(event) => event.stopPropagation()} className="flex max-h-[86dvh] w-full max-w-[640px] flex-col overflow-hidden rounded-t-2xl border border-border bg-popover text-popover-foreground shadow-2xl sm:max-h-[min(82dvh,720px)] sm:rounded-2xl">
                <div className="flex shrink-0 items-start gap-3 border-b border-border px-4 pb-3 pt-3.5">
                    <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-bold">{screen.kind === "list" ? "連携先を管理" : screen.index === null ? "連携先を追加" : "連携先を編集"}</h2>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">保存すると、すぐに最新の使用量を取得して画面へ反映します。</p>
                    </div>
                    <button ref={closeRef} type="button" onClick={onClose} aria-label="閉じる" className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"><X aria-hidden /></button>
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                    {loading ? <SkeletonGroup label="連携先を読み込み中" className="space-y-2"><SkeletonBar /><SkeletonBar /></SkeletonGroup> : screen.kind === "list" ? <>
                        <Button type="button" size="sm" onClick={openNew}><Plus aria-hidden />新規追加</Button>
                        {sources.length === 0 ? <p className="py-4 text-center text-xs text-muted-foreground">連携先はまだありません。</p> : (
                            <ul className="overflow-hidden rounded-lg border border-border bg-card">
                                {sources.map((source, index) => (
                                    <li key={`${source.app}-${index}`} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
                                        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{source.app}</p><p className="truncate font-mono text-[10px] text-muted-foreground">{source.url}</p></div>
                                        <Button type="button" variant="outline" size="sm" onClick={() => openEdit(index)}><Pencil aria-hidden />編集</Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </> : <>
                        <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => setScreen({ kind: "list" })} disabled={saving}><ArrowLeft aria-hidden />一覧へ戻る</Button>
                        <label className="grid gap-1 text-xs font-medium">アプリ名<input value={draft.app} onChange={(event) => setDraft((current) => ({ ...current, app: event.target.value }))} placeholder="issue-deck" className="h-9 rounded-md border border-input bg-background px-2 text-sm font-normal" disabled={saving} /></label>
                        <label className="grid gap-1 text-xs font-medium">使用量API URL<input value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} placeholder="https://example.com/api/ai-usage" inputMode="url" className="h-9 rounded-md border border-input bg-background px-2 text-sm font-normal" disabled={saving} /></label>
                        {screen.index !== null && <div className="flex justify-end border-t border-border pt-3"><Button type="button" variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={() => void removeDraft()} disabled={saving} aria-label={`${draft.app || "この"}連携先を削除`}><Trash2 aria-hidden /></Button></div>}
                    </>}
                    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                </div>
                <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
                    <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>{screen.kind === "list" ? "閉じる" : "キャンセル"}</Button>
                    {screen.kind === "edit" && <Button type="button" size="sm" onClick={() => void saveDraft()} disabled={loading || saving}>{saving ? "保存・取得中…" : "保存"}</Button>}
                </div>
            </div>
        </div>,
        document.body
    )
}

/** アプリごとのAI利用。どのアプリが、どのモデルで、どれだけ使っているかを見る。 */
export function AiAppUsage() {
    const { aiAppUsage: snapshot, refreshAiAppUsage } = useDashboardData()
    const [settingsOpen, setSettingsOpen] = useState(false)
    const onSaved = () => refreshAiAppUsage()

    if (snapshot) {
        return (
            <>
                <AiAppUsageView snapshot={snapshot} onManageSources={() => setSettingsOpen(true)} />
                {settingsOpen && <AiAppUsageSourcesModal onClose={() => setSettingsOpen(false)} onSaved={onSaved} />}
            </>
        )
    }

    // 取得前も管理画面を開けるよう、骨組みと設定ボタンは残す。
    return (
        <>
            <section className="space-y-3 sm:space-y-4">
                <SectionHeading
                    title="アプリ別のAI利用"
                    trailing={<Button type="button" variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>連携先を管理</Button>}
                />
                <SkeletonGroup
                    label="アプリ別のAI利用"
                    className="space-y-3 rounded-xl border border-border bg-card p-3 sm:p-4"
                >
                    <SkeletonBar />
                    <SkeletonBar />
                    <SkeletonBar />
                </SkeletonGroup>
            </section>
            {settingsOpen && <AiAppUsageSourcesModal onClose={() => setSettingsOpen(false)} onSaved={onSaved} />}
        </>
    )
}
