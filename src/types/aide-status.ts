/**
 * AIDE（MCPサーバー）の動作状況。
 *
 * **形の正はAIDE側**（guchi-apps/aide の `src/core/views/health.ts` の `Health` と、
 * `src/web/status.ts` の `ProbeResult`）。ここはそれを写したもので、AIDE側を変えたら合わせ直す。
 */

/** unknown は「材料が無い」（まだ一度も動いていないジョブなど）で、異常ではない */
export type AideSeverity = "ok" | "warn" | "danger" | "unknown"

export interface AideAttention {
    severity: "warn" | "danger"
    message: string
    /** 何をすれば直るか。分かる場合だけ */
    action?: string
}

export interface AideServer {
    version: string
    nodeVersion: string
    uptimeSeconds: number
    startedAt: string
    authEnabled: boolean
    baseUrl: string
    mcpUrl: string
}

/** ジョブ1回分の実行記録 */
export interface AideJobRun {
    ok: boolean
    /** 記録が書かれた時刻（＝実行の終了時刻） */
    at: string
    seconds: number
    message: string
    host: string
}

export interface AideJob {
    name: string
    description: string
    interval: string
    staleAfterMinutes: number
    severity: AideSeverity
    lastRun: (AideJobRun & { ageMinutes: number }) | null
    /**
     * 直近の実行記録（新しい順・最大30件）。**AIDE側が履歴を返すようになるまでは届かない**
     * （guchi-apps/aide#441）ため任意。無いときは画面で「記録なし」を出す
     */
    recentRuns?: AideJobRun[]
}

export interface AideCache {
    key: string
    empty: boolean
    fetchedAt: string | null
    ageMinutes: number | null
    stale: boolean
    balances: number
    holdings: number
    staleAccounts: string[]
    severity: AideSeverity
}

export interface AideConnector {
    key: string
    label: string
    side: "server" | "worker"
    /** worker 側（DeskMini／Mac mini）の設定はAIDEのサーバーから判定できないため null */
    configured: boolean | null
    probeable: boolean
    note: string
}

export interface AideMcpAuth {
    clients: number
    tokens: number
    nearestExpiryAt: string | null
}

export interface AideMcpAccessEntry {
    at: string
    method: string
    tool: string | null
    client: string | null
    clientVersion: string | null
    ok: boolean
    ms: number
    detail: string
}

export interface AideMcpAccess {
    total: number
    toolCalls: number
    failures: number
    authFailures: number
    recentFailures: number
    lastAt: string | null
    lastAgeMinutes: number | null
    clients: string[]
    toolCounts: { tool: string; count: number }[]
    entries: AideMcpAccessEntry[]
    visible: number
    severity: "ok" | "warn" | "unknown"
}

export interface AideHealth {
    checkedAt: string
    severity: AideSeverity
    attention: AideAttention[]
    server: AideServer
    jobs: AideJob[]
    cache: AideCache
    connectors: AideConnector[]
    mcp: AideMcpAuth
    mcpAccess: AideMcpAccess
}

/**
 * ok           — 取得できた
 * unconfigured — AIDE_STATUS_TOKEN が未設定
 * error        — 設定はあるが取得に失敗した
 */
export type AideStatusState = "ok" | "unconfigured" | "error"

export interface AideStatusSnapshot {
    status: AideStatusState
    /** status が ok 以外のときに表示する理由 */
    message?: string
    /**
     * 権限が足りず取得できないとき true（401・403・スコープ不足）。画面は「取得失敗」ではなく
     * 「表示できません」と理由を出す。message には直し方を添える
     */
    denied?: boolean
    /**
     * 画面に出す状態。取得に失敗しても、直前に取得できた値があればそれを残す
     * （1回の失敗で画面が空になると、何が起きていたのかまで見えなくなるため）
     */
    health: AideHealth | null
    /** MCPツール名の一覧 */
    tools: string[]
    /** AIDEへ問い合わせた時刻（ISO 8601） */
    fetchedAt: string
    /** health を取得できた時刻。失敗して古い値を出しているときは fetchedAt より前になる */
    healthFetchedAt: string | null
}

export interface AideProbeResult {
    key: string
    ok: boolean
    ms: number
    /** 失敗の理由。AIDE側で外へ出してよい粒度まで丸めてある */
    detail: string
}

export interface AideProbeResponse {
    status: AideStatusState
    message?: string
    results: AideProbeResult[]
}
