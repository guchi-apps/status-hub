import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HostStatsReportError, parseHostStatsReport } from "@/lib/host-stats/report"

const BASE = {
    version: 1,
    hostname: "subpc",
    cpuPercent: 12.4,
    memory: { usedBytes: 1, totalBytes: 2, usedPercent: 50 },
    disks: [{ path: "/", usedBytes: 1, totalBytes: 2, usedPercent: 50 }],
    loadAverage: [0.1, 0.2, 0.3],
    uptimeSeconds: 100,
    services: [],
}

const DISK = { usedBytes: 108_000_000_000, totalBytes: 126_000_000_000, usedPercent: 85.7 }

describe("場所別のディスク使用量（diskWatch）", () => {
    it("場所ごとの使用量・分母・計測時刻を受け取る", () => {
        const report = parseHostStatsReport({
            ...BASE,
            diskWatch: {
                items: [
                    { path: "/tmp/node-compile-cache", bytes: 14_000_000_000 },
                    { path: "/home/guchi/.npm", bytes: 11_000_000_000 },
                ],
                disk: DISK,
                measuredAt: "2026-11-13T05:00:00Z",
            },
        })

        assert.deepEqual(report.diskWatch, {
            items: [
                { path: "/tmp/node-compile-cache", bytes: 14_000_000_000 },
                { path: "/home/guchi/.npm", bytes: 11_000_000_000 },
            ],
            disk: DISK,
            measuredAt: "2026-11-13T05:00:00Z",
        })
    })

    it("測れなかった場所は 0 ではなく null のまま残す", () => {
        const report = parseHostStatsReport({
            ...BASE,
            diskWatch: { items: [{ path: "/nonexistent", bytes: null }, { path: "/tmp/x" }] },
        })

        assert.deepEqual(report.diskWatch?.items, [
            { path: "/nonexistent", bytes: null },
            { path: "/tmp/x", bytes: null },
        ])
        assert.equal(report.diskWatch?.disk, undefined)
    })

    it("送ってこない世代のエージェントでは undefined", () => {
        assert.equal(parseHostStatsReport(BASE).diskWatch, undefined)
        assert.equal(parseHostStatsReport({ ...BASE, diskWatch: null }).diskWatch, undefined)
    })

    it("日時として読めない計測時刻は落とす", () => {
        const report = parseHostStatsReport({ ...BASE, diskWatch: { items: [], measuredAt: "not-a-date" } })
        assert.equal(report.diskWatch?.measuredAt, undefined)
    })

    it("上限（10か所）を超えた分は切る", () => {
        const items = Array.from({ length: 15 }, (_, index) => ({ path: `/p${index}`, bytes: index }))
        const report = parseHostStatsReport({ ...BASE, diskWatch: { items } })
        assert.equal(report.diskWatch?.items.length, 10)
    })

    it("形が壊れていれば弾く", () => {
        assert.throws(() => parseHostStatsReport({ ...BASE, diskWatch: { items: "x" } }), HostStatsReportError)
        assert.throws(() => parseHostStatsReport({ ...BASE, diskWatch: { items: [{ bytes: 1 }] } }), HostStatsReportError)
        assert.throws(
            () => parseHostStatsReport({ ...BASE, diskWatch: { items: [{ path: "/a", bytes: "1" }] } }),
            HostStatsReportError
        )
    })

    it("負の値は0に丸める", () => {
        const report = parseHostStatsReport({ ...BASE, diskWatch: { items: [{ path: "/a", bytes: -5 }] } })
        assert.equal(report.diskWatch?.items[0].bytes, 0)
    })
})

describe("ディスクの掃除（cleanup）", () => {
    it("対象・見込み・前回の結果を受け取る", () => {
        const report = parseHostStatsReport({
            ...BASE,
            cleanup: {
                targets: [
                    { id: "tmux-stale", bytes: null, count: null },
                    {
                        id: "npm-cache",
                        bytes: 4_445_704_192,
                        count: null,
                        lastRun: {
                            requestedAt: 1_794_913_839_000,
                            status: "ok",
                            startedAt: "2026-11-17T11:11:37Z",
                            finishedAt: "2026-11-17T11:12:00Z",
                            freedBytes: 4_400_000_000,
                        },
                    },
                    { id: "tmp-stale", bytes: 653_803_520, count: 22_342 },
                ],
                measuredAt: "2026-11-17T11:10:39Z",
            },
        })

        assert.deepEqual(report.cleanup, {
            targets: [
                { id: "tmux-stale", bytes: null, count: null, lastRun: undefined },
                {
                    id: "npm-cache",
                    bytes: 4_445_704_192,
                    count: null,
                    lastRun: {
                        requestedAt: 1_794_913_839_000,
                        status: "ok",
                        startedAt: "2026-11-17T11:11:37Z",
                        finishedAt: "2026-11-17T11:12:00Z",
                        freedBytes: 4_400_000_000,
                        count: undefined,
                        message: undefined,
                    },
                },
                { id: "tmp-stale", bytes: 653_803_520, count: 22_342, lastRun: undefined },
            ],
            measuredAt: "2026-11-17T11:10:39Z",
        })
    })

    it("知らない対象・重複は捨て、知らない状態の結果は無かったことにする", () => {
        const report = parseHostStatsReport({
            ...BASE,
            cleanup: {
                targets: [
                    { id: "rm-rf-root", bytes: 1 },
                    { id: "npm-cache", bytes: 1, lastRun: { requestedAt: 1, status: "weird" } },
                    { id: "npm-cache", bytes: 2 },
                ],
            },
        })
        assert.deepEqual(report.cleanup?.targets, [{ id: "npm-cache", bytes: 1, count: null, lastRun: undefined }])
    })

    it("送ってこない世代のエージェントでは undefined、形が壊れていれば弾く", () => {
        assert.equal(parseHostStatsReport(BASE).cleanup, undefined)
        assert.throws(() => parseHostStatsReport({ ...BASE, cleanup: { targets: "x" } }), HostStatsReportError)
    })
})
