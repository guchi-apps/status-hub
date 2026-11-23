import type {
    AideAssignmentMode,
    AideSwitchReason,
    AideWorkerAssignment,
    AideWorkerHost,
    AideWorkerHostView,
} from "@/types/aide-status"

/**
 * worker ジョブの担当ホスト（#668。AIDE側は guchi-apps/aide#891）の、応答の検査と表示用の計算。
 *
 * 画面（クライアント）からも読むため、Node専用のモジュールやトークンの取得はここに置かない
 * （取得は `aide-status.ts`）。担当の判定そのものはAIDEが行い、ここでは返ってきた値を
 * 「次に何が起きるか」の文に直すだけ。閾値も応答の `policy` を使い、こちらで値を持たない。
 */

export const WORKER_HOSTS: readonly AideWorkerHost[] = ["subpc", "macmini"]

/** AIDEの主ホスト。自動モードではここへ戻す */
export const PRIMARY_WORKER_HOST: AideWorkerHost = "subpc"

export const WORKER_HOST_LABEL: Record<AideWorkerHost, string> = {
    subpc: "DeskMini",
    macmini: "Mac mini",
}

export const ASSIGNMENT_MODES: readonly AideAssignmentMode[] = ["auto", "subpc", "macmini"]

export const ASSIGNMENT_MODE_LABEL: Record<AideAssignmentMode, string> = {
    auto: "自動",
    subpc: "DeskMiniに固定",
    macmini: "Mac miniに固定",
}

export const SWITCH_REASON_LABEL: Record<AideSwitchReason, string> = {
    failover: "自動で引き継ぎ",
    failback: "自動で戻し",
    manual: "手動",
}

export function isWorkerHost(value: unknown): value is AideWorkerHost {
    return typeof value === "string" && (WORKER_HOSTS as readonly string[]).includes(value)
}

