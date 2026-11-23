import { parseWorkerAssignment } from "@/lib/aide-worker-assignment"
import { resolveSharedToken, type SharedTokenCacheEntry } from "@/lib/shared-token"
import { fetchWithTimeout, isPermissionStatus } from "@/lib/upstream"
import type {
    AideHealth,
    AideProbeResponse,
    AideProbeResult,
    AideStatusSnapshot,
    AideAssignmentMode,
    AideWorkerAssignment,
    AideWorkerAssignmentSnapshot,
} from "@/types/aide-status"

/**
 * AIDE（MCPサーバー）の動作状況の取得（#237）。
 *
 * 状態はAIDEのプロセス内の値（稼働時間・ジョブの記録・MCPアクセスの記録）から組み立てられて
 * いて、ファイルを読むだけでは揃わない。AIDE側の読み取りAPI（guchi-apps/aide#276）を叩く。
 * 両方とも同じVPS上のPM2プロセスなので localhost 経由で届く（AIDEが ops-dashboard を
 * 読むときと逆向きの同じ方式）。
 *
 * **トークンは `OPS_API_TOKEN` とは別にしている。** あちらはAIDEが ops-dashboard を読むための
 * もので、向きが逆。同じ値にすると、片方が漏れたときに両方向とも読めるようになる。
 */

/** AIDEは同じVPS上のPM2プロセス（ポート3114。guchi-apps/aide の deploy/ecosystem.config.cjs） */
const DEFAULT_BASE_URL = "http://127.0.0.1:3114"

/** AIDEは手元のファイルを読むだけで返すため、localhost なら数十ミリ秒で返る */
const STATUS_TIMEOUT_MS = 5_000

/**
 * 疎通確認はAIDEが各接続先へ問い合わせてから返る。AIDE側の1本あたりの制限（3秒）を
 * 並列に待つので、それより十分長く取る
 */
const CHECKS_TIMEOUT_MS = 20_000

/** 失敗したときに、何を確かめればよいかが分かるステータスだけ理由を添える */
const HTTP_HINTS: Record<number, string> = {
    401: "AIDE_STATUS_TOKEN がAIDE側の値と一致していません",
    404: "AIDEに動作状況のAPIがありません（guchi-apps/aide#276）",
    503: "AIDE側で AIDE_STATUS_SECRET が未設定です",
}

interface AideConfig {
    baseUrl: string
    token: string
    /** 共有トークンAPIから得た値か（401のときにキャッシュを捨てて取り直す対象かの判定に使う） */
    fromShared: boolean
}

/** readAideConfig が null を返した理由。取得失敗を「未設定」と説明しないために分ける */
type AideConfigResult = { config: AideConfig } | { config: null; reason: "unconfigured" | "unavailable" }

/** issue-deckの共有トークンAPIから取得したトークンをプロセス内に持つ（#444） */
let sharedTokenCache: SharedTokenCacheEntry | null = null

/** issue-deckの共有トークンAPIを使える設定が揃っているか（値を取得できるかどうかとは別） */
function isSharedTokenApiConfigured(): boolean {
    return Boolean(process.env.ISSUE_DECK_URL && process.env.SHARED_TOKEN_API_SECRET)
}

/** トークンは認証情報として扱う。戻り値をログ・レスポンスへ出さないこと */
async function readAideConfig(): Promise<AideConfigResult> {
    const { value, cache, failed } = await resolveSharedToken("AIDE_STATUS_TOKEN", "ops-dashboard", sharedTokenCache)
    sharedTokenCache = cache

    const token = value
    if (!token) return { config: null, reason: failed ? "unavailable" : "unconfigured" }

    const baseUrl = process.env.AIDE_BASE_URL || DEFAULT_BASE_URL
    return { config: { baseUrl: baseUrl.replace(/\/+$/, ""), token, fromShared: value != null } }
}

