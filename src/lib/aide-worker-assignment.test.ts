import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { hostOutlook, parseWorkerAssignment } from "@/lib/aide-worker-assignment"
import type { AideWorkerAssignment } from "@/types/aide-status"

const NOW = Date.parse("2026-11-23T05:00:00Z")

function minutesAgo(minutes: number): string {
    return new Date(NOW - minutes * 60_000).toISOString()
}

/** AIDE の `GET /api/worker/assignment`（aide#891 の `toView`）と同じ形 */
function payload(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        mode: "auto",
        owner: "subpc",
        hosts: [
            { host: "subpc", alive: true, lastSeenAt: minutesAgo(1), aliveSince: minutesAgo(600) },
            { host: "macmini", alive: true, lastSeenAt: minutesAgo(2), aliveSince: minutesAgo(3000) },
        ],
        lastSwitch: { at: minutesAgo(900), from: "macmini", to: "subpc", reason: "failback" },
        modeChangedAt: null,
        policy: { failoverAfterMinutes: 15, failbackAfterMinutes: 30, continuityGapMinutes: 10 },
        ...overrides,
    }
}

function parsed(overrides: Partial<Record<string, unknown>> = {}): AideWorkerAssignment {
    const result = parseWorkerAssignment(payload(overrides))
    assert.ok(result)
    return result
}

function hostOf(assignment: AideWorkerAssignment, host: "subpc" | "macmini") {
    const row = assignment.hosts.find((item) => item.host === host)
    assert.ok(row)
    return row
}

describe("parseWorkerAssignment", () => {
    it("AIDEの応答をそのまま取り込む", () => {
        const result = parsed()
        assert.equal(result.mode, "auto")
        assert.equal(result.owner, "subpc")
        assert.equal(result.hosts.length, 2)
        assert.deepEqual(result.lastSwitch?.reason, "failback")
        assert.equal(result.policy.failoverAfterMinutes, 15)
    })

    it("問い合わせの記録が無いホスト（null）も受け付ける", () => {
        const result = parsed({
            hosts: [{ host: "macmini", alive: false, lastSeenAt: null, aliveSince: null }],
            lastSwitch: null,
        })
        assert.equal(result.hosts[0]?.lastSeenAt, null)
        assert.equal(result.lastSwitch, null)
    })

    it("知らないホストの行は捨てる", () => {
        const result = parsed({
            hosts: [
                { host: "subpc", alive: true, lastSeenAt: minutesAgo(1), aliveSince: minutesAgo(10) },
                { host: "deskmini", alive: true, lastSeenAt: minutesAgo(1), aliveSince: minutesAgo(10) },
            ],
        })
        assert.deepEqual(
            result.hosts.map((row) => row.host),
            ["subpc"]
        )
    })

    it("骨格が合わなければ null", () => {
        assert.equal(parseWorkerAssignment(null), null)
        assert.equal(parseWorkerAssignment(payload({ mode: "manual" })), null)
        assert.equal(parseWorkerAssignment(payload({ owner: "deskmini" })), null)
        assert.equal(parseWorkerAssignment(payload({ policy: {} })), null)
        assert.equal(parseWorkerAssignment(payload({ lastSwitch: { at: "x", from: "subpc", to: "macmini" } })), null)
    })
})

describe("hostOutlook", () => {
    it("自動・担当ホストは途切れた時間を引き継ぎの閾値で測る", () => {
        const assignment = parsed({
            hosts: [
                { host: "subpc", alive: true, lastSeenAt: minutesAgo(6), aliveSince: minutesAgo(600) },
                { host: "macmini", alive: true, lastSeenAt: minutesAgo(2), aliveSince: minutesAgo(3000) },
            ],
        })
        const outlook = hostOutlook(assignment, hostOf(assignment, "subpc"), NOW)
        assert.equal(outlook.text, "途切れて 6分 / 15分で Mac mini へ引き継ぎ")
        assert.equal(outlook.progress, 6 / 15)
        assert.equal(outlook.tone, "ok")
    })

    it("もう一方も止まっていれば、移り先が無いことを添える", () => {
        const assignment = parsed({
            owner: "macmini",
            hosts: [
                { host: "subpc", alive: false, lastSeenAt: minutesAgo(600), aliveSince: minutesAgo(900) },
                { host: "macmini", alive: true, lastSeenAt: minutesAgo(2), aliveSince: minutesAgo(3000) },
            ],
        })
        const outlook = hostOutlook(assignment, hostOf(assignment, "macmini"), NOW)
        assert.match(outlook.text, /DeskMiniも止まっているため移り先なし/)
    })

    it("自動・担当でない主ホストは、続いた時間を戻しの閾値で測る", () => {
        const assignment = parsed({
            owner: "macmini",
            hosts: [
                { host: "subpc", alive: true, lastSeenAt: minutesAgo(1), aliveSince: minutesAgo(18) },
                { host: "macmini", alive: true, lastSeenAt: minutesAgo(2), aliveSince: minutesAgo(3000) },
            ],
        })
        const outlook = hostOutlook(assignment, hostOf(assignment, "subpc"), NOW)
        assert.equal(outlook.text, "連続 18分 / 30分でDeskMiniへ戻します")
        assert.equal(outlook.progress, 18 / 30)
        assert.equal(outlook.tone, "warn")
    })

    it("止まっている主ホストはバーを出さない", () => {
        const assignment = parsed({
            owner: "macmini",
            hosts: [
                { host: "subpc", alive: false, lastSeenAt: minutesAgo(600), aliveSince: minutesAgo(900) },
                { host: "macmini", alive: true, lastSeenAt: minutesAgo(2), aliveSince: minutesAgo(3000) },
            ],
        })
        const outlook = hostOutlook(assignment, hostOf(assignment, "subpc"), NOW)
        assert.equal(outlook.progress, null)
        assert.equal(outlook.tone, "danger")
    })

    it("自動・担当でない予備ホストは待機", () => {
        const assignment = parsed()
        assert.equal(hostOutlook(assignment, hostOf(assignment, "macmini"), NOW).text, "待機中（担当が止まったら引き継ぎます）")
    })

    it("固定中は自動の切り替えを測らない", () => {
        const assignment = parsed({ mode: "macmini", owner: "macmini", modeChangedAt: minutesAgo(60) })
        const owner = hostOutlook(assignment, hostOf(assignment, "macmini"), NOW)
        const other = hostOutlook(assignment, hostOf(assignment, "subpc"), NOW)
        assert.equal(owner.progress, null)
        assert.equal(other.text, "固定中のため担当外（ジョブは見送り）")
    })
})
