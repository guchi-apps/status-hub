/**
 * dotが明示的に報告した作業の状況（#575）。
 *
 * **形の正はAIDE側**（guchi-apps/aide の `src/core/work-reports/types.ts` と `docs/work-reports.md`。aide#609）。
 * ここはそれを写したもので、AIDE側を変えたら合わせ直す。状態の遷移・版の順序・更新途絶の判定は
 * AIDEが行い、StatusHubは推測しない。
 */

export const WORK_STATUSES = ["started", "running", "waiting", "completed", "failed", "cancelled"] as const
export type WorkStatus = (typeof WORK_STATUSES)[number]

/** fresh=更新が続いている / stale=更新途絶（完了・失敗ではない） / final=終端状態 */
export const WORK_FRESHNESS = ["fresh", "stale", "final"] as const
export type WorkFreshness = (typeof WORK_FRESHNESS)[number]

export interface WorkReport {
    workId: string
    version: number
    status: WorkStatus
    title: string
    progress: string | null
    waitReason: string | null
    resultSummary: string | null
    links: string[]
    /** dotが申告した発生時刻 */
    occurredAt: string
    /** AIDEが報告を受け取った時刻。鮮度の基準 */
    receivedAt: string
    reporter: string
    freshness: WorkFreshness
}

/** AIDEの `WorkListing` のうち画面が使う部分 */
export interface WorkListing {
    /** none=1件も報告が無い / reported=報告がある */
    reportState: "none" | "reported"
    works: WorkReport[]
    /** 条件に合う作業の総数（limitで切る前） */
    total: number
    staleCount: number
    staleAfterMinutes: number
    retention: { days: number; maxWorks: number }
    /** AIDEが一覧を組み立てた時刻 */
    checkedAt: string
}

/**
 * ok           — 取得できた（無報告の空一覧も含む。reportState で区別する）
 * unconfigured — AIDE_WORK_REPORTS_TOKEN が未設定
 * error        — 設定はあるが取得に失敗した（空の一覧ではない）
 */
export type AideWorkReportsState = "ok" | "unconfigured" | "error"

export interface AideWorkReportsSnapshot {
    status: AideWorkReportsState
    /** status が ok 以外のときに表示する理由 */
    message?: string
    /** 権限が足りず取得できないとき true（401・403） */
    denied?: boolean
    /** 画面に出す一覧。取得に失敗しても直前に取得できたものを残す（listingFetchedAt が古くなる） */
    listing: WorkListing | null
    /** StatusHubがAIDEへ問い合わせた時刻 */
    fetchedAt: string
    /** listing を取得できた時刻。失敗して古い一覧を出しているときは fetchedAt より前になる */
    listingFetchedAt: string | null
}
