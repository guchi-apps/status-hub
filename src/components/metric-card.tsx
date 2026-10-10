import { DashboardCard } from "@/components/dashboard-card"
import { cn } from "@/lib/utils"

/** 使用率の色分け。概要タブとホストタブで同じ基準を使う */
export function getUsageColor(percent: number): string {
    if (percent >= 90) return "text-red-400"
    if (percent >= 75) return "text-amber-400"
    return "text-status-ok"
}

/** CPU温度の色分け。使用率（%）とは基準が違うため別に持つ */
export function getTemperatureColor(celsius: number): string {
    if (celsius >= 85) return "text-red-400"
    if (celsius >= 70) return "text-amber-400"
    return "text-status-ok"
}

/** 上限のない指標（Load・転送量）の色。値ごとに意味を持たせず、種類の見分けだけに使う */
export const NEUTRAL_METRIC_COLORS = {
    load: "text-highlight",
    network: "text-violet-400",
    diskIo: "text-teal-400",
} as const

interface MetricCardProps {
    label: string
    value: string
    detail?: string
    valueClassName?: string
    /** 値の下に敷く推移グラフなど */
    chart?: React.ReactNode
    /** 値を薄く表示する（サブPCがオフラインで、表示値が過去のものになっている場合） */
    dimmed?: boolean
    /** 渡すと押せるカードになり、詳細を開く入口として描く（#558）。押した要素が渡る（フォーカス復帰用） */
    onOpen?: (trigger: HTMLElement) => void
    /** 押せるカードの開く先の説明（読み上げ用）。例: 「subpc の CPU の詳細」 */
    openLabel?: string
    /** 異常を枠の色で示す。詳細を閉じていても気づけるようにするための要約 */
    alert?: "danger" | "warn"
}

export function MetricCard({
    label,
    value,
    detail,
    valueClassName,
    chart,
    dimmed,
    onOpen,
    openLabel,
    alert,
}: MetricCardProps) {
    const card = (
        <DashboardCard
            className={cn(
                "h-full flex flex-col justify-center items-center text-center px-3 py-4 sm:px-4 sm:py-5",
                dimmed && "opacity-60",
                alert === "danger" && "border-red-500/60",
                alert === "warn" && "border-amber-400/60",
                onOpen && "group-hover/open:border-primary/60"
            )}
        >
            {onOpen && (
                <span
                    aria-hidden="true"
                    className="absolute right-2.5 top-2 text-base leading-none text-muted-foreground"
                >
                    ›
                </span>
            )}
            <span className="text-[10px] sm:text-xs opacity-70 uppercase tracking-widest mb-1.5 sm:mb-2">
                {label}
            </span>
            <div className={cn("text-xl sm:text-2xl font-bold font-mono break-all", valueClassName)}>
                {value}
            </div>
            {detail && (
                <div className="text-xs sm:text-sm font-medium text-muted-foreground mt-1.5 sm:mt-2 break-words">
                    {detail}
                </div>
            )}
            {chart && <div className="w-full mt-2 sm:mt-3">{chart}</div>}
        </DashboardCard>
    )

    if (!onOpen) return card

    return (
        <button
            type="button"
            aria-haspopup="dialog"
            aria-label={openLabel}
            onClick={(event) => onOpen(event.currentTarget)}
            className="group/open block h-full w-full cursor-pointer rounded-xl text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
            {card}
        </button>
    )
}
