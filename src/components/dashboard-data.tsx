"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { MIN_FORCE_REFRESH_MS } from "@/lib/usage-cache"
import type { AiAppUsageSnapshot } from "@/types/ai-app-usage"
import type { AiUsageSnapshot } from "@/types/ai-usage"
import type { AideStatusSnapshot } from "@/types/aide-status"
import type { GitHubUsageSnapshot } from "@/types/github-usage"
import type { HostStatsView } from "@/types/host-stats"
import type { OnePasswordUsageSnapshot } from "@/types/onepassword-usage"
import type { MonitorFeed } from "@/lib/monitor-feed"
import type { UptimeKumaMonitor } from "@/lib/uptime-kuma"
import type { UptimeRobotMonitor } from "@/lib/uptimerobot"

/** ホストのメトリクス。エージェントの送信間隔（既定1分）より短くても害はない */
const HOST_STATS_INTERVAL_MS = 30_000

/** 監視サービス。障害に気づくのが遅れない程度の間隔にする */
const MONITOR_INTERVAL_MS = 60_000

/**
 * AIDEの動作状況。AIDEは手元の記録を読むだけで返し、外部へは問い合わせないため、
 * 監視と同じ間隔で取っても相手に負荷は掛からない
 */
const AIDE_STATUS_INTERVAL_MS = 60_000

/** AI・GitHub・1Passwordの使用状況。サーバー側のキャッシュ（既定5分）に合わせる */
const USAGE_INTERVAL_MS = 300_000

/** リセットまでの残り時間や経過時間の表示を進めるための再描画間隔 */
const CLOCK_INTERVAL_MS = 30_000

/**
 * 手動更新を続けて押せない時間。
 * サーバー側も同じ間隔でキャッシュを返すため（`MIN_FORCE_REFRESH_MS`）、
 * ここを短くしても提供元へは取りにいかない。押せるのに値が変わらない状態を作らないよう合わせる。
 * AIだけは提供元の推奨に合わせて180秒までサーバー側がキャッシュを返すため、
 * この間隔で押し直してもAIのカードだけは時刻が進まないことがある。
 */
const REFRESH_COOLDOWN_MS = MIN_FORCE_REFRESH_MS

/** 更新に失敗した表示を残す時間。押した結果が伝わる程度に出して、自動取得の表示へ戻す */
const REFRESH_ERROR_VISIBLE_MS = 8_000

/** 手動更新の状態。idle=押せる / refreshing=取得中 / error=直前の手動更新が失敗した */
export type RefreshState = "idle" | "refreshing" | "error"

/** サーバー側で取得済みの初期値。初回描画で監視の枠が空にならないようにする */
export interface DashboardInitialData {
    uptimeKuma: MonitorFeed<UptimeKumaMonitor>
    uptimeRobot: MonitorFeed<UptimeRobotMonitor>
}

interface DashboardData extends DashboardInitialData {
    hostStats: HostStatsView | null
    aiUsage: AiUsageSnapshot | null
    /** アプリ別のAI利用（#325）。未取得なら null */
    aiAppUsage: AiAppUsageSnapshot | null
    githubUsage: GitHubUsageSnapshot | null
    onepasswordUsage: OnePasswordUsageSnapshot | null
    /** AIDEの動作状況。未取得なら null */
    aideStatus: AideStatusSnapshot | null
    /** 残り時間の計算に使う現在時刻。各コンポーネントが個別にタイマーを持たなくて済むよう配る */
    now: number
    /** いずれかのデータを最後に受け取った時刻（epoch ミリ秒）。未受信なら null */
    updatedAt: number | null
    /** ヘッダーの更新ボタン。自動取得を待たずに全ソースを取り直す */
    refresh: () => void
    refreshState: RefreshState
    /** 連打を抑えている残り秒数。0 なら押せる */
    refreshCooldownSeconds: number
    /**
     * Uptime Kuma の一覧だけを取り直す。モニターを追加した直後に使う。
     * ヘッダーの更新ボタンと違って全ソースを叩かないため、連打の抑制も掛けていない。
     */
    refreshUptimeKuma: () => Promise<boolean>
    /** Kuma と UptimeRobot の一覧を取り直す。表示名を変えた直後に使う（#479） */
    refreshMonitors: () => Promise<boolean>
    /**
     * AI使用状況だけを取り直す。クレジットの購入・残高を記録した直後に使う。
     * サーバー側のキャッシュは飛ばさない（台帳の値はキャッシュを返す回も載せ直されるため）。
     */
    refreshAiUsage: () => Promise<boolean>
    /** アプリ別AI利用だけを、連携先の設定変更直後などに取り直す。 */
    refreshAiAppUsage: () => Promise<boolean>
}