const UNAVAILABLE_MESSAGE = "issue-deckから AIDE_STATUS_TOKEN を取得できませんでした"

/**
 * AIDEが401を返したら、キャッシュした共有トークンを捨てて1回だけ取り直して再要求する。
 * issue-deck側でトークンをローテーションしたあと、最大10分間「ずれている」表示が続くのを避ける
 */
async function requestAideWithRefresh(
    config: AideConfig,
    path: string,
    method: "GET" | "POST",
    timeoutMs: number
): Promise<unknown> {
    try {
        return await requestAide(config, path, method, timeoutMs)
    } catch (error) {
        if (!config.fromShared || !(error instanceof AideHttpError) || error.status !== 401) throw error

        sharedTokenCache = null
        const retry = await readAideConfig()
        if (!retry.config || retry.config.token === config.token) throw error
        return requestAide(retry.config, path, method, timeoutMs)
    }
}

/**
 * 担当ホストの切り替えに使うトークン（#668）。AIDE側の `AIDE_WORKER_CONTROL_SECRET` と同じ値。
 *
 * **読み取りの `AIDE_STATUS_TOKEN` とは別にしている。** 動作状況を見るだけのトークンで担当まで
 * 変えられないよう、AIDE側が切り替えだけを別のシークレットで受けるため。AIDE側が環境変数で
 * しか読まないので、共有トークンAPIではなく環境変数で受け取る。戻り値をログ・レスポンスへ出さないこと
 */
function readWorkerControlToken(): string | null {
    return process.env.AIDE_WORKER_CONTROL_TOKEN || null
}

/** 画面に切り替えの操作を出すか。値を検証せず、設定があるかだけを見る */
export function isAideWorkerControlConfigured(): boolean {
    return readWorkerControlToken() !== null
}

/**
 * 未設定の環境（worktree・開発機）ではタブごと出さない。ページ側で判定に使う同期関数のため
 * 実際には取得を試みず、取得できる見込み（共有トークンAPIの設定）が
 * あるかだけで判定する
 */
export function isAideStatusConfigured(): boolean {
    return isSharedTokenApiConfigured()
}

class AideHttpError extends Error {
    readonly status: number

    constructor(status: number) {
        super(`HTTP ${status}`)
        this.status = status
        this.name = "AideHttpError"
    }
}

/**
 * 失敗の理由を画面に出してよい粒度まで丸める。
 * 例外の message には接続先のURLが載ることがあるため、HTTPステータスと種別だけにする
 */
function describeFailure(error: unknown, timeoutMs: number): string {
    if (error instanceof AideHttpError) {
        const hint = HTTP_HINTS[error.status]
        return hint ? `HTTP ${error.status}（${hint}）` : `HTTP ${error.status}`
    }
    if (error instanceof Error) {
        if (error.name === "TimeoutError") return `${timeoutMs}ms 以内に応答しませんでした`
        if (error.name === "SyntaxError") return "想定と違う形の応答が返りました"
    }
    return "AIDEに接続できませんでした"
}

