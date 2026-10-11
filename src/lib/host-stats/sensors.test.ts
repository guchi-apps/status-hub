import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { evaluateIncidents, type MonitorInputs } from "@/lib/incidents/evaluate"
import { parseHostStatsReport } from "@/lib/host-stats/report"
import { evaluateSensors } from "@/lib/host-stats/sensors"
import type { HostStatsHostView, HostStatsSensors, HostStatsSnapshot } from "@/types/host-stats"

const NOW = Date.UTC(2026, 9, 11, 3, 0, 0)
const STALE = 900
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()

const BASE = {
    version: 1,
    hostname: "pi0w",
    cpuPercent: 12.4,
    memory: { usedBytes: 1, totalBytes: 2, usedPercent: 50 },
    disks: [{ path: "/", usedBytes: 1, totalBytes: 2, usedPercent: 50 }],
    loadAverage: [0.1, 0.2, 0.3],
    uptimeSeconds: 100,
    services: [],
}

function judge(sensors: HostStatsSensors, hostOnline = true) {
    return evaluateSensors(sensors, { now: NOW, hostOnline, staleAfterSeconds: STALE })
}

describe("センサーの取得状況の受信", () => {
    it("送ってこないホストは undefined のまま（未設定と0件を区別する）", () => {
        assert.equal(parseHostStatsReport(BASE).sensors, undefined)
    })

    it("日時として読めない時刻は落とし、最新に見せない", () => {
        const report = parseHostStatsReport({
            ...BASE,
            sensors: {
                available: true,
                items: [{ name: "リビング", lastSuccessAt: "not-a-date", lastAttemptAt: ago(60), lastResult: "success" }],
            },
        })
        assert.deepEqual(report.sensors, {
            available: true,
            items: [{ name: "リビング", lastAttemptAt: ago(60), lastSuccessAt: undefined, lastResult: "success" }],
        })
    })

    it("読めなかった（available:false）ことを保つ", () => {
        const report = parseHostStatsReport({ ...BASE, sensors: { available: false } })
        assert.deepEqual(report.sensors, { available: false, items: [] })
    })
})

describe("センサーの取得状況の判定", () => {
    it("閾値内に成功していれば正常。直近の1回だけの失敗は停止扱いにしない", () => {
        const view = judge({
            available: true,
            items: [
                { name: "リビング", lastSuccessAt: ago(120), lastAttemptAt: ago(120), lastResult: "success" },
                { name: "屋外", lastSuccessAt: ago(420), lastAttemptAt: ago(120), lastResult: "not_found" },
            ],
        })
        assert.deepEqual(
            view?.items.map((item) => [item.name, item.state, item.abnormal]),
            [
                ["リビング", "ok", false],
                ["屋外", "retrying", false],
            ]
        )
    })

    it("閾値を超えて成功が無ければ取得停止。片方だけの停止も区別できる", () => {
        const view = judge({
            available: true,
            items: [
                { name: "リビング", lastSuccessAt: ago(120), lastResult: "success" },
                { name: "屋外", lastSuccessAt: ago(STALE + 1), lastAttemptAt: ago(60), lastResult: "not_found" },
            ],
        })
        assert.deepEqual(view?.items.map((item) => item.state), ["ok", "stale"])
        assert.equal(view?.items[1].abnormal, true)
        assert.match(view?.items[1].label ?? "", /取得停止/)
    })

    it("試みているのに一度も成功していなければ停止、試行の記録も無ければ判断しない", () => {
        const view = judge({
            available: true,
            items: [
                { name: "リビング", lastAttemptAt: ago(60), lastResult: "not_found" },
                { name: "屋外" },
            ],
        })
        assert.deepEqual(view?.items.map((item) => [item.state, item.abnormal]), [
            ["stale", true],
            ["unknown", false],
        ])
    })

    it("ホストが応答していない間は、古い成功を正常とも停止とも出さない", () => {
        const view = judge(
            {
                available: true,
                items: [
                    { name: "リビング", lastSuccessAt: ago(60), lastResult: "success" },
                    { name: "屋外", lastSuccessAt: ago(STALE * 4), lastResult: "not_found" },
                ],
            },
            false
        )
        assert.deepEqual(view?.items.map((item) => [item.state, item.abnormal]), [
            ["unknown", false],
            ["unknown", false],
        ])
    })

    it("ホストの時計が進んでいても未来の成功にはしない", () => {
        const view = judge({ available: true, items: [{ name: "リビング", lastSuccessAt: ago(-300) }] })
        assert.equal(view?.items[0].successAgeSeconds, 0)
        assert.equal(view?.items[0].state, "ok")
    })
})

describe("センサーの取得停止と未解消エラー件数", () => {
    const monitors: MonitorInputs = { kuma: { monitors: [], error: null }, robot: { monitors: [], error: null } }

    function host(online: boolean, sensors: HostStatsSensors): HostStatsHostView {
        const latest = { id: "pi0w", hostname: "pi0w", receivedAt: ago(online ? 30 : 600), services: [] } as unknown as HostStatsSnapshot
        return {
            id: "pi0w",
            label: "Pi Zero W",
            latest,
            ageSeconds: online ? 30 : 600,
            online,
            history: [],
            sensors: evaluateSensors(sensors, { now: NOW, hostOnline: online, staleAfterSeconds: STALE }),
        }
    }

    const sensors: HostStatsSensors = {
        available: true,
        items: [
            { name: "リビング", lastSuccessAt: ago(60), lastResult: "success" },
            { name: "屋外", lastSuccessAt: ago(STALE * 2), lastResult: "not_found" },
        ],
    }

    it("応答しているホストの取得停止だけを1件ずつ数える", () => {
        const result = evaluateIncidents({ hosts: [host(true, sensors)], monitors, previous: [], now: NOW })
        assert.deepEqual(result.incidents.map((incident) => incident.key), ["sensor:pi0w:屋外"])
    })

    it("応答なしの間はホスト1件にまとめ、センサーを足さない", () => {
        const result = evaluateIncidents({ hosts: [host(false, sensors)], monitors, previous: [], now: NOW })
        assert.deepEqual(result.incidents.map((incident) => incident.key), ["host:pi0w"])
    })

    it("状態を読めないときは件数に入れず、取得できていない対象へ出す", () => {
        const result = evaluateIncidents({
            hosts: [host(true, { available: false, items: [] })],
            monitors,
            previous: [],
            now: NOW,
        })
        assert.equal(result.incidents.length, 0)
        assert.deepEqual(result.unavailable, ["Pi Zero W: センサーの取得状況を読めません"])
    })
})
