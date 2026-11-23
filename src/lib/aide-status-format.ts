import type { AideJob, AideSeverity } from "@/types/aide-status"

/** AIDEの判定をダッシュボードの状態色へ。unknown（材料が無い）は異常ではないので色を付けない */
export const AIDE_SEVERITY_TONE: Record<AideSeverity, "ok" | "warn" | "danger" | "neutral"> = {
    ok: "ok",
    warn: "warn",
    danger: "danger",
    unknown: "neutral",
}

export const AIDE_SEVERITY_LABEL: Record<AideSeverity, string> = {
    ok: "正常",
    warn: "注意",
    danger: "異常",
    unknown: "記録なし",
}

/** 「2時間5分」「3日4時間」。AIDEの画面と同じ表記に揃え、移管前と読み比べられるようにする */
export function formatAideDuration(minutes: number): string {
    if (minutes < 60) return `${minutes}分`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}時間${minutes % 60}分`
    return `${Math.floor(hours / 24)}日${hours % 24}時間`
}

/** sv-SE は「2026-09-14 14:32」の形になる。見る人はAIDEと同じく日本時間で読む */
const JST_FORMAT = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
})

/** 「09-14 14:32」。年は並べても区別に役立たないので落とす */
export function formatAideDateTime(iso: string): string {
    return JST_FORMAT.format(new Date(iso)).slice(5)
}

/** 記録の時刻。今日のぶんは時刻だけにして、日付の繰り返しで表を太らせない */
export function formatAideLogTime(iso: string, now: number): string {
    const [date, time] = JST_FORMAT.format(new Date(iso)).split(" ")
    const today = JST_FORMAT.format(new Date(now)).split(" ")[0]
    return date === today ? (time ?? "") : `${date?.slice(5)} ${time}`
}

/** 定期ジョブ1件の状態を表す短い語。AIDEタブと概要で同じ表記にする */
export function jobLabel(job: AideJob): string {
    if (!job.lastRun) return AIDE_SEVERITY_LABEL[job.severity]
    if (!job.lastRun.ok) return "失敗"
    // 成功しているが間隔ぶん動いていない。「成功」のまま黄色にすると何が悪いのか読めない
    return job.severity === "warn" ? "遅れ" : "成功"
}
