import { summarizeTimers } from "@/lib/host-stats/timers"
import type { UptimeKumaMonitor } from "@/lib/uptime-kuma"
import type { UptimeRobotMonitor } from "@/lib/uptimerobot"
import type { MonitorFeed } from "@/lib/monitor-feed"
import type { HostStatsHostView } from "@/types/host-stats"
import { formatJst } from "@/lib/incidents/messages"
import { RESTART_TOLERANCE_MS, type HostEvent, type Incident } from "@/lib/incidents/types"

/**
 * ホスト停止・再起動の検知と、未解消エラー件数の算出（#495）。入出力だけの純関数で、
 * 時刻は引数で渡す。オンラインかどうかは呼び出し側が `judgeHostOnline`（画面と共通）で決めた
 * `HostStatsHostView.online` をそのまま使い、ここでは別に判定しない。
 */

/** ホストごとに永続化する、前回の判定結果 */
export interface HostState {
    /** 前回判定に使った最終受信（ISO）。これより古い・同じ受信は順序逆転・再処理として再起動の判定に使わない */
    receivedAt: string
    /** 前回の起動時刻の推定（epoch ミリ秒）＝受信時刻 − 稼働時間 */
    bootMs: number
    /** 受信が途絶えている（停止疑い）として扱っているか */
    down: boolean
}

export type HostStates = Record<string, HostState>

export function estimateBootMs(view: HostStatsHostView): number {
    return new Date(view.latest.receivedAt).getTime() - view.latest.uptimeSeconds * 1000
}

/**
 * 各ホストの前回状態と今回の観測を比べ、通知すべき出来事を返す。
 *
 * - 初めて見たホストは状態を覚えるだけで通知しない（初回登録・過去に途絶えたままのホスト）
 * - 受信が途絶えたら `down`、再開したら `recovered`。途絶えずに稼働時間だけが巻き戻ったら `restart`
 * - 再起動は「起動時刻の推定」が許容を超えて新しくなったときだけ。順序逆転した古い受信では判定しない
 * - 正常終了か異常終了かは分からないため、種別は「再起動」までに留める
 */
export function evaluateHosts(
    hosts: HostStatsHostView[],
    previous: HostStates,
    nowIso: string
): { next: HostStates; events: HostEvent[] } {
    const next: HostStates = {}
    const events: HostEvent[] = []

    for (const host of hosts) {
        const prior = previous[host.id]
        const bootMs = estimateBootMs(host)
        const down = !host.online

        if (!prior) {
            next[host.id] = { receivedAt: host.latest.receivedAt, bootMs, down }
            continue
        }

        const isNewer = new Date(host.latest.receivedAt).getTime() > new Date(prior.receivedAt).getTime()
        const rebooted = isNewer && bootMs - prior.bootMs > RESTART_TOLERANCE_MS
        const base = {
            hostId: host.id,
            label: host.label,
            at: nowIso,
            lastReceivedAt: host.latest.receivedAt,
        }

        if (!prior.down && down) {
            events.push({ ...base, id: `${host.id}:down:${nowIso}`, kind: "down" })
            // 途絶えた時点の最終受信を覚え直さない（再開時にそのときの稼働時間と比べる）
            next[host.id] = { ...prior, down: true }
            continue
        }

        if (prior.down && !down) {
            events.push({ ...base, id: `${host.id}:recovered:${nowIso}`, kind: "recovered", rebooted })
        } else if (!down && rebooted) {
            events.push({ ...base, id: `${host.id}:restart:${nowIso}`, kind: "restart" })
        }

        next[host.id] = isNewer
            ? { receivedAt: host.latest.receivedAt, bootMs, down }
            : { ...prior, down }
    }

    return { next, events }
}

/** 監視（Kuma・UptimeRobot）の取得結果。失敗は `error` に入り、モニターは空になる */
export interface MonitorInputs {
    kuma: MonitorFeed<Pick<UptimeKumaMonitor, "id" | "name" | "status">>
    robot: MonitorFeed<Pick<UptimeRobotMonitor, "id" | "friendly_name" | "status">>
}

export interface IncidentEvaluation {
    incidents: Incident[]
    unavailable: string[]
}

const KUMA_PREFIX = "monitor:kuma:"
const ROBOT_PREFIX = "monitor:robot:"