const DashboardDataContext = createContext<DashboardData | null>(null)

/**
 * ダッシュボードが使うデータをまとめて取得する。
 *
 * 画面上部のサマリーが全ソースを横断して集計するため、取得をコンポーネントごとに散らすと
 * 同じデータを二重に取りにいくことになる。取得はここに一本化し、各コンポーネントは表示だけを持つ。
 */
export function DashboardDataProvider({
    initial,
    children,
}: {
    initial: DashboardInitialData
    children: React.ReactNode
}) {
    const hostStats = usePolledJson<HostStatsView | null>(
        "/api/host-stats",
        HOST_STATS_INTERVAL_MS,
        selectAsIs,
        null
    )
    const aiUsage = usePolledJson<AiUsageSnapshot | null>(
        "/api/ai-usage",
        USAGE_INTERVAL_MS,
        selectAsIs,
        null,
        true
    )
    const aiAppUsage = usePolledJson<AiAppUsageSnapshot | null>(
        "/api/ai-app-usage",
        USAGE_INTERVAL_MS,
        selectAsIs,
        null,
        true
    )
    const githubUsage = usePolledJson<GitHubUsageSnapshot | null>(
        "/api/github-usage",
        USAGE_INTERVAL_MS,
        selectAsIs,
        null,
        true
    )
    const onepasswordUsage = usePolledJson<OnePasswordUsageSnapshot | null>(
        "/api/onepassword-usage",
        USAGE_INTERVAL_MS,
        selectAsIs,
        null,
        true
    )
    const aideStatus = usePolledJson<AideStatusSnapshot | null>(
        "/api/aide-status",
        AIDE_STATUS_INTERVAL_MS,
        selectAsIs,
        null
    )
    const uptimeKuma = usePolledJson<MonitorFeed<UptimeKumaMonitor>>(
        "/api/uptime-kuma",
        MONITOR_INTERVAL_MS,
        selectMonitors,
        initial.uptimeKuma
    )
    const uptimeRobot = usePolledJson<MonitorFeed<UptimeRobotMonitor>>(
        "/api/monitors",
        MONITOR_INTERVAL_MS,
        selectMonitors,
        initial.uptimeRobot
    )

    const now = useClock()

    // 更新ボタンは全ソースをまとめて取り直す。ソースごとにボタンを分けると押す場所が増え、
    // 提供元のレート制限もソースごとに管理することになるため、ヘッダーの1つに集約している
    const refreshers = useMemo(
        () => [
            hostStats.refresh,
            aiUsage.refresh,
            aiAppUsage.refresh,
            githubUsage.refresh,
            onepasswordUsage.refresh,
            aideStatus.refresh,
            uptimeKuma.refresh,
            uptimeRobot.refresh,
        ],
        [
            hostStats.refresh,
            aiUsage.refresh,
            aiAppUsage.refresh,
            githubUsage.refresh,
            onepasswordUsage.refresh,
            aideStatus.refresh,
            uptimeKuma.refresh,
            uptimeRobot.refresh,
        ]
    )
    const manualRefresh = useManualRefresh(refreshers)

    const refreshUptimeKumaOnly = uptimeKuma.refresh
    const refreshUptimeKuma = useCallback(
        () => refreshUptimeKumaOnly(false),
        [refreshUptimeKumaOnly]
    )

    const refreshUptimeRobotOnly = uptimeRobot.refresh
    const refreshMonitors = useCallback(
        async () => {
            const results = await Promise.all([refreshUptimeKumaOnly(false), refreshUptimeRobotOnly(false)])
            return results.every(Boolean)
        },
        [refreshUptimeKumaOnly, refreshUptimeRobotOnly]
    )

    const refreshAiUsageOnly = aiUsage.refresh
    const refreshAiUsage = useCallback(() => refreshAiUsageOnly(false), [refreshAiUsageOnly])

    const refreshAiAppUsageOnly = aiAppUsage.refresh
    const refreshAiAppUsage = useCallback(() => refreshAiAppUsageOnly(true), [refreshAiAppUsageOnly])

    const value = useMemo<DashboardData>(
        () => ({
            hostStats: hostStats.value,
            aiUsage: aiUsage.value,
            aiAppUsage: aiAppUsage.value,
            githubUsage: githubUsage.value,
            onepasswordUsage: onepasswordUsage.value,
            aideStatus: aideStatus.value,
            uptimeKuma: uptimeKuma.value,
            uptimeRobot: uptimeRobot.value,
            now,
            updatedAt: latest([
                hostStats.updatedAt,
                aiUsage.updatedAt,
                aiAppUsage.updatedAt,
                githubUsage.updatedAt,
                onepasswordUsage.updatedAt,
                aideStatus.updatedAt,
                uptimeKuma.updatedAt,
                uptimeRobot.updatedAt,
            ]),
            refresh: manualRefresh.refresh,
            refreshState: manualRefresh.state,
            refreshCooldownSeconds: manualRefresh.cooldownSeconds,
            refreshUptimeKuma,
            refreshMonitors,
            refreshAiUsage,
            refreshAiAppUsage,
        }),
        [
            refreshUptimeKuma,
            refreshMonitors,
            refreshAiUsage,
            refreshAiAppUsage,
            hostStats,
            aiUsage,
            aiAppUsage,
            githubUsage,
            onepasswordUsage,
            aideStatus,
            uptimeKuma,
            uptimeRobot,
            now,
            manualRefresh,
        ]
    )

    return <DashboardDataContext.Provider value={value}>{children}</DashboardDataContext.Provider>
}

