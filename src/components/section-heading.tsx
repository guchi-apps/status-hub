import { cn } from "@/lib/utils"

interface SectionHeadingProps {
    title: string
    trailing?: React.ReactNode
    className?: string
}

export function SectionHeading({ title, trailing, className }: SectionHeadingProps) {
    return (
        <div className={cn("flex items-center gap-4", className)}>
            <div className="h-8 w-1 shrink-0 bg-highlight rounded-full" />
            <h2 className="shrink-0 whitespace-nowrap text-xl md:text-2xl font-bold text-foreground tracking-tight">
                {title}
            </h2>
            {trailing && <div className="flex items-center gap-2 ml-auto min-w-0">{trailing}</div>}
        </div>
    )
}