async function requestAide(
    config: Pick<AideConfig, "baseUrl" | "token">,
    path: string,
    method: "GET" | "POST",
    timeoutMs: number,
    body?: unknown
): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${config.token}`, accept: "application/json" }
    if (body !== undefined) headers["content-type"] = "application/json"
    const res = await fetchWithTimeout(
        `${config.baseUrl}${path}`,
        {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        },
        timeoutMs
    )
    if (!res.ok) throw new AideHttpError(res.status)
    return res.json()
}

/** 401（トークンのずれ）は権限不足として出す。503・404はAIDE側の未設定・未デプロイなので対象外 */
function isAideDenied(error: unknown): boolean {
    return error instanceof AideHttpError && isPermissionStatus(error.status)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

/** 描画が前提にする骨格だけを確かめる。AIDE側の形が変わったときに画面ごと落ちないようにする */
function isStatusPayload(payload: unknown): payload is { health: AideHealth; tools: string[] } {
    if (!isRecord(payload) || !isRecord(payload.health)) return false
    const health = payload.health
    return (
        typeof health.severity === "string" &&
        Array.isArray(health.attention) &&
        Array.isArray(health.jobs) &&
        Array.isArray(health.connectors) &&
        isRecord(health.server) &&
        isRecord(health.cache) &&
        isRecord(health.mcp) &&
        isRecord(health.mcpAccess) &&
        Array.isArray(payload.tools)
    )
}

/**
 * 直前に取得できた値。取得に失敗したときも画面にはこれを残す。
 * プロセス内に持つだけなので、再起動した直後に失敗すると何も出せない（それで困る情報ではない）
 */
let lastGood: { health: AideHealth; tools: string[]; fetchedAt: string } | null = null

/** 担当ホストの直前の値。動作状況と同じく、取得に失敗しても画面に残す */
let lastAssignment: { assignment: AideWorkerAssignment; fetchedAt: string } | null = null

const ASSIGNMENT_PATH = "/api/worker/assignment"

/** 担当ホストのAPIだけ404の意味が違う（#891 のリリース前） */
const ASSIGNMENT_HTTP_HINTS: Record<number, string> = {
    ...HTTP_HINTS,
    404: "AIDEに担当ホストのAPIがありません（guchi-apps/aide#891）",
}

function describeAssignmentFailure(error: unknown, timeoutMs: number): string {
    if (error instanceof AideHttpError) {
        const hint = ASSIGNMENT_HTTP_HINTS[error.status]
        return hint ? `HTTP ${error.status}（${hint}）` : `HTTP ${error.status}`
    }
    return describeFailure(error, timeoutMs)
}

function assignmentSnapshot(assignment: AideWorkerAssignment, fetchedAt: string): AideWorkerAssignmentSnapshot {
    lastAssignment = { assignment, fetchedAt }
    return { status: "ok", assignment, assignmentFetchedAt: fetchedAt }
}

function assignmentError(message: string): AideWorkerAssignmentSnapshot {
    return {
        status: "error",
        message,
        assignment: lastAssignment?.assignment ?? null,
        assignmentFetchedAt: lastAssignment?.fetchedAt ?? null,
    }
}

/** 担当ホストの取得（#668）。動作状況の取得と並べて呼び、失敗しても動作状況の表示は落とさない */
async function fetchWorkerAssignment(config: AideConfig, fetchedAt: string): Promise<AideWorkerAssignmentSnapshot> {
    try {
        const payload = await requestAideWithRefresh(config, ASSIGNMENT_PATH, "GET", STATUS_TIMEOUT_MS)
        const assignment = parseWorkerAssignment(payload)
        if (!assignment) throw new SyntaxError("unexpected payload")
        return assignmentSnapshot(assignment, fetchedAt)
    } catch (error) {
        console.error("AIDE worker assignment error:", error)
        return assignmentError(describeAssignmentFailure(error, STATUS_TIMEOUT_MS))
    }
}

export type SetWorkerAssignmentResult =
    | { status: "ok"; assignment: AideWorkerAssignment }
    | { status: "unconfigured" | "error"; message: string }

/**
 * 担当ホストのモードを変える（#668）。**呼ぶ側で管理者のセッションとCSRFを確かめてから呼ぶこと。**
 * AIDEが返した切り替え後の状態をそのまま返し、こちらでは何も記録しない（状態の正はAIDE）
 */
export async function setAideWorkerAssignmentMode(mode: AideAssignmentMode): Promise<SetWorkerAssignmentResult> {
    const token = readWorkerControlToken()
    if (!token) return { status: "unconfigured", message: "AIDE_WORKER_CONTROL_TOKEN が未設定のため切り替えられません" }

    const baseUrl = (process.env.AIDE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "")
    try {
        const payload = await requestAide({ baseUrl, token }, ASSIGNMENT_PATH, "POST", STATUS_TIMEOUT_MS, { mode })
        const assignment = parseWorkerAssignment(payload)
        if (!assignment) throw new SyntaxError("unexpected payload")
        assignmentSnapshot(assignment, new Date().toISOString())
        return { status: "ok", assignment }
    } catch (error) {
        console.error("AIDE worker assignment update error:", error)
        if (error instanceof AideHttpError && error.status === 401) {
            return { status: "error", message: "HTTP 401（AIDE_WORKER_CONTROL_TOKEN がAIDE側の値と一致していません）" }
        }
        if (error instanceof AideHttpError && error.status === 503) {
            return { status: "error", message: "HTTP 503（AIDE側で AIDE_WORKER_CONTROL_SECRET が未設定です）" }
        }
        return { status: "error", message: describeAssignmentFailure(error, STATUS_TIMEOUT_MS) }
    }
}

export async function getAideStatusSnapshot(): Promise<AideStatusSnapshot> {
    const fetchedAt = new Date().toISOString()
    const { config, ...rest } = await readAideConfig()
    if (!config) {
        const unavailable = "reason" in rest && rest.reason === "unavailable"
        return {
            status: unavailable ? "error" : "unconfigured",
            message: unavailable ? UNAVAILABLE_MESSAGE : "issue-deckの共有トークンAPIが未設定です",
            health: lastGood?.health ?? null,
            tools: lastGood?.tools ?? [],
            fetchedAt,
            healthFetchedAt: lastGood?.fetchedAt ?? null,
            workerAssignment: unavailable ? assignmentError(UNAVAILABLE_MESSAGE) : undefined,
        }
    }

    // 担当ホストは別のAPIなので並べて取り、片方の失敗でもう片方を落とさない
    const assignmentPromise = fetchWorkerAssignment(config, fetchedAt)
    try {
        const payload = await requestAideWithRefresh(config, "/api/status", "GET", STATUS_TIMEOUT_MS)
        if (!isStatusPayload(payload)) throw new SyntaxError("unexpected payload")

        lastGood = { health: payload.health, tools: payload.tools, fetchedAt }
        return {
            status: "ok",
            health: payload.health,
            tools: payload.tools,
            fetchedAt,
            healthFetchedAt: fetchedAt,
            workerAssignment: await assignmentPromise,
        }
    } catch (error) {
        console.error("AIDE status error:", error)
        return {
            status: "error",
            denied: isAideDenied(error) || undefined,
            message: describeFailure(error, STATUS_TIMEOUT_MS),
            health: lastGood?.health ?? null,
            tools: lastGood?.tools ?? [],
            fetchedAt,
            healthFetchedAt: lastGood?.fetchedAt ?? null,
            workerAssignment: await assignmentPromise,
        }
    }
}

/** 疎通確認。**押されたときだけ呼ぶ**（AIDEが外部サービスへ問い合わせるため） */
export async function runAideStatusChecks(): Promise<AideProbeResponse> {
    const { config, ...rest } = await readAideConfig()
    if (!config) {
        if ("reason" in rest && rest.reason === "unavailable") {
            return { status: "error", message: UNAVAILABLE_MESSAGE, results: [] }
        }
        return { status: "unconfigured", message: "issue-deckの共有トークンAPIが未設定です", results: [] }
    }

    try {
        const payload = await requestAideWithRefresh(config, "/api/status/checks", "POST", CHECKS_TIMEOUT_MS)
        if (!isRecord(payload) || !Array.isArray(payload.results)) {
            throw new SyntaxError("unexpected payload")
        }
        return { status: "ok", results: payload.results as AideProbeResult[] }
    } catch (error) {
        console.error("AIDE status checks error:", error)
        return { status: "error", message: describeFailure(error, CHECKS_TIMEOUT_MS), results: [] }
    }
}