export function useDashboardData(): DashboardData {
    const value = useContext(DashboardDataContext)
    if (!value) throw new Error("DashboardDataProvider の中で使ってください")
    return value
}

interface PolledJson<T> {
    value: T
    /** 最後に取得できた時刻（epoch ミリ秒）。一度も取得できていなければ null */
    updatedAt: number | null
    /** 自動取得を待たずに取り直す。取得できたら true */
    refresh: (force: boolean) => Promise<boolean>
}

/** APIのレスポンスをそのまま使う（/api/host-stats など、本体がそのまま返ってくるもの） */
function selectAsIs<T>(payload: unknown): T {
    return payload as T
}

/**
 * 監視系のAPIは { monitors: [...], error } で返ってくる（取得に失敗した系統は error に理由が入る）。
 * `error` を持たない古い形（{ monitors } だけ）が来ても、取得できた扱いで読めるようにしておく
 */
function selectMonitors<T>(payload: unknown): MonitorFeed<T> {
    const feed = payload as Partial<MonitorFeed<T>>
    return { monitors: feed.monitors ?? [], error: feed.error ?? null }
}

/**
 * 一定間隔でJSONを取りにいく。
 *
 * `forceable` を立てたAPIは `?force=1` を付けるとサーバー側のキャッシュを飛ばして
 * 提供元へ取り直す（AI・GitHub・1Password）。手動更新のときだけ付ける。
 */
