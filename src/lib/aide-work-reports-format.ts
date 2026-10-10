import type { StatusTone } from "@/components/status-badge"
import type { WorkReport, WorkStatus } from "@/types/aide-work-reports"

export const WORK_STATUS_LABEL: Record<WorkStatus, string> = {
    started: "開始",
    running: "実行中",
    waiting: "待機",
    completed: "完了",
    failed: "失敗",
    cancelled: "取消",
}

const WORK_STATUS_TONE: Record<WorkStatus, StatusTone> = {
    started: "info",
    running: "ok",
    waiting: "info",
    completed: "ok",
    failed: "danger",
    cancelled: "neutral",
}

export interface WorkDisplay {
    /** バッジに出す文言 */
    label: string
    tone: StatusTone
    /** 更新途絶（最後の報告から時間が経っている）。状態は「最後の報告」であって現在ではない */
    stale: boolean
}

/**
 * 画面に出す状態。更新途絶（AIDEの freshness=stale）は報告された状態を現在のものとして出さず、
 * 「更新なし」にする。**完了・失敗とは推定しない**（実行中・待機のまま止まっているだけで、
 * 終わったとも壊れたとも分からない）。
 */
export function displayWork(work: WorkReport): WorkDisplay {
    if (work.freshness === "stale") return { label: "更新なし（状態不明）", tone: "warn", stale: true }
    return { label: WORK_STATUS_LABEL[work.status], tone: WORK_STATUS_TONE[work.status], stale: false }
}

/** 関連リンクとして出してよいのは https だけ。AIDE側でも弾いているが、受け取った値をそのまま信用しない */
export function safeLink(raw: string): { href: string; host: string } | null {
    try {
        const url = new URL(raw)
        if (url.protocol !== "https:" || url.username || url.password) return null
        return { href: url.href, host: url.host }
    } catch {
        return null
    }
}
