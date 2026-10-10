import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
    advanceIncidentState,
    deliverPending,
    EMPTY_INCIDENT_STATE,
    type IncidentState,
} from "@/lib/incidents/engine"
import { evaluateHosts, evaluateIncidents, type MonitorInputs } from "@/lib/incidents/evaluate"
import { buildHostMessage } from "@/lib/incidents/messages"
import { isHostAlertRecipient } from "@/lib/incidents/recipients"
import { judgeHostOnline } from "@/lib/host-stats/store"
import type { PushMessage, PushSendResult, StoredSubscription } from "@/lib/push/web-push"
import type { HostStatsHostView, HostStatsSnapshot, HostStatsTimer } from "@/types/host-stats"

const T0 = Date.UTC(2026, 9, 2, 8, 0, 0)
const MIN = 60_000
const OFFLINE_AFTER = 300

/** ホストの受信を作る。receivedAt は now から `agoSeconds` 前、稼働時間は `uptimeSeconds` */
function makeHost(
    now: number,
    options: {
        id?: string
        agoSeconds?: number
        uptimeSeconds?: number
        bootAt?: number
        services?: { name: string; state: string; active: boolean }[]
        timers?: HostStatsTimer[]
    } = {}
): HostStatsHostView {
    const id = options.id ?? "sub-pc"
    const receivedMs = now - (options.agoSeconds ?? 0) * 1000
    const uptimeSeconds =
        options.uptimeSeconds ?? Math.round((receivedMs - (options.bootAt ?? T0 - 10 * 60 * MIN)) / 1000)
    const latest = {
        id,
        hostname: id,
        receivedAt: new Date(receivedMs).toISOString(),
        uptimeSeconds,
        services: options.services ?? [],
        timers: options.timers,
    } as unknown as HostStatsSnapshot
    return { id, label: id, latest, history: [], ...judgeHostOnline(latest.receivedAt, now, OFFLINE_AFTER) }
}

const NO_MONITORS: MonitorInputs = { kuma: { monitors: [], error: null }, robot: { monitors: [], error: null } }

function step(state: IncidentState, hosts: HostStatsHostView[], now: number, monitors = NO_MONITORS) {
    return advanceIncidentState(state, { hosts, monitors, now })
}

describe("ホスト停止・再起動の検知", () => {
    it("初回登録では通知せず、すでに途絶えているホストも黙って覚える", () => {
        const state = step(EMPTY_INCIDENT_STATE, [makeHost(T0), makeHost(T0, { id: "mac", agoSeconds: 3600 })], T0)
        assert.equal(state.pending.length, 0)
        assert.equal(state.events.length, 0)
        assert.deepEqual(state.incidents.map((incident) => incident.key), ["host:mac"])
    })

    it("閾値を超えるまで通知せず、超えたら1回だけ通知して、継続中は繰り返さない", () => {
        let state = step(EMPTY_INCIDENT_STATE, [makeHost(T0)], T0)
        const lastSeen = T0
        const at = (minutes: number) => T0 + minutes * MIN

        state = step(state, [makeHost(at(4), { agoSeconds: 240 })], at(4))
        assert.equal(state.pending.length, 0)

        state = step(state, [makeHost(at(6), { agoSeconds: 360 })], at(6))
        assert.deepEqual(state.pending.map((item) => item.event.kind), ["down"])
        assert.equal(state.pending[0].event.lastReceivedAt, new Date(lastSeen).toISOString())
        assert.equal(state.incidents.length, 1)

        const pendingBefore = state.pending.length
        for (const minutes of [7, 8, 30]) {
            state = step(state, [makeHost(at(minutes), { agoSeconds: minutes * 60 })], at(minutes))
        }
        assert.equal(state.pending.length, pendingBefore)
        assert.equal(state.events.length, 1)
    })

    it("受信が再開したら復旧を通知し、再発は新しい障害として通知する", () => {
        let state = step(EMPTY_INCIDENT_STATE, [makeHost(T0)], T0)
        state = step(state, [makeHost(T0 + 6 * MIN, { agoSeconds: 360 })], T0 + 6 * MIN)
        state = step(state, [makeHost(T0 + 10 * MIN, { bootAt: T0 - 10 * 60 * MIN })], T0 + 10 * MIN)
        assert.deepEqual(state.events.map((event) => event.kind), ["recovered", "down"])
        assert.equal(state.events[0].rebooted, false)
        assert.equal(state.incidents.length, 0)

        state = step(state, [makeHost(T0 + 20 * MIN, { agoSeconds: 400 })], T0 + 20 * MIN)
        assert.deepEqual(state.events.map((event) => event.kind), ["down", "recovered", "down"])
    })

    it("途絶えている間に再起動していたら、復旧は再起動後としてまとめる", () => {
        let state = step(EMPTY_INCIDENT_STATE, [makeHost(T0)], T0)
        state = step(state, [makeHost(T0 + 6 * MIN, { agoSeconds: 360 })], T0 + 6 * MIN)
        state = step(state, [makeHost(T0 + 12 * MIN, { uptimeSeconds: 90 })], T0 + 12 * MIN)
        assert.deepEqual(state.events.map((event) => event.kind), ["recovered", "down"])
        assert.equal(state.events[0].rebooted, true)
    })

    it("5分以内に復旧した再起動は、稼働時間の巻き戻りから「再起動」として通知する", () => {
        let state = step(EMPTY_INCIDENT_STATE, [makeHost(T0)], T0)
        state = step(state, [makeHost(T0 + MIN, { uptimeSeconds: 40 })], T0 + MIN)
        assert.deepEqual(state.pending.map((item) => item.event.kind), ["restart"])
        assert.equal(state.incidents.length, 0)

        // 同じ受信を処理し直しても、再起動を重ねて通知しない
        const again = step(state, [makeHost(T0 + MIN, { uptimeSeconds: 40 })], T0 + MIN + 30_000)
        assert.equal(again.pending.length, 1)
    })

    it("稼働時間が揺れる程度・順序が逆転した古い受信は再起動と判定しない", () => {
        let state = step(EMPTY_INCIDENT_STATE, [makeHost(T0)], T0)
        state = step(state, [makeHost(T0 + MIN, { uptimeSeconds: 10 * 60 * 60 + 60 - 20 })], T0 + MIN)
        assert.equal(state.pending.length, 0)

        // 古い受信（受信時刻が前回より前）が読まれても、巻き戻りとして数えない
        const older = makeHost(T0 - 5 * MIN, { uptimeSeconds: 100 })
        const reordered = evaluateHosts([{ ...older, online: true }], state.hosts, new Date(T0 + 2 * MIN).toISOString())
        assert.equal(reordered.events.length, 0)
    })

    it("正常終了か異常終了かを断定しない文面になる", () => {
        const event = { id: "x", hostId: "sub-pc", label: "サブPC", kind: "restart" as const, at: new Date(T0).toISOString(), lastReceivedAt: new Date(T0 - MIN).toISOString() }
        const message = buildHostMessage(event, { count: 2, seq: 7 })
        assert.match(message.title, /再起動/)
        assert.match(message.body, /不明/)
        assert.equal(message.badge, 2)
        assert.equal(message.seq, 7)
        assert.match(message.url ?? "", /tab=hosts/)

        const down = buildHostMessage({ ...event, kind: "down" }, { count: 1, seq: 8 })
        assert.match(down.body, /特定できません/)
        assert.doesNotMatch(down.body, /電源断です|クラッシュ/)
    })
})

