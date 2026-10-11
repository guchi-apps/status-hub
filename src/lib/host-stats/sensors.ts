import { formatAge } from "@/lib/host-stats/format"
import type { HostSensorStatus, HostSensorsView, HostStatsSensors } from "@/types/host-stats"

/**
 * センサーの取得状況の判定（#581）。
 *
 * 画面（ホストカード・稼働システム）と未解消エラー件数（src/lib/incidents/）で同じ判断を使う。
 * 判定はサーバー側の `toHostView` で1回だけ行い、結果を `HostStatsHostView.sensors` に載せる
 * （閾値の環境変数をクライアントへ配らずに済み、`online` と同じ時点の判定になる）。
 *
 * 判定材料はエージェントが送ってきた「最後に取得に成功した時刻」だけで、ここではセンサーにも
 * MyRoom にも問い合わせない。
 */

/**
 * 最後の成功からこの秒数を超えたら「取得停止」とみなす既定値。
 * Pi Zero W の SwitchBot 取得は5分ごとで、SwitchBot 側のアドバタイズも約5分おきのため、
 * 1回の取りこぼしは珍しくない。3周期（15分）続けて取れなかったら止まっていると扱う。
 */
const DEFAULT_SENSOR_STALE_SECONDS = 900

export function getSensorStaleAfterSeconds(): number {
    const parsed = Number.parseInt(process.env.HOST_STATS_SENSOR_STALE_SECONDS ?? "", 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SENSOR_STALE_SECONDS
}

function ageSince(value: string | undefined, now: number): number | undefined {
    if (!value) return undefined
    const time = new Date(value).getTime()
    if (!Number.isFinite(time)) return undefined
    // ホストの時計が進んでいても「未来に成功した」とは出さない
    return Math.max(0, Math.round((now - time) / 1000))
}

/**
 * センサーごとの状態を判定する。
 *
 * 判定の順番には意味がある。ホストが応答していなければ、最後に受け取った状態ファイルは古いので
 * 正常とも停止とも言えない（ホスト1件の「応答なし」にまとめ、センサー側で二重に鳴らさない）。
 * 成功が閾値内に収まっていれば、直近の1回が失敗していても停止とは扱わない（取りこぼしの範囲）。
 */
export function evaluateSensors(
    sensors: HostStatsSensors | undefined,
    options: { now: number; hostOnline: boolean; staleAfterSeconds: number }
): HostSensorsView | undefined {
    if (!sensors) return undefined

    const { now, hostOnline, staleAfterSeconds } = options
    const items = sensors.items.map((sensor): HostSensorStatus => {
        const successAgeSeconds = ageSince(sensor.lastSuccessAt, now)
        const base = { name: sensor.name, successAgeSeconds, lastResult: sensor.lastResult }

        if (!hostOnline) {
            return { ...base, state: "unknown", abnormal: false, label: "不明（ホスト応答なし）" }
        }

        if (successAgeSeconds === undefined) {
            // 試みた記録はあるのに一度も成功していない＝取れていない。試行の記録も無ければ判断材料が無い
            return sensor.lastAttemptAt
                ? { ...base, state: "stale", abnormal: true, label: "取得できていません（成功記録なし）" }
                : { ...base, state: "unknown", abnormal: false, label: "未取得" }
        }

        if (successAgeSeconds > staleAfterSeconds) {
            return {
                ...base,
                state: "stale",
                abnormal: true,
                label: `取得停止（最終成功 ${formatAge(successAgeSeconds)}）`,
            }
        }

        if (sensor.lastResult && sensor.lastResult !== "success") {
            return {
                ...base,
                state: "retrying",
                abnormal: false,
                label: `直近は失敗（${sensor.lastResult}）· 最終成功 ${formatAge(successAgeSeconds)}`,
            }
        }

        return { ...base, state: "ok", abnormal: false, label: `取得 ${formatAge(successAgeSeconds)}` }
    })

    return { available: sensors.available, staleAfterSeconds, items }
}