export function isAssignmentMode(value: unknown): value is AideAssignmentMode {
    return value === "auto" || isWorkerHost(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

function optionalString(value: unknown): string | null | undefined {
    if (value === null) return null
    return typeof value === "string" ? value : undefined
}

function isSwitchReason(value: unknown): value is AideSwitchReason {
    return value === "failover" || value === "failback" || value === "manual"
}

/**
 * AIDEの応答を検査して取り込む。骨格が合わなければ null（画面ごと落とさず「取得不可」にする）。
 * 知らないホスト名の行は捨てる（AIDE側でホストが増えても、表示できる分だけ出す）。
 */
export function parseWorkerAssignment(payload: unknown): AideWorkerAssignment | null {
    if (!isRecord(payload)) return null
    const { mode, owner, hosts, lastSwitch, modeChangedAt, policy } = payload
    if (!isAssignmentMode(mode) || !isWorkerHost(owner) || !Array.isArray(hosts) || !isRecord(policy)) return null

    const failoverAfterMinutes = policy.failoverAfterMinutes
    const failbackAfterMinutes = policy.failbackAfterMinutes
    const continuityGapMinutes = policy.continuityGapMinutes
    if (
        typeof failoverAfterMinutes !== "number" ||
        typeof failbackAfterMinutes !== "number" ||
        typeof continuityGapMinutes !== "number"
    ) {
        return null
    }

    const parsedHosts: AideWorkerHostView[] = []
    for (const row of hosts) {
        if (!isRecord(row) || !isWorkerHost(row.host) || typeof row.alive !== "boolean") continue
        const lastSeenAt = optionalString(row.lastSeenAt)
        const aliveSince = optionalString(row.aliveSince)
        if (lastSeenAt === undefined || aliveSince === undefined) return null
        parsedHosts.push({ host: row.host, alive: row.alive, lastSeenAt, aliveSince })
    }

    let parsedSwitch: AideWorkerAssignment["lastSwitch"] = null
    if (lastSwitch !== null && lastSwitch !== undefined) {
        if (
            !isRecord(lastSwitch) ||
            typeof lastSwitch.at !== "string" ||
            !isWorkerHost(lastSwitch.from) ||
            !isWorkerHost(lastSwitch.to) ||
            !isSwitchReason(lastSwitch.reason)
        ) {
            return null
        }
        parsedSwitch = { at: lastSwitch.at, from: lastSwitch.from, to: lastSwitch.to, reason: lastSwitch.reason }
    }

    const changedAt = optionalString(modeChangedAt)
    return {
        mode,
        owner,
        hosts: parsedHosts,
        lastSwitch: parsedSwitch,
        modeChangedAt: changedAt ?? null,
        policy: { failoverAfterMinutes, failbackAfterMinutes, continuityGapMinutes },
    }
}

function minutesSince(iso: string | null, now: number): number | null {
    if (!iso) return null
    const at = Date.parse(iso)
    if (Number.isNaN(at)) return null
    return Math.max(0, Math.floor((now - at) / 60_000))
}

/** 「連続稼働」に出す分数。止まっているホストは数えない（null） */
export function continuousMinutes(host: AideWorkerHostView, now: number): number | null {
    return host.alive ? minutesSince(host.aliveSince, now) : null
}

export function lastSeenMinutes(host: AideWorkerHostView, now: number): number | null {
    return minutesSince(host.lastSeenAt, now)
}

function otherHost(host: AideWorkerHost): AideWorkerHost {
    return host === "subpc" ? "macmini" : "subpc"
}

export interface HostOutlook {
    /** そのホストについて、次に何が起きるか（または起きないか）の一文 */
    text: string
    /**
     * 自動で切り替わる条件への近さ（0〜1）。引き継ぎは途切れた時間、戻しは続いた時間で測る。
     * 測る対象が無いときは null（バーを出さない）
     */
    progress: number | null
    /** バーの色。戻しへ向かう途中は切り替わりが近いことを示すため warn */
    tone: "ok" | "warn" | "danger"
}

function ratio(value: number, limit: number): number {
    if (limit <= 0) return 1
    return Math.min(1, Math.max(0, value / limit))
}

/**
 * ホストごとの見通し。判定の規則は AIDE の `src/core/worker-assignment.ts` の `evaluate` と同じ順に読む。
 *
 * - 固定: 担当は止まっても移らない／担当でない側はジョブを見送る
 * - 自動・担当ホスト: 問い合わせが途切れた時間 ÷ 引き継ぎの閾値
 * - 自動・担当でない主ホスト: 問い合わせが続いた時間 ÷ 戻しの閾値
 * - 自動・担当でない予備ホスト: 待機
 */
export function hostOutlook(assignment: AideWorkerAssignment, host: AideWorkerHostView, now: number): HostOutlook {
    const { mode, owner, policy, hosts } = assignment
    const label = WORKER_HOST_LABEL
    const isOwner = host.host === owner

    if (mode !== "auto") {
        return isOwner
            ? { text: "固定中は止まっても移しません", progress: null, tone: "ok" }
            : { text: "固定中のため担当外（ジョブは見送り）", progress: null, tone: "ok" }
    }

    if (isOwner) {
        const silent = lastSeenMinutes(host, now)
        const other = otherHost(host.host)
        const otherAlive = hosts.find((row) => row.host === other)?.alive ?? false
        if (silent === null) {
            return { text: "問い合わせの記録がありません", progress: null, tone: "warn" }
        }
        const limit = policy.failoverAfterMinutes
        const base = `途切れて ${silent}分 / ${limit}分で ${label[other]} へ引き継ぎ`
        const progress = ratio(silent, limit)
        if (!otherAlive) {
            return {
                text: `${base}（${label[other]}も止まっているため移り先なし）`,
                progress,
                tone: host.alive ? "ok" : "danger",
            }
        }
        return { text: base, progress, tone: host.alive ? "ok" : "danger" }
    }

    if (host.host === PRIMARY_WORKER_HOST) {
        const limit = policy.failbackAfterMinutes
        const continuing = continuousMinutes(host, now)
        if (continuing === null) {
            return {
                text: `問い合わせが${limit}分続いたら${label[host.host]}へ戻します`,
                progress: null,
                tone: "danger",
            }
        }
        return {
            text: `連続 ${continuing}分 / ${limit}分で${label[host.host]}へ戻します`,
            progress: ratio(continuing, limit),
            tone: "warn",
        }
    }

    return host.alive
        ? { text: "待機中（担当が止まったら引き継ぎます）", progress: null, tone: "ok" }
        : { text: "応答なし（担当が止まっても引き継げません）", progress: null, tone: "danger" }
}