describe("未解消エラー件数", () => {
    const failedTimer = {
        name: "backup",
        unit: "backup.timer",
        available: true,
        loaded: true,
        active: true,
        enabled: "enabled",
        result: "exit-code",
        exitStatus: 1,
        lastFinishedAt: new Date(T0).toISOString(),
    } as unknown as HostStatsTimer

    it("停止ホストは1件にまとめ、配下のサービス・ジョブの古い状態は足さない", () => {
        const services = [{ name: "nginx", state: "failed", active: false }]
        const stale = makeHost(T0, { id: "sub-pc", agoSeconds: 3600, services, timers: [failedTimer] })
        const online = makeHost(T0, { id: "mac", services, timers: [failedTimer] })

        const { incidents } = evaluateIncidents({ hosts: [stale, online], monitors: NO_MONITORS, previous: [], now: T0 })
        const keys = incidents.map((incident) => incident.key).sort()
        assert.deepEqual(keys, ["host:sub-pc", "service:mac:nginx", "timer:mac: backup"])
    })

    it("同じキーは重複して数えず、続いている間は since を変えない", () => {
        const host = makeHost(T0, { services: [{ name: "a", state: "failed", active: false }] })
        const first = evaluateIncidents({ hosts: [host, host], monitors: NO_MONITORS, previous: [], now: T0 })
        assert.equal(first.incidents.length, 1)

        const later = evaluateIncidents({
            hosts: [makeHost(T0 + MIN, { services: [{ name: "a", state: "failed", active: false }] })],
            monitors: NO_MONITORS,
            previous: first.incidents,
            now: T0 + MIN,
        })
        assert.equal(later.incidents[0].since, first.incidents[0].since)
    })

    it("Kuma・UptimeRobotのDOWNを数え、一時停止・未確認は数えない", () => {
        const monitors: MonitorInputs = {
            kuma: {
                monitors: [
                    { id: 1, name: "site", status: "down" },
                    { id: 2, name: "ok", status: "up" },
                    { id: 3, name: "wait", status: "pending" },
                ],
                error: null,
            },
            robot: {
                monitors: [
                    { id: 1, friendly_name: "a", status: 9 },
                    { id: 2, friendly_name: "b", status: 8 },
                    { id: 3, friendly_name: "c", status: 0 },
                    { id: 4, friendly_name: "d", status: 2 },
                ],
                error: null,
            },
        }
        const { incidents } = evaluateIncidents({ hosts: [], monitors, previous: [], now: T0 })
        assert.equal(incidents.length, 3)
    })

    it("監視の取得に失敗した系統はDOWN 0件とせず、前回のエラーを持ち越して取得不可に載せる", () => {
        const down: MonitorInputs = {
            ...NO_MONITORS,
            kuma: { monitors: [{ id: 1, name: "site", status: "down" }], error: null },
        }
        const first = evaluateIncidents({ hosts: [], monitors: down, previous: [], now: T0 })

        const failed: MonitorInputs = { ...NO_MONITORS, kuma: { monitors: [], error: "HTTP 500" } }
        const next = evaluateIncidents({ hosts: [], monitors: failed, previous: first.incidents, now: T0 + MIN })
        assert.equal(next.incidents.length, 1)
        assert.equal(next.unavailable.length, 1)

        const none = evaluateIncidents({ hosts: [], monitors: failed, previous: [], now: T0 })
        assert.equal(none.incidents.length, 0)
        assert.equal(none.unavailable.length, 1)
    })

    it("定期ジョブの取得不可は件数に入れず、取得不可の欄に出す", () => {
        const unknownTimer = { ...failedTimer, available: false } as unknown as HostStatsTimer
        const result = evaluateIncidents({
            hosts: [makeHost(T0, { timers: [unknownTimer] })],
            monitors: NO_MONITORS,
            previous: [],
            now: T0,
        })
        assert.equal(result.incidents.length, 0)
        assert.equal(result.unavailable.length, 1)
    })

    it("復旧済みの再起動は件数に残らず、通番は変化のあったときだけ進む", () => {
        let state = step(EMPTY_INCIDENT_STATE, [makeHost(T0)], T0)
        const seq0 = state.seq
        state = step(state, [makeHost(T0 + 30_000)], T0 + 30_000)
        assert.equal(state.seq, seq0)

        state = step(state, [makeHost(T0 + MIN, { uptimeSeconds: 30 })], T0 + MIN)
        assert.ok(state.seq > seq0)
        assert.equal(state.incidents.length, 0)
        assert.equal(state.events.length, 1)
    })
})

