import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { diskMeasurementAgeSeconds, isDiskMeasurementStale } from "@/lib/host-stats/format"

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0)
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()

describe("ディスク計測の鮮度（#663）", () => {
    it("経過秒数を返し、時刻が無い・読めないときは undefined", () => {
        assert.equal(diskMeasurementAgeSeconds(ago(90), NOW), 90)
        assert.equal(diskMeasurementAgeSeconds(undefined, NOW), undefined)
        assert.equal(diskMeasurementAgeSeconds("not-a-date", NOW), undefined)
    })

    it("未来の時刻（ホストの時計のずれ）は0秒として扱う", () => {
        assert.equal(diskMeasurementAgeSeconds(ago(-60), NOW), 0)
    })

    it("1時間ごとの計測を2回取りこぼす程度（3時間）から止まっているとみなす", () => {
        assert.equal(isDiskMeasurementStale(diskMeasurementAgeSeconds(ago(3600 + 120), NOW)), false)
        assert.equal(isDiskMeasurementStale(diskMeasurementAgeSeconds(ago(3 * 3600 - 1), NOW)), false)
        assert.equal(isDiskMeasurementStale(diskMeasurementAgeSeconds(ago(3 * 3600), NOW)), true)
        assert.equal(isDiskMeasurementStale(diskMeasurementAgeSeconds(ago(65 * 86400), NOW)), true)
    })

    it("経過が分からないときは止まっているとは言わない", () => {
        assert.equal(isDiskMeasurementStale(undefined), false)
    })
})
