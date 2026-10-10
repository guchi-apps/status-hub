"use client"

import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * ホスト詳細を出すダイアログ（#558）。広い画面は右のドロワー、狭い画面はボトムシート。
 *
 * タブ切り替えの transform の中では `fixed` が画面基準にならないため、body 直下へ portal で出す
 * （job-history-modal.tsx と同じ理由）。Tab は中で循環させ、閉じたら開いたカードへフォーカスを戻す。
 * 復帰先は呼び出し側が渡すカードの要素（ポーリングの再描画でも同じ要素が残る）。
 */
export function HostDetailDialog({
    title,
    subtitle,
    returnFocusTo,
    onClose,
    children,
}: {
    title: string
    subtitle?: string
    returnFocusTo: HTMLElement | null
    onClose: () => void
    children: React.ReactNode
}) {
    const panelRef = useRef<HTMLDivElement>(null)
    const closeRef = useRef<HTMLButtonElement>(null)
    const onCloseRef = useRef(onClose)

    useEffect(() => {
        onCloseRef.current = onClose
    }, [onClose])

    useEffect(() => {
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = "hidden"
        closeRef.current?.focus()

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onCloseRef.current()
                return
            }
            if (event.key !== "Tab" || !panelRef.current) return

            const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
            if (items.length === 0) return

            const first = items[0]
            const last = items[items.length - 1]
            const active = document.activeElement
            if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
                event.preventDefault()
                last.focus()
            } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
                event.preventDefault()
                first.focus()
            }
        }
        document.addEventListener("keydown", onKeyDown)

        return () => {
            document.removeEventListener("keydown", onKeyDown)
            document.body.style.overflow = previousOverflow
            returnFocusTo?.focus()
        }
    }, [returnFocusTo])

    return createPortal(
        <div className="fixed inset-0 z-[60] bg-black/60" onClick={onClose}>
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label={subtitle ? `${title}（${subtitle}）` : title}
                onClick={(event) => event.stopPropagation()}
                className="absolute inset-x-0 bottom-0 top-16 flex flex-col overflow-hidden rounded-t-2xl border border-border bg-popover text-popover-foreground shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:top-0 sm:w-[460px] sm:max-w-full sm:rounded-none sm:border-y-0 sm:border-r-0"
            >
                <div className="flex shrink-0 items-start gap-2.5 border-b border-border px-4 pb-3 pt-3.5">
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold [overflow-wrap:anywhere]">{title}</div>
                        {subtitle && <div className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</div>}
                    </div>
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={onClose}
                        aria-label="閉じる"
                        className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                    >
                        ✕
                    </button>
                </div>
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
                    {children}
                </div>
            </div>
        </div>,
        document.body
    )
}
