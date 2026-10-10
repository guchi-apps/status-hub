import { fetchWithTimeout, isPermissionStatus } from "@/lib/upstream"
import {
    WORK_FRESHNESS,
    WORK_STATUSES,
    type AideWorkReportsSnapshot,
    type WorkFreshness,
    type WorkListing,
    type WorkReport,
    type WorkStatus,
} from "@/types/aide-work-reports"

/**
 * dotの作業報告の取得（#575）。AIDEの `GET /api/work-reports`（aide#609）を読む。
 *
 * **保存の正本・状態遷移・更新途絶の判定はAIDE側。** ここでは形を確かめて並べるだけで、
 * 更新途絶から完了・失敗を推定しない。取得に失敗した回を「無報告」にしない。
 *
 * **トークンは `AIDE_WORK_REPORTS_TOKEN`（AIDE側は `AIDE_WORK_REPORTS_READ_SECRET`）で、
 * 動作状況の `AIDE_STATUS_TOKEN` とは別。** 流用すると、動作状況のトークンで作業報告まで
 * 読めてしまう（権限が黙って広がる）。
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:3114"
const TIMEOUT_MS = 5_000
/** AIDEが返す上限（aide `LIMITS.listMax`）。一覧は新しい順なので、足りない分は total との差で分かる */
const LIST_LIMIT = 50

const HTTP_HINTS: Record<number, string> = {
    401: "AIDE_WORK_REPORTS_TOKEN がAIDE側の値と一致していません",
    404: "AIDEに作業報告のAPIがありません（guchi-apps/aide#609 が未デプロイ）",
    503: "AIDEが作業報告を読めないか、AIDE_WORK_REPORTS_READ_SECRET が未設定です",
}

class WorkReportsHttpError extends Error {
    readonly status: number
    constructor(status: number) {
        super(`HTTP ${status}`)
        this.status = status
        this.name = "WorkReportsHttpError"
    }
}

function token(): string | undefined {
    return process.env.AIDE_WORK_REPORTS_TOKEN || undefined
}

