import { getUsageColor } from "@/components/metric-card"
import { cn } from "@/lib/utils"

const RADIUS = 40
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * 使用率の円グラフ。中心に%を出す（#683）。
 * `percent` が null のときは「その指標を持たない」ことを表し、空の輪と「—」を出す。
 * 色は他の使用率表示と同じしきい値（`getUsageColor`）。
 */
export function UsageRing({
    label,
    percent,
    caption,
}: {
    label: string
    percent: number | null
    caption?: string
}) {
    const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent))

    return (
        <div
            className={cn("min-w-0 text-center", percent === null ? "text-muted-foreground" : getUsageColor(percent))}
            role="img"
            aria-label={percent === null ? `${label}なし` : `${label}の使用率 ${percent}%`}
        >
            <svg viewBox="0 0 100 100" className="mx-auto block h-auto w-full max-w-24" aria-hidden="true">
                <circle cx="50" cy="50" r={RADIUS} fill="none" strokeWidth="10" className="stroke-muted" />
                {clamped > 0 && (
                    <circle
                        cx="50"
                        cy="50"
                        r={RADIUS}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="10"
                        strokeLinecap="round"
                        strokeDasharray={`${(CIRCUMFERENCE * clamped) / 100} ${CIRCUMFERENCE}`}
                        transform="rotate(-90 50 50)"
                    />
                )}
                <text
                    x="50"
                    y="50"
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="currentColor"
                    className="font-mono"
                    fontSize={percent === null ? 18 : percent >= 100 ? 17 : 19}
                    fontWeight="700"
                >
                    {percent === null ? (
                        "—"
                    ) : (
                        <>
                            {percent}
                            <tspan fontSize="11">%</tspan>
                        </>
                    )}
                </text>
            </svg>
            <div className="mt-0.5 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
            {caption && <div className="truncate text-[9px] text-muted-foreground">{caption}</div>}
        </div>
    )
}
