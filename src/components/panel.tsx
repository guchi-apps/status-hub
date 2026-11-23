import { ChevronRight } from "lucide-react"
import { shouldJumpOnClick } from "@/lib/section-anchors"
import { cn } from "@/lib/utils"

/**
 * タブの中に並べるカードの外枠。見出しの高さを揃え、中身だけを差し替える。
 *
 * `onOpen` を渡すと、カード全体と見出し右の「〜で見る」ボタンから詳細へ移動できる（#682）。
 * ボタンはキーボード・スクリーンリーダー向けの本体で、カード全体のクリックはその補助。
 */
export function Panel({
    title,
    trailing,
    className,
    children,
    id,
    onOpen,
    openLabel,
}: {
    title: string
    trailing?: React.ReactNode
    className?: string
    children: React.ReactNode
    id?: string
    onOpen?: () => void
    openLabel?: string
}) {
    return (
        <section
            id={id}
            className={cn(
                "scroll-mt-28 rounded-xl border border-border bg-card p-3",
                onOpen && "cursor-pointer transition-colors hover:border-highlight/50",
                className
            )}
            onClick={
                onOpen
                    ? (event) => {
                          if (shouldJumpOnClick(event.target as Element, !!window.getSelection()?.toString())) {
                              onOpen()
                          }
                      }
                    : undefined
            }
        >
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="text-sm font-bold">{title}</h2>
                {trailing}
                {onOpen && <OpenButton onOpen={onOpen} label={openLabel ?? `${title}の詳細を開く`} />}
            </div>
            {children}
        </section>
    )
}

/** 概要カードの見出し右に置く、詳細へ移動するボタン */
export function OpenButton({ onOpen, label }: { onOpen: () => void; label: string }) {
    return (
        <button
            type="button"
            onClick={onOpen}
            aria-label={label}
            title={label}
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            詳細
            <ChevronRight className="size-3" aria-hidden />
        </button>
    )
}
