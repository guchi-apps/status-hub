import fs from "fs/promises"
import path from "path"
import { notifyDiscordAlert } from "@/lib/discord-alert"
import { getHostDataDir, writeFileAtomic } from "@/lib/host-stats/store"
import {
    evaluateTimers,
    getTimerFailureThreshold,
    type TimerState,
    type TimerStatus,
} from "@/lib/host-stats/timers"
import type { HostStatsTimer } from "@/types/host-stats"

/**
 * 定期ジョブの異常をDiscordへ通知する（#75・#625）。
 *
 * **通知するのは異常だけ。** 復旧は通知しない（状態は記録する）。
 *
 * **鳴らしすぎないことが要件の中心**。毎時のジョブが1日壊れれば24回失敗し、エージェントは
 * 毎分同じ状態を送ってくる。そのまま流すと通知が無視されるようになり、仕組みごと意味を失う。
 * そこで「最後に通知した状態」をホストごとのファイルに持ち、**状態が変わったときだけ**送る。
 *
 * 置き場は最新スナップショット・履歴と同じ `.data/host-stats/<識別子>/` 配下。
 * ここはデプロイの削除対象に入らないため、ダッシュボードを再デプロイしても再送しない。
 */

const STATE_FILE = "timer-alerts.json"

/** 通知済みの状態。`ok` は「復旧まで通知し終えている」ことを表す */
type NotifiedState = TimerState | "ok"

interface TimerAlertState {
    /** 最後に通知した状態。undefined は一度も観測していないユニット */
    notifiedState?: NotifiedState
    notifiedAt?: string
    /** 連続して失敗した「実行」の回数。受信回数ではない */
    failureCount: number
    /** 失敗回数を数えるための、最後に観測した実行の終了時刻 */
    lastFinishedAt?: string
}

type TimerAlertStore = Record<string, TimerAlertState>

function getStatePath(hostId: string): string {
    return path.join(getHostDataDir(hostId), STATE_FILE)
}

async function readState(hostId: string): Promise<TimerAlertStore> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(getStatePath(hostId), "utf8"))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
        return parsed as TimerAlertStore
    } catch {
        // 初回・壊れたファイルは「まだ何も通知していない」として扱う
        return {}
    }
}

function formatTime(value: string | undefined): string | undefined {
    if (!value) return undefined
    const time = new Date(value)
    if (Number.isNaN(time.getTime())) return undefined
    return time.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
}

function timerFields(timer: HostStatsTimer): { name: string; value: string }[] {
    const entries: { name: string; value: string }[] = [{ name: "ユニット", value: timer.unit }]

    const lastFinishedAt = formatTime(timer.lastFinishedAt)
    if (lastFinishedAt) entries.push({ name: "最終実行", value: lastFinishedAt })

    const nextElapseAt = formatTime(timer.nextElapseAt)
    if (nextElapseAt) entries.push({ name: "次回予定", value: nextElapseAt })

    return entries
}

/**
 * 1ユニット分の状態を進め、通知すべきなら通知の内容を返す。
 *
 * 失敗のしきい値だけは「連続した実行の回数」で数える。同じ失敗が毎分送られてくるため、
 * 受信回数で数えるとしきい値がすぐ埋まり、設定した意味が無くなる。
 */
function advance(
    status: TimerStatus,
    previous: TimerAlertState,
    threshold: number,
    nowIso: string
): { next: TimerAlertState; notify: "alert" | null } {
    const next: TimerAlertState = { ...previous }

    const runChanged = status.timer.lastFinishedAt !== previous.lastFinishedAt
    next.lastFinishedAt = status.timer.lastFinishedAt

    if (status.state === "failed") {
        // 終了時刻を送ってこないユニットでも1回目として数えられるよう、最低1にする
        next.failureCount = runChanged ? previous.failureCount + 1 : Math.max(previous.failureCount, 1)
    } else {
        next.failureCount = 0
    }

    let alertState: NotifiedState
    if (!status.abnormal) {
        alertState = "ok"
    } else if (status.state === "failed" && next.failureCount < threshold) {
        // しきい値に届くまでは状態を動かさない（届いた時点で初めて鳴る）
        alertState = previous.notifiedState ?? "ok"
    } else {
        alertState = status.state
    }

    if (alertState === previous.notifiedState) return { next, notify: null }

    next.notifiedState = alertState
    next.notifiedAt = nowIso

    // 初めて観測したユニットが正常なら、復旧通知は出さずに状態だけ覚える
    if (previous.notifiedState === undefined && alertState === "ok") return { next, notify: null }

    // 復旧は通知しない（#625。異常時のみ通知する方針）。状態だけ記録して次の異常に備える
    return { next, notify: alertState === "ok" ? null : "alert" }
}

/**
 * 受信したレポートの定期ジョブを判定し、状態が変わったユニットだけを通知する。
 *
 * **「通知済み」を記録するのは、Discordへ届いたものだけ。** 送れなかったユニットは
 * `notifiedState` を前回のまま残すので、次の受信で状態の変化として再び検出され、再送される。
 * 先に記録してから送ると、Discordが落ちている間の異常通知は二度と出ない。
 * 失敗回数（`failureCount`）と最終実行の時刻は、通知の成否によらず進める。
 *
 * 呼び出し元（POST /api/host-stats）を止めないよう、例外はここで握りつぶさず呼び出し側で
 * 受け止める前提にしている（保存は済んでおり、通知が落ちても画面表示は成立する）。
 */
export async function processTimerAlerts(input: {
    hostId: string
    hostLabel: string
    timers: HostStatsTimer[] | undefined
}): Promise<void> {
    if (!input.timers || input.timers.length === 0) return

    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    const threshold = getTimerFailureThreshold()
    const previous = await readState(input.hostId)
    const store: TimerAlertStore = {}
    const pending: { key: string; prior: TimerAlertState; status: TimerStatus; kind: "alert" }[] = []

    for (const status of evaluateTimers(input.timers, now)) {
        const key = status.timer.name
        const prior = previous[key] ?? { failureCount: 0 }

        // 取得できなかったユニットは判断材料が無い。状態を進めず、前回のまま持ち越す
        if (status.state === "unknown") {
            store[key] = prior
            continue
        }

        const { next, notify } = advance(status, prior, threshold, nowIso)
        store[key] = next
        if (notify) pending.push({ key, prior, status, kind: notify })
    }

    // 応答しない相手に1件ずつ待たされないよう並べて送る（呼び出し元のエージェントが待っている）。
    // 復旧は投稿しない（状態は記録済みなので、送ったものとして扱う）
    const delivered = await Promise.all(
        pending.map(({ status }) => {
            const failureCount = store[status.timer.name]?.failureCount ?? 0

            return notifyDiscordAlert({
                title: `定期ジョブの異常: ${input.hostLabel} / ${status.timer.name}`,
                description: [status.label, status.detail].filter(Boolean).join(" — "),
                fields: [
                    ...timerFields(status.timer),
                    ...(failureCount > 1 ? [{ name: "連続失敗", value: `${failureCount}回` }] : []),
                ],
            })
        })
    )

    // 送れなかったユニットは通知済みの記録だけを前回へ戻す。次の受信で再び「状態が変わった」と判定される
    pending.forEach(({ key, prior }, index) => {
        if (delivered[index]) return
        store[key] = { ...store[key], notifiedState: prior.notifiedState, notifiedAt: prior.notifiedAt }
    })

    // 監視対象から外したユニットは持ち越さない（store に入れていないので落ちる）
    await writeFileAtomic(getStatePath(input.hostId), `${JSON.stringify(store, null, 2)}\n`)
}
