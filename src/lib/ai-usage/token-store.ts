import fs from "fs/promises"
import path from "path"

import { describeError } from "@/lib/upstream"

/**
 * OAuth のリフレッシュトークンは使うたびにローテーションするため、
 * 環境変数（1Password 由来）の値をそのまま使い続けることができない。
 * 最新のトークンをVPS上のJSONファイルに永続化し、デプロイをまたいで引き継ぐ。
 *
 * 保存先は deploy.yml の `rm -rf` 対象に含まれないディレクトリを既定とする。
 */
export type TokenProvider = "claude" | "chatgpt"

export interface StoredTokens {
    /** この項目を初期化したときの環境変数の値。env が差し替わったら保存内容を破棄する */
    seededFrom: string
    refreshToken: string
    accessToken?: string
    /** アクセストークンの有効期限（epoch ミリ秒） */
    expiresAt?: number
    /**
     * リフレッシュトークン自体の失効予定（epoch ミリ秒）。Anthropic のリフレッシュトークンには
     * ローテーションしても延びない絶対期限（約4週間）がある（#641）。提供元が返したときだけ持つ
     */
    refreshTokenExpiresAt?: number
}

export type TokenState = Partial<Record<TokenProvider, StoredTokens>>

export interface RefreshResult {
    accessToken: string
    /** ローテーション後のリフレッシュトークン。返らなければ既存の値を使い続ける */
    refreshToken?: string
    /** アクセストークンの有効期間（秒） */
    expiresInSeconds?: number
    /** リフレッシュトークンの失効予定（epoch ミリ秒）。返らなければ保存済みの値を持ち越す */
    refreshTokenExpiresAt?: number
}

export interface AccessToken {
    accessToken: string
    /** この呼び出しで更新して得たものなら true。保存済みの使い回しなら false */
    refreshed: boolean
    /**
     * リフレッシュトークンの失効予定（epoch ミリ秒）。更新しなかった回も保存済みの値を返す
     * （アクセストークンが有効な間は更新が走らず、応答から期限を得られないため）
     */
    refreshTokenExpiresAt?: number
}

export interface GetAccessTokenOptions {
    /**
     * ここに渡したアクセストークンが保存済みのものと一致していれば、期限内でも更新する。
     * アクセストークンは有効期限内でも失効することがある（別端末での再ログイン・ログアウトなど）ため、
     * 401 を受けた呼び出し元がやり直すときに使う。
     * 別の要求が先に更新していれば、そのトークンをそのまま返す。
     */
    invalidate?: string
}

/**
 * リフレッシュトークン自体が失効している（提供元が `invalid_grant` を返した）ことを表す。
 * 何度やり直しても復旧せず、利用者が再ログインしてトークンを差し替えるしかないため、
 * 通信エラーや 5xx のような一時的な失敗とは区別して扱う。
 */
export class RefreshTokenRevokedError extends Error {
    /** 提供元が返した本文。原因の切り分け用にログへ残す */
    readonly detail: string

    constructor(providerName: string, envKey: string, detail: string) {
        super(
            `リフレッシュトークンが失効しています（有効期限切れの可能性があります）。${providerName}へ再ログインして ${envKey} を更新してください（手順はREADMEの「認証情報の取得方法」）`
        )
        this.name = "RefreshTokenRevokedError"
        this.detail = detail
    }
}

/**
 * トークンエンドポイントの失敗が「リフレッシュトークンの失効」かを判定する。
 * OAuth 2.0（RFC 6749 §5.2）では失効・取り消し・クライアント不一致がまとめて
 * `invalid_grant` で返るため、本文の `error` を見るしかない。
 */
export function isInvalidGrantResponse(status: number, body: string): boolean {
    if (status !== 400 && status !== 401) return false

    try {
        const parsed: unknown = JSON.parse(body)
        if (!parsed || typeof parsed !== "object") return false
        return (parsed as { error?: unknown }).error === "invalid_grant"
    } catch {
        return false
    }
}