/** 未設定の環境（worktree・開発機）では節ごと出さない */
export function isAideWorkReportsConfigured(): boolean {
    return Boolean(token())
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isIso(value: unknown): value is string {
    return typeof value === "string" && !Number.isNaN(Date.parse(value))
}

function nullableString(value: unknown): string | null | undefined {
    if (value === null) return null
    return typeof value === "string" ? value : undefined
}

function parseWork(raw: unknown): WorkReport | null {
    if (!isRecord(raw)) return null
    const { workId, version, status, title, occurredAt, receivedAt, reporter, freshness, links } = raw
    const progress = nullableString(raw.progress)
    const waitReason = nullableString(raw.waitReason)
    const resultSummary = nullableString(raw.resultSummary)
    if (
        typeof workId !== "string" || !workId ||
        typeof version !== "number" || !Number.isInteger(version) ||
        !WORK_STATUSES.includes(status as WorkStatus) ||
        typeof title !== "string" ||
        !isIso(occurredAt) || !isIso(receivedAt) ||
        typeof reporter !== "string" ||
        !WORK_FRESHNESS.includes(freshness as WorkFreshness) ||
        !Array.isArray(links) || links.some((link) => typeof link !== "string") ||
        progress === undefined || waitReason === undefined || resultSummary === undefined
    ) {
        return null
    }
    return {
        workId, version, status: status as WorkStatus, title, progress, waitReason, resultSummary,
        links: links as string[], occurredAt, receivedAt, reporter, freshness: freshness as WorkFreshness,
    }
}

/**
 * 応答を検証する。**1件でも形が違えば全体を捨てる**（捨てた行の分だけ黙って少なく見えるより、
 * 取得不可として出すほうがよい。ai-app-usage と同じ方針）。
 */
export function parseWorkListing(payload: unknown): WorkListing | null {
    if (!isRecord(payload) || !Array.isArray(payload.works)) return null
    const { reportState, total, staleCount, staleAfterMinutes, retention, checkedAt } = payload
    if (
        (reportState !== "none" && reportState !== "reported") ||
        typeof total !== "number" || typeof staleCount !== "number" || typeof staleAfterMinutes !== "number" ||
        !isRecord(retention) || typeof retention.days !== "number" || typeof retention.maxWorks !== "number" ||
        !isIso(checkedAt)
    ) {
        return null
    }
    const works: WorkReport[] = []
    const seen = new Set<string>()
    for (const raw of payload.works) {
        const work = parseWork(raw)
        if (!work) return null
        // AIDEは作業ごとに1件のはずだが、同じIDが重なって届いても二重に出さない（版の大きいほうを残す）
        if (seen.has(work.workId)) {
            const index = works.findIndex((w) => w.workId === work.workId)
            if (work.version > (works[index]?.version ?? -1)) works[index] = work
            continue
        }
        seen.add(work.workId)
        works.push(work)
    }
    // 「無報告」なのに中身がある（契約違反）は、空とも報告ありとも言えないので取得不可にする
    if (reportState === "none" && (works.length > 0 || total > 0)) return null
    return {
        reportState, works, total, staleCount, staleAfterMinutes,
        retention: { days: retention.days, maxWorks: retention.maxWorks }, checkedAt,
    }
}

/**
 * 直前の一覧と新しい一覧を統合する。遅れて届いた古い応答で画面を巻き戻さない:
 * - AIDEが一覧を組み立てた時刻（checkedAt）が直前より古い応答は捨てる
 * - 作業ごとに、版が直前より小さい報告は採らない（AIDEは古い版を適用しないので、
 *   小さくなって届くのは古い応答の混入）
 * 一覧から消えた作業（保持期間・件数上限での削除）は、そのまま消す。
 */
export function mergeWorkListings(previous: WorkListing | null, next: WorkListing): WorkListing {
    if (!previous) return next
    if (Date.parse(next.checkedAt) < Date.parse(previous.checkedAt)) return previous
    const before = new Map(previous.works.map((work) => [work.workId, work]))
    const works = next.works.map((work) => {
        const old = before.get(work.workId)
        return old && old.version > work.version ? old : work
    })
    return { ...next, works }
}

function describeFailure(error: unknown): string {
    if (error instanceof WorkReportsHttpError) {
        const hint = HTTP_HINTS[error.status]
        return hint ? `HTTP ${error.status}（${hint}）` : `HTTP ${error.status}`
    }
    if (error instanceof Error) {
        if (error.name === "TimeoutError") return `${TIMEOUT_MS}ms 以内に応答しませんでした`
        if (error.name === "SyntaxError") return "想定と違う形の応答が返りました"
    }
    return "AIDEに接続できませんでした"
}

let lastGood: { listing: WorkListing; fetchedAt: string } | null = null

export async function getAideWorkReportsSnapshot(): Promise<AideWorkReportsSnapshot> {
    const fetchedAt = new Date().toISOString()
    const bearer = token()
    if (!bearer) {
        return {
            status: "unconfigured",
            message: "AIDE_WORK_REPORTS_TOKEN が未設定です",
            listing: null,
            fetchedAt,
            listingFetchedAt: null,
        }
    }

    try {
        const baseUrl = (process.env.AIDE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "")
        const res = await fetchWithTimeout(
            `${baseUrl}/api/work-reports?limit=${LIST_LIMIT}`,
            { headers: { authorization: `Bearer ${bearer}`, accept: "application/json" } },
            TIMEOUT_MS
        )
        if (!res.ok) throw new WorkReportsHttpError(res.status)
        const parsed = parseWorkListing(await res.json())
        if (!parsed) throw new SyntaxError("unexpected payload")

        const listing = mergeWorkListings(lastGood?.listing ?? null, parsed)
        // 古い応答を捨てた（previous を返した）ときは、取得時刻も進めない
        const adopted = listing !== lastGood?.listing
        lastGood = { listing, fetchedAt: adopted ? fetchedAt : (lastGood?.fetchedAt ?? fetchedAt) }
        return { status: "ok", listing, fetchedAt, listingFetchedAt: lastGood.fetchedAt }
    } catch (error) {
        console.error("AIDE work reports error:", error instanceof Error ? error.name : error)
        return {
            status: "error",
            denied: (error instanceof WorkReportsHttpError && isPermissionStatus(error.status)) || undefined,
            message: describeFailure(error),
            listing: lastGood?.listing ?? null,
            fetchedAt,
            listingFetchedAt: lastGood?.fetchedAt ?? null,
        }
    }
}
