import type { HostStatsHostView, HostStatsTmuxSession } from "@/types/host-stats"

/** デタッチのまま、これを超えて活動がないセッションを「放置」として色を変える */
export const TMUX_STALE_AFTER_SECONDS = 86_400

/**
 * コマンドは動いているが、これを超えて画面が動いていないセッションを「入力待ち」として分ける。
 *
 * claude は起動しっぱなしが常態のため、プロセスの有無だけでは手が止まっているセッションを
 * 見分けられない。処理中は画面が描き変わり続けるので、その停止を代わりの手掛かりにする。
 */
export const TMUX_WAITING_AFTER_SECONDS = 60

/**
 * フックが記録するイベント名のうち、「人を待っている」ことを直接示すもの。
 *
 * 記録されるのは issue-deck の `session-notify.sh` が扱う3種類だけ（`scripts/lib/session-state.sh`）。
 *
 * - `permission_prompt` — 承認プロンプト・質問を出して人を待っている
 * - `working` — **人が答えて作業へ戻った**（入力待ちではない）
 * - `Stop` — 応答の終了。次の作業へ入っていることもあるため、これだけでは入力待ちと断定しない
 *
 * **知らない名前は入力待ちに数えない。** issue-deck 側がイベントを増やしたときに、
 * 意味の分からない名前を全部「人を待っている」と読むと、動いているセッションまで
 * 入力待ちに倒れる（#72 では `working` がこの形で誤判定されていた）。
 * 数えられなかった分は、画面が止まっているかの判定が拾う。
 */
const WAITING_EVENT_NAMES = new Set(["permission_prompt"])

/**
 * running — シェル以外のコマンドが動いていて、画面も動いている（処理中）
 * waiting — コマンドは動いているが人の入力を待っている
 * idle    — シェルだけで止まっている
 * stale   — デタッチのまま24時間以上 活動がない
 */
export type TmuxSessionState = "running" | "waiting" | "idle" | "stale"

export interface TmuxSessionView extends HostStatsTmuxSession {
    hostId: string
    hostLabel: string
    state: TmuxSessionState
    /** セッションが作られてからの経過秒数。作成時刻が読めないホストでは undefined */
    ageSeconds?: number
    /** 最後に活動してからの経過秒数。エージェントが古いホストでは undefined */
    inactiveSeconds?: number
    /** その理由で止まっている秒数。回収の判定に乗らないセッションでは undefined */
    holdForSeconds?: number
    /** Claude Code のフックが最後にイベントを記録してからの経過秒数 */
    sinceLastEventSeconds?: number
}

export interface TmuxSummary {
    running: number
    /** 人の入力を待っているセッション。放置と違い、こちらが動けば進む */
    waiting: number
    idle: number
    stale: number
    /** 送信上限で切り捨てられた分を含むセッションの総数 */
    total: number
    /**
     * 送信上限で切り捨てられ、一覧に載らなかったセッション数。
     * 中身が分からないため running / idle / stale の内訳には入らない。
     */
    untracked: number
    /** tmux の情報を送ってきているホストが1つでもあるか（無ければ画面に出さない） */
    available: boolean
}

/** 状態ごとの表示名。バッジ・一覧・凡例で同じ言葉を使う */
export const TMUX_STATE_LABELS: Record<TmuxSessionState, string> = {
    running: "稼働中",
    waiting: "入力待ち",
    idle: "待機中",
    stale: "放置",
}

const STATE_ORDER: Record<TmuxSessionState, number> = {
    running: 0,
    waiting: 1,
    idle: 2,
    stale: 3,
}

function elapsedSeconds(isoTime: string | undefined, nowMs: number): number | undefined {
    if (!isoTime) return undefined

    const time = Date.parse(isoTime)
    if (Number.isNaN(time)) return undefined

    return Math.max(0, Math.floor((nowMs - time) / 1000))
}

function getState(
    session: HostStatsTmuxSession,
    inactiveSeconds: number | undefined,
    ageSeconds: number | undefined
): TmuxSessionState {
    // busy を送ってこない世代のエージェントでは、アタッチの有無で代用するしかない
    const running = session.busy ?? session.attached
    if (running) {
        // **フックが「人を待っている」と言っているなら、それが事実。** 画面の動きから推し量る必要はない。
        if (session.lastEventName !== undefined && WAITING_EVENT_NAMES.has(session.lastEventName)) {
            return "waiting"
        }

        // フックが届かないセッション（手で立てたもの）と、人を待っているとは限らないイベント
        // （`working`・`Stop`・知らない名前）で止まっているセッションは、画面が止まっているかで判断する
        if (inactiveSeconds !== undefined && inactiveSeconds >= TMUX_WAITING_AFTER_SECONDS) {
            return "waiting"
        }

        return "running"
    }

    if (session.attached) return "idle"

    const quietSeconds = inactiveSeconds ?? ageSeconds
    if (quietSeconds !== undefined && quietSeconds >= TMUX_STALE_AFTER_SECONDS) return "stale"

    return "idle"
}

/** 放置（デタッチのまま24時間以上動きが無い）か。ディスクの掃除でまとめて閉じる対象（#657） */
export function isStaleTmuxSession(session: HostStatsTmuxSession, nowMs: number): boolean {
    return (
        getState(session, elapsedSeconds(session.lastActivityAt, nowMs), elapsedSeconds(session.createdAt, nowMs)) ===
        "stale"
    )
}

/** 全ホストの tmux セッションを1つの一覧にまとめる。並びは 稼働中 → 待機中 → 放置 */
export function collectTmuxSessions(hosts: HostStatsHostView[], nowMs: number): TmuxSessionView[] {
    const sessions = hosts.flatMap((host) =>
        (host.latest.tmuxSessions ?? []).map((session) => {
            const ageSeconds = elapsedSeconds(session.createdAt, nowMs)
            const inactiveSeconds = elapsedSeconds(session.lastActivityAt, nowMs)

            return {
                ...session,
                hostId: host.id,
                hostLabel: host.label,
                ageSeconds,
                inactiveSeconds,
                holdForSeconds: elapsedSeconds(session.holdReasonAt, nowMs),
                sinceLastEventSeconds: elapsedSeconds(session.lastEventAt, nowMs),
                state: getState(session, inactiveSeconds, ageSeconds),
            }
        })
    )

    return sessions.sort((a, b) => {
        const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state]
        if (byState !== 0) return byState

        // 同じ状態なら、動きの新しいものを上に出す
        return (a.inactiveSeconds ?? a.ageSeconds ?? 0) - (b.inactiveSeconds ?? b.ageSeconds ?? 0)
    })
}

export function summarizeTmux(
    hosts: HostStatsHostView[],
    sessions: TmuxSessionView[]
): TmuxSummary {
    const count = (state: TmuxSessionState) =>
        sessions.filter((session) => session.state === state).length

    // エージェントは送るセッション数に上限があり、超えた分は一覧に載らない。
    // 総数まで一覧の長さで数えると、セッションが積み上がっていること自体が画面から消える
    const untracked = hosts.reduce((sum, host) => {
        const { tmuxSessions, tmuxSessionTotal } = host.latest
        if (tmuxSessions === undefined || tmuxSessionTotal === undefined) return sum
        return sum + Math.max(0, tmuxSessionTotal - tmuxSessions.length)
    }, 0)

    return {
        running: count("running"),
        waiting: count("waiting"),
        idle: count("idle"),
        stale: count("stale"),
        total: sessions.length + untracked,
        untracked,
        available: hosts.some((host) => host.latest.tmuxSessions !== undefined),
    }
}
