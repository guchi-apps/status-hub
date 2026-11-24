import { shouldJumpOnClick } from "@/lib/section-anchors"
import { cn } from "@/lib/utils"

/**
 * タブの中に並べるカードの外枠。見出しの高さを揃え、中身だけを差し替える。
 *
 * `onOpen` を渡すと、カード全体を押して詳細へ移動できる（#682）。「詳細」ボタンは置かない（#694）。
 */
export function Panel({
    title,
    trailing,
    className,
    children,
    id,
    onOpen,
}: {
    title: string
    trailing?: React.ReactNode
    className?: string
    children: React.ReactNode
    id?: string
    onOpen?: () => void
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
            </div>
            {children}
        </section>
    )
}
