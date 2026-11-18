export function formatBytes(bytes: number): string {
    if (bytes <= 0) return "0 B"

    const units = ["B", "KB", "MB", "GB", "TB"]
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
    const value = bytes / 1024 ** exponent

    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}

export function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)

    if (days > 0) return `${days}d ${hours}h ${minutes}m`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
}

/** 「42秒前」「3時間前」のような経過時間の表示。最終受信・最終活動の両方で使う */
export function formatAge(seconds: number): string {
    if (seconds < 60) return `${seconds}秒前`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`
    return `${Math.floor(seconds / 86400)}日前`
}

/**
 * 「1.1M/s」のような、幅の狭い場所向けの転送量。
 * 概要タブの指標タイルは1行に収める必要があり、「1.1 MB/s」だと折り返してしまう。
 */
export function formatRateShort(bytesPerSecond: number): string {
    const [value, unit] = formatBytes(bytesPerSecond).split(" ")
    return `${value}${unit === "B" ? "" : unit.charAt(0)}/s`
}

/**
 * 「3時間後」のような、次に起きることまでの表示（定期ジョブの次回予定に使う）。
 * すでに過ぎている場合は formatAge と同じ「〜前」で返し、予定超過が読めるようにする。
 */
export function formatEta(seconds: number): string {
    if (seconds < 0) return formatAge(-seconds)
    if (seconds < 60) return "まもなく"
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分後`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間後`
    return `${Math.floor(seconds / 86400)}日後`
}

/** CPUカードの補足行。機種を送っていないホストでは undefined（今までどおり何も出さない） */
export function describeCpu(model: string | undefined, threads: number | undefined): string | undefined {
    // 狭いカードで折り返さないよう、機種の識別に要らない部分を削る（商標記号・内蔵GPU名・定格クロック）
    const name = model
        ?.replace(/\((R|TM|tm|r)\)/g, "")
        .replace(/\s+with\s+.*$/i, "")
        .replace(/\s+CPU(\s+@.*)?$/i, "")
        .replace(/\s+/g, " ")
        .trim()
    const count = threads && threads > 0 ? `${threads}スレッド` : undefined
    if (name && count) return `${name} · ${count}`
    return name || count
}

/**
 * ディスクの計測（1時間ごと）が止まったとみなす経過秒数（#663）。
 * 計測は1時間ごとなので、2回続けて取りこぼしたら止まっていると読む。
 */
export const DISK_MEASUREMENT_STALE_SECONDS = 3 * 3600

/** ディスクを測ってからの経過秒数。時刻が無い・読めないときは undefined */
export function diskMeasurementAgeSeconds(measuredAt: string | undefined, now: number): number | undefined {
    if (!measuredAt) return undefined

    const measured = Date.parse(measuredAt)
    if (Number.isNaN(measured)) return undefined

    return Math.max(0, Math.floor((now - measured) / 1000))
}

/** 計測が止まっているか。経過が分からないときは止まっているとは言わない */
export function isDiskMeasurementStale(ageSeconds: number | undefined): boolean {
    return ageSeconds !== undefined && ageSeconds >= DISK_MEASUREMENT_STALE_SECONDS
}