function usePolledJson<T>(
    url: string,
    intervalMs: number,
    select: (payload: unknown) => T,
    initial: T,
    forceable = false
): PolledJson<T> {
    const [state, setState] = useState<{ value: T; updatedAt: number | null }>({
        value: initial,
        updatedAt: null,
    })

    // URLも select も定数のためこのコールバックは作り直されない。
    // 手動更新から呼べるよう、取得の本体は useEffect の外に置いている
    const load = useCallback(
        async (force: boolean): Promise<boolean> => {
            try {
                const res = await fetch(force && forceable ? `${url}?force=1` : url, {
                    cache: "no-store",
                })
                if (!res.ok) throw new Error(`${url} が ${res.status} を返しました`)

                const payload: unknown = await res.json()
                setState({ value: select(payload), updatedAt: Date.now() })
                return true
            } catch (error) {
                // 取得に失敗しても直前の値を出し続ける（1回の失敗で画面が消えるのを避ける）
                console.error(`Failed to fetch ${url}:`, error)
                return false
            }
        },
        [url, select, forceable]
    )

    useEffect(() => {
        // 取得は非同期で、状態の更新はレスポンスが返ってからになる。
        // それをlintに伝えるため、効果の中では非同期関数として包んでから呼ぶ
        const tick = async () => {
            await load(false)
        }

        void tick()
        const intervalId = setInterval(() => void tick(), intervalMs)

        return () => clearInterval(intervalId)
    }, [load, intervalMs])

    return useMemo(() => ({ ...state, refresh: load }), [state, load])
}

interface ManualRefresh {
    refresh: () => void
    state: RefreshState
    cooldownSeconds: number
}

/**
 * ヘッダーの更新ボタンの状態を持つ。
 *
 * 押した直後は `REFRESH_COOLDOWN_MS` のあいだ押せなくする。提供元のレート制限があり、
 * 連打しても値は変わらないため。
 */
function useManualRefresh(refreshers: ((force: boolean) => Promise<boolean>)[]): ManualRefresh {
    const [state, setState] = useState<RefreshState>("idle")
    const [cooldownUntil, setCooldownUntil] = useState<number | null>(null)
    const [cooldownSeconds, setCooldownSeconds] = useState(0)
    const runningRef = useRef(false)

    const refresh = useCallback(() => {
        if (runningRef.current) return
        runningRef.current = true
        setState("refreshing")

        void (async () => {
            const results = await Promise.all(refreshers.map((load) => load(true)))
            runningRef.current = false
            setCooldownUntil(Date.now() + REFRESH_COOLDOWN_MS)
            setState(results.every(Boolean) ? "idle" : "error")
        })()
    }, [refreshers])

    // 残り秒数を1秒ごとに詰める。0になったらタイマーごと止める
    useEffect(() => {
        if (cooldownUntil === null) return

        const tick = () => {
            const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000))
            setCooldownSeconds(seconds)
            if (seconds === 0) setCooldownUntil(null)
        }

        tick()
        const intervalId = setInterval(tick, 1000)
        return () => clearInterval(intervalId)
    }, [cooldownUntil])

    // 失敗の表示は出しっぱなしにしない。自動取得は続いているため、残すと実態と合わなくなる
    useEffect(() => {
        if (state !== "error") return

        const timeoutId = setTimeout(() => setState("idle"), REFRESH_ERROR_VISIBLE_MS)
        return () => clearTimeout(timeoutId)
    }, [state])

    return useMemo(() => ({ refresh, state, cooldownSeconds }), [refresh, state, cooldownSeconds])
}

function useClock(): number {
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        const intervalId = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS)
        return () => clearInterval(intervalId)
    }, [])

    return now
}

function latest(times: (number | null)[]): number | null {
    const known = times.filter((time): time is number => time !== null)
    return known.length > 0 ? Math.max(...known) : null
}