/**
 * 未解消エラーの一覧を作る。件数は `incidents.length`。
 *
 * | 種類 | 既存判定との対応 |
 * | --- | --- |
 * | ホスト停止疑い | `online === false`（OFFLINE表示・停止通知と同じ値） |
 * | サービス停止 | オンラインのホストの `services[].active === false`（ホストカードの停止扱い） |
 * | 定期ジョブ異常 | `summarizeTimers` の異常（オフラインのホストは除外済み。取得不可は件数に入れない） |
 * | センサーの取得停止 | オンラインのホストの `sensors.items[].abnormal`（`evaluateSensors`。#581） |
 * | サイト監視のDOWN | Kuma `down`・UptimeRobot `status >= 8`（監視タブのdangerと同じ） |
 *
 * ホストが停止疑いの間は、配下のサービス・ジョブ・センサーの古い状態を足さない（1件にまとめる）。
 * 監視の取得に失敗した系統は「DOWN 0件」とせず、前回のその系統のエラーを持ち越して
 * 「取得不可」に載せる。定期ジョブの取得不可も同じ欄に載せる。
 */
export function evaluateIncidents(input: {
    hosts: HostStatsHostView[]
    monitors: MonitorInputs
    previous: Incident[]
    now: number
}): IncidentEvaluation {
    const nowIso = new Date(input.now).toISOString()
    const sinceByKey = new Map(input.previous.map((incident) => [incident.key, incident.since]))
    const incidents = new Map<string, Incident>()
    const unavailable: string[] = []

    const add = (incident: Omit<Incident, "since">) => {
        if (incidents.has(incident.key)) return
        incidents.set(incident.key, { ...incident, since: sinceByKey.get(incident.key) ?? nowIso })
    }

    for (const host of input.hosts) {
        if (host.online) {
            for (const service of host.latest.services ?? []) {
                if (service.active) continue
                add({
                    key: `service:${host.id}:${service.name}`,
                    kind: "service",
                    title: `${host.label}: ${service.name} が停止`,
                    detail: service.state,
                })
            }
            // センサーの取得停止（#581）。ホストが応答している間だけ数える（応答なしの間はホスト1件にまとめる）
            if (host.sensors && !host.sensors.available) {
                unavailable.push(`${host.label}: センサーの取得状況を読めません`)
            }
            for (const sensor of host.sensors?.items ?? []) {
                if (!sensor.abnormal) continue
                add({
                    key: `sensor:${host.id}:${sensor.name}`,
                    kind: "sensor",
                    title: `${host.label}: ${sensor.name} の取得が止まっています`,
                    detail: sensor.label,
                })
            }
            continue
        }
        add({
            key: `host:${host.id}`,
            kind: "host-down",
            title: `${host.label}: 受信が途絶えています`,
            detail: `最終受信 ${formatJst(host.latest.receivedAt)}`,
        })
    }

    const timers = summarizeTimers(input.hosts, input.now)
    for (const name of timers.abnormalNames) {
        add({ key: `timer:${name}`, kind: "timer", title: `定期ジョブの異常: ${name}` })
    }
    if (timers.unknown > 0) unavailable.push(`定期ジョブ ${timers.unknown}件の状態を取得できません`)

    const carryOver = (prefix: string, label: string, error: string) => {
        unavailable.push(`${label}を取得できません（${error}）`)
        for (const incident of input.previous) {
            if (incident.key.startsWith(prefix)) incidents.set(incident.key, incident)
        }
    }

    if (input.monitors.kuma.error !== null) {
        carryOver(KUMA_PREFIX, "Uptime Kuma", input.monitors.kuma.error)
    } else {
        for (const monitor of input.monitors.kuma.monitors) {
            if (monitor.status !== "down") continue
            add({ key: `${KUMA_PREFIX}${monitor.id}`, kind: "monitor", title: `${monitor.name} がDOWN` })
        }
    }

    if (input.monitors.robot.error !== null) {
        carryOver(ROBOT_PREFIX, "UptimeRobot", input.monitors.robot.error)
    } else {
        for (const monitor of input.monitors.robot.monitors) {
            // 0: 一時停止・1: 未確認・2: 稼働中・8: ダウンの疑い・9: ダウン
            if (monitor.status < 8) continue
            add({ key: `${ROBOT_PREFIX}${monitor.id}`, kind: "monitor", title: `${monitor.friendly_name} がDOWN` })
        }
    }

    return { incidents: [...incidents.values()], unavailable }
}

/** 件数・一覧が変わったかを見分ける署名（変わったときだけ `seq` を進める） */
export function incidentSignature(evaluation: IncidentEvaluation): string {
    return JSON.stringify([evaluation.incidents.map((incident) => incident.key).sort(), evaluation.unavailable])
}