/** トークン更新の失敗を画面に出す文にする。失効なら次にやることが分かる文言をそのまま使う */
export function describeRefreshFailure(error: unknown): string {
    if (error instanceof RefreshTokenRevokedError) return error.message
    return `認証トークンを更新できませんでした: ${describeError(error)}`
}

/** 期限ぎりぎりのトークンで叩かないための猶予 */
const EXPIRY_MARGIN_MS = 60_000

function getStatePath(): string {
    return process.env.AI_USAGE_STATE_PATH || path.join(process.cwd(), ".data", "ai-usage-tokens.json")
}

export async function readState(): Promise<TokenState> {
    try {
        const raw = await fs.readFile(getStatePath(), "utf8")
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object") return {}
        return parsed as TokenState
    } catch {
        return {}
    }
}

async function writeState(state: TokenState): Promise<void> {
    const file = getStatePath()
    await fs.mkdir(path.dirname(file), { recursive: true })

    // 書き込み中に読まれても壊れないよう、一時ファイル経由で差し替える
    const tempFile = `${file}.tmp`
    await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(tempFile, file)
}

/**
 * ファイルへの read-modify-write を直列化する。
 * PM2 は fork モード1プロセスで動かしているため、プロセス内の直列化で足りる。
 */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

function isFresh(tokens: StoredTokens): boolean {
    return (
        tokens.accessToken !== undefined &&
        tokens.expiresAt !== undefined &&
        tokens.expiresAt - EXPIRY_MARGIN_MS > Date.now()
    )
}

/**
 * 有効なアクセストークンを返す。
 * 保存済みのものが期限切れなら `refresh` を呼び、返ってきたトークンを保存する。
 */
export async function getAccessToken(
    provider: TokenProvider,
    envRefreshToken: string,
    refresh: (refreshToken: string) => Promise<RefreshResult>,
    { invalidate }: GetAccessTokenOptions = {}
): Promise<AccessToken> {
    return serialize(async () => {
        const state = await readState()
        const stored = state[provider]

        // 環境変数のリフレッシュトークンが差し替わった（=再ログインした）なら保存済みの値は捨てる
        const entry: StoredTokens =
            stored && stored.seededFrom === envRefreshToken
                ? stored
                : { seededFrom: envRefreshToken, refreshToken: envRefreshToken }

        const invalidated = invalidate !== undefined && entry.accessToken === invalidate

        if (!invalidated && isFresh(entry)) {
            return {
                accessToken: entry.accessToken as string,
                refreshed: false,
                refreshTokenExpiresAt: entry.refreshTokenExpiresAt,
            }
        }

        let result: RefreshResult
        try {
            result = await refresh(entry.refreshToken)
        } catch (error) {
            // 保存済みのトークンが「失効している」と分かったときだけ、ローテーション後の値を
            // 取りこぼしている可能性を見て env の値でもう一度だけ試す。
            // 通信エラーや 5xx では保存済みの値がまだ生きている公算が大きく、そこで使用済みの
            // 古いトークンを送ると、提供元のトークン再利用検知（RFC 9700 §4.14.2）で
            // 有効なトークンまで巻き添えに失効させられかねないため、やり直さない。
            if (!(error instanceof RefreshTokenRevokedError)) throw error
            if (entry.refreshToken === envRefreshToken) throw error
            result = await refresh(envRefreshToken)
        }

        // 応答に期限が無い回は記録済みの値を持ち越す。env が差し替わったとき（再ログイン）は
        // entry が作り直されているので、古い期限は引き継がれない
        const refreshTokenExpiresAt = result.refreshTokenExpiresAt ?? entry.refreshTokenExpiresAt

        state[provider] = {
            seededFrom: envRefreshToken,
            refreshToken: result.refreshToken ?? entry.refreshToken,
            accessToken: result.accessToken,
            expiresAt:
                result.expiresInSeconds !== undefined
                    ? Date.now() + result.expiresInSeconds * 1000
                    : undefined,
            refreshTokenExpiresAt,
        }
        await writeState(state)

        return { accessToken: result.accessToken, refreshed: true, refreshTokenExpiresAt }
    })
}