describe("通知の送信と再送", () => {
    function pendingState(): IncidentState {
        let state = step(EMPTY_INCIDENT_STATE, [makeHost(T0)], T0)
        state = step(state, [makeHost(T0 + 6 * MIN, { agoSeconds: 360 })], T0 + 6 * MIN)
        return state
    }

    const result = (delivered: number): PushSendResult => ({ delivered, removed: 0, failures: [] })

    it("届いたら待ちから外し、届かなければ残して間隔を空けて再送する", async () => {
        const now = T0 + 6 * MIN
        const sent: PushMessage[] = []
        const failed = await deliverPending(pendingState(), async (message) => (sent.push(message), result(0)), now)
        assert.equal(failed.pending.length, 1)
        assert.equal(failed.pending[0].attempts, 1)

        // 再送の間隔内では送らない
        await deliverPending(failed, async (message) => (sent.push(message), result(1)), now + 1000)
        assert.equal(sent.length, 1)

        const ok = await deliverPending(failed, async (message) => (sent.push(message), result(1)), now + 31_000)
        assert.equal(ok.pending.length, 0)
        assert.equal(sent.length, 2)
    })

    it("送信が例外で落ちても通知を失わず、再起動をまたいでも待ちが残る", async () => {
        const failed = await deliverPending(pendingState(), async () => { throw new Error("boom") }, T0 + 6 * MIN)
        assert.equal(failed.pending.length, 1)

        // 永続化された状態を読み直しても、同じ障害を新しく検知し直さない
        const reloaded = JSON.parse(JSON.stringify(failed)) as IncidentState
        const again = step(reloaded, [makeHost(T0 + 7 * MIN, { agoSeconds: 420 })], T0 + 7 * MIN)
        assert.equal(again.pending.length, 1)
    })

    it("1時間を過ぎた障害通知は捨てる", async () => {
        const dropped = await deliverPending(pendingState(), async () => result(0), T0 + 6 * MIN + 61 * MIN)
        assert.equal(dropped.pending.length, 0)
    })
})

describe("通知先の絞り込み", () => {
    const base = { endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" }, createdAt: "" }
    const sub = (extra: Partial<StoredSubscription>): StoredSubscription => ({ ...base, ...extra })
    const allowed = (email: string) => email === "ok@example.com"

    it("許可された利用者の、オンの端末だけが受け取る", () => {
        assert.equal(isHostAlertRecipient(sub({ email: "ok@example.com" }), allowed), true)
        assert.equal(isHostAlertRecipient(sub({ email: "ok@example.com", hostAlerts: false }), allowed), false)
    })

    it("取り消された利用者・利用者が未記録の購読には送らない", () => {
        assert.equal(isHostAlertRecipient(sub({ email: "revoked@example.com" }), allowed), false)
        assert.equal(isHostAlertRecipient(sub({}), allowed), false)
    })
})
