import { clampPercent, fetchWithTimeout, isPermissionStatus, readErrorBody } from "@/lib/upstream"
import { formatMoney, formatWindowLabel } from "@/lib/ai-usage/common"
import { getProviderEntry, type ProviderCacheEntry, type ProviderFetchResult } from "@/lib/ai-usage/provider-cache"
import {
    describeRefreshFailure,
    getAccessToken,
    isInvalidGrantResponse,
    RefreshTokenRevokedError,
    type AccessToken,
    type RefreshResult,
} from "@/lib/ai-usage/token-store"
import type { AiProviderCredit, AiProviderUsage, AiUsageWindow } from "@/types/ai-usage"

/**
 * Claude Code の `/usage` が参照しているのと同じOAuthエンドポイントを叩く。
 * 公式に文書化されたAPIではないため、仕様変更で壊れうる前提で扱う。
 */
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

/** 契約プランは使用状況のレスポンスに含まれないため、プロフィールから取得する */
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"

/** トークンエンドポイントは console.anthropic.com から platform.claude.com へ移行済み。念のため両方試す */
const TOKEN_URLS = [
    "https://platform.claude.com/v1/oauth/token",
    "https://console.anthropic.com/v1/oauth/token",
]

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

/** 失効したときに画面へ出す、差し替える対象の環境変数名 */
const REFRESH_TOKEN_ENV_KEY = "ANTHROPIC_OAUTH_REFRESH_TOKEN"

/**
 * このヘッダーが無いと 401 が返る。バージョン文字列が変わると無言で 401 になるため、
 * 復旧をこの1箇所の書き換えで済ませられるよう定数にまとめている。
 */
const OAUTH_BETA_VERSION = "oauth-2025-04-20"

/** claude-code を名乗らないと極端に厳しいレート制限バケットに入り 429 が返り続ける */
const DEFAULT_USER_AGENT = "claude-code/2.0.14"

interface UsageWindowResponse {
    utilization?: number | null
    resets_at?: string | null
}

/** プラン枠を超えた分の課金額。`amount_minor` を `exponent` 桁の小数として扱う */
interface SpendAmount {
    amount_minor?: number | null
    currency?: string | null
    exponent?: number | null
}

/**
 * サブスク枠を超えた分の追加利用（クレジット枠）。金額は最小単位（USDならセント）で返る。
 * 同じ内容が `spend` にも入っているが、Claude Code 本体が読んでいるのはこちら。
 */
interface ExtraUsageResponse {
    is_enabled?: boolean | null
    /** 月の上限。null なら上限なし */
    monthly_limit?: number | null
    used_credits?: number | null
    utilization?: number | null
    currency?: string | null
    /** `monthly_limit` / `used_credits` の小数点以下の桁数（USDなら2） */
    decimal_places?: number | null
}

interface OauthUsageResponse {
    five_hour?: UsageWindowResponse | null
    seven_day?: UsageWindowResponse | null
    seven_day_opus?: UsageWindowResponse | null
    seven_day_sonnet?: UsageWindowResponse | null
    extra_usage?: ExtraUsageResponse | null
    spend?: {
        enabled?: boolean | null
        used?: SpendAmount | null
        limit?: SpendAmount | null
    } | null
}

interface ProfileResponse {
    account?: {
        has_claude_max?: boolean | null
        has_claude_pro?: boolean | null
    } | null
    organization?: {
        organization_type?: string | null
        /** 例: "default_claude_max_5x" */
        rate_limit_tier?: string | null
    } | null
}

interface TokenResponse {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    /**
     * リフレッシュトークン自体の有効期間（秒）。ローテーションしても延びない絶対期限で、
     * Claude Code 本体はこれを `refreshTokenExpiresAt` として保存している（#641）。
     * 項目名は公開されていないため、時刻で返る形（`refresh_token_expires_at`）も受ける
     */
    refresh_token_expires_in?: number
    refresh_token_expires_at?: number | string
}

/** トークン応答からリフレッシュトークンの失効予定（epoch ミリ秒）を読む。無い・解釈できなければ undefined */
export function parseRefreshTokenExpiresAt(data: TokenResponse, now = Date.now()): number | undefined {
    const seconds = data.refresh_token_expires_in
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
        return now + seconds * 1000
    }

    const at = data.refresh_token_expires_at
    if (typeof at === "number" && Number.isFinite(at) && at > 0) {
        // 秒とミリ秒のどちらで返っても読めるようにする（1e12 未満なら秒とみなす）
        return at < 1e12 ? at * 1000 : at
    }
    if (typeof at === "string") {
        const parsed = Date.parse(at)
        if (Number.isFinite(parsed)) return parsed
    }

    return undefined
}

function userAgent(): string {
    return process.env.ANTHROPIC_CLIENT_USER_AGENT || DEFAULT_USER_AGENT
}

/** OAuthトークンで Anthropic の非公開エンドポイントを叩くときの共通ヘッダー */
export function claudeApiHeaders(accessToken: string): Record<string, string> {
    return {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA_VERSION,
        "User-Agent": userAgent(),
        Accept: "application/json",
    }
}

async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
    let lastError = ""

    for (const url of TOKEN_URLS) {
        const res = await fetchWithTimeout(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": userAgent(),
            },
            body: JSON.stringify({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: OAUTH_CLIENT_ID,
            }),
        })

        if (res.status === 404) {
            lastError = `${url}: 404`
            continue
        }

        if (!res.ok) {
            const body = await readErrorBody(res)
            if (isInvalidGrantResponse(res.status, body)) {
                throw new RefreshTokenRevokedError("Claude", REFRESH_TOKEN_ENV_KEY, body)
            }
            throw new Error(`トークンの更新に失敗しました (${res.status}): ${body}`)
        }

        const data = (await res.json()) as TokenResponse
        if (!data.access_token) {
            throw new Error("トークンの更新レスポンスに access_token がありません")
        }

        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresInSeconds: data.expires_in,
            refreshTokenExpiresAt: parseRefreshTokenExpiresAt(data),
        }
    }

    throw new Error(`トークンエンドポイントが見つかりません (${lastError})`)
}

/**
 * `claude setup-token` の長期トークン（sk-ant-oat01-...）は使えない。
 * 発行時に user:inference スコープしか要求されず、このエンドポイントが求める
 * user:profile が付かないため 403 になる。user:profile が付くのは
 * `claude login` のフルOAuthで発行されるトークンだけなので、そのリフレッシュトークンを使う。
 */
export async function resolveClaudeAccessToken(
    /** 401 を受けたときに、そのとき使ったアクセストークンを渡すと期限内でも更新する */
    invalidate?: string
): Promise<AccessToken | null> {
    const refreshToken = process.env[REFRESH_TOKEN_ENV_KEY]
    if (!refreshToken) return null

    return getAccessToken("claude", refreshToken, refreshAccessToken, { invalidate })
}

/**
 * 401 を受けたときに、アクセストークンを取り直すべきかを返す。
 * アクセストークンは有効期限が残っていても失効することがある（別端末での再ログインや
 * ログアウトなど）。期限だけを見て使い回すと、保存済みのトークンが失効した時点から
 * 401 が返り続け、更新のきっかけが二度と来ない。この呼び出しで更新したばかりのトークンが
 * 401 なら、取り直しても直らないためやり直さない。
 */
export function shouldRetryAfterUnauthorized(status: number, token: AccessToken): boolean {
    return status === 401 && !token.refreshed
}

/** カードへ載せるリフレッシュトークンの失効予定。記録が無ければ何も足さない */
function refreshTokenExpiry(token: AccessToken | null): Pick<AiProviderUsage, "refreshTokenExpiresAt"> {
    const at = token?.refreshTokenExpiresAt
    return typeof at === "number" ? { refreshTokenExpiresAt: new Date(at).toISOString() } : {}
}

const FIVE_HOUR_SECONDS = 5 * 60 * 60
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60

function toWindow(
    windowSeconds: number,
    source: UsageWindowResponse | null | undefined,
    note?: string
): AiUsageWindow | null {
    if (!source || typeof source.utilization !== "number") return null

    return {
        label: formatWindowLabel(windowSeconds),
        usedPercent: clampPercent(source.utilization),
        resetsAt: source.resets_at ?? null,
        windowSeconds,
        note,
    }
}

/**
 * 追加利用は月ごとにリセットされるが、リセット時刻はレスポンスに含まれない。
 * Claude Code 本体と同じく実行環境の暦で翌月1日として扱う。
 */
function currentMonthResetsAt(): string {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
}

/**
 * 同じ内容を返す旧い形（`spend`）を `extra_usage` と同じ形に読み替える。
 * 現在はどちらも返ってくるが、片方が無くなっても表示が消えないようにしている。
 */
function extraUsageFromSpend(spend: OauthUsageResponse["spend"]): ExtraUsageResponse | null {
    if (!spend || typeof spend.used?.amount_minor !== "number") return null

    return {
        is_enabled: spend.enabled ?? false,
        monthly_limit: typeof spend.limit?.amount_minor === "number" ? spend.limit.amount_minor : null,
        used_credits: spend.used.amount_minor,
        currency: spend.used.currency,
        decimal_places: spend.used.exponent,
    }
}

function toCredit(data: OauthUsageResponse): AiProviderCredit | undefined {
    const source = data.extra_usage ?? extraUsageFromSpend(data.spend)
    if (!source) return undefined

    if (source.is_enabled !== true) {
        return {
            valueText: "未設定",
            usedPercent: null,
            detailText: "追加利用は有効になっていません",
            resetsAt: null,
        }
    }

    const currency = source.currency || "USD"
    const decimals = typeof source.decimal_places === "number" ? source.decimal_places : 2
    const used = source.used_credits

    if (typeof source.monthly_limit !== "number") {
        return {
            valueText: "無制限",
            usedPercent: null,
            detailText:
                typeof used === "number" ? `使用 ${formatMoney(used, currency, decimals)}` : null,
            resetsAt: null,
            monthly:
                typeof used === "number"
                    ? { usedMinor: used, limitMinor: null, currency, decimals }
                    : undefined,
        }
    }

    if (typeof used !== "number") return undefined

    const limit = source.monthly_limit
    const utilization =
        typeof source.utilization === "number"
            ? source.utilization
            : limit > 0
              ? (used / limit) * 100
              : 0

    return {
        // 実際の残高（前払いクレジットの残り）ではなく、月の上限からの差額でしかないため
        // 「残り」ではなく「上限まで」と表記する（#250 計画レビューで指摘）
        valueText: `上限まで ${formatMoney(Math.max(0, limit - used), currency, decimals)}`,
        usedPercent: clampPercent(utilization),
        detailText: `使用 ${formatMoney(used, currency, decimals)} / 上限 ${formatMoney(limit, currency, decimals)}`,
        resetsAt: currentMonthResetsAt(),
        monthly: { usedMinor: used, limitMinor: limit, currency, decimals },
    }
}

/** プロフィールのレスポンスからプランの表示名を組み立てる */
export function parseClaudePlan(profile: ProfileResponse): string | null {
    const tier = profile.organization?.rate_limit_tier ?? ""

    // "default_claude_max_5x" のように倍率が入っていればそれを表示に使う
    const maxTier = tier.match(/claude_max_(\d+)x/)
    if (maxTier) return `Max ${maxTier[1]}x`
    if (tier.includes("claude_max")) return "Max"
    if (tier.includes("claude_pro")) return "Pro"

    const orgType = profile.organization?.organization_type ?? ""
    if (orgType === "claude_max") return "Max"
    if (orgType === "claude_pro") return "Pro"

    if (profile.account?.has_claude_max) return "Max"
    if (profile.account?.has_claude_pro) return "Pro"

    return null
}

/** レスポンスから表示に使う制限枠とクレジット枠を取り出す */
export function parseClaudeUsageResponse(data: OauthUsageResponse): {
    windows: AiUsageWindow[]
    credit?: AiProviderCredit
} {
    const windows = [
        toWindow(FIVE_HOUR_SECONDS, data.five_hour),
        toWindow(SEVEN_DAY_SECONDS, data.seven_day),
        toWindow(SEVEN_DAY_SECONDS, data.seven_day_opus, "Opus"),
        toWindow(SEVEN_DAY_SECONDS, data.seven_day_sonnet, "Sonnet"),
    ].filter((window): window is AiUsageWindow => window !== null)

    return { windows, credit: toCredit(data) }
}

/** プランの取得に失敗しても使用状況の表示は続けたいので、失敗時は null を返す */
async function fetchPlan(accessToken: string): Promise<string | null> {
    try {
        const res = await fetchWithTimeout(PROFILE_URL, { headers: claudeApiHeaders(accessToken) })
        if (!res.ok) {
            console.error("Claude profile API error:", res.status, await readErrorBody(res))
            return null
        }

        return parseClaudePlan((await res.json()) as ProfileResponse)
    } catch (error) {
        console.error("Claude profile: 取得に失敗", error)
        return null
    }
}

async function fetchClaudeUsage(): Promise<ProviderFetchResult> {
    const base: Omit<AiProviderUsage, "status"> = {
        id: "claude",
        name: "Claude",
        plan: null,
        windows: [],
    }

    let token: AccessToken | null
    try {
        token = await resolveClaudeAccessToken()
    } catch (error) {
        console.error("Claude usage: トークン更新に失敗", error)
        return {
            usage: { ...base, status: "error", message: describeRefreshFailure(error) },
            permanent: error instanceof RefreshTokenRevokedError,
        }
    }

    if (!token) {
        return {
            usage: {
                ...base,
                status: "unconfigured",
                message: `${REFRESH_TOKEN_ENV_KEY} が未設定です`,
            },
        }
    }

    const requestUsage = (accessToken: string) =>
        Promise.all([
            fetchWithTimeout(CLAUDE_USAGE_URL, { headers: claudeApiHeaders(accessToken) }),
            fetchPlan(accessToken),
        ])

    try {
        let [res, detectedPlan] = await requestUsage(token.accessToken)

        if (shouldRetryAfterUnauthorized(res.status, token)) {
            try {
                token = await resolveClaudeAccessToken(token.accessToken)
            } catch (error) {
                console.error("Claude usage: 401 を受けたあとのトークン更新に失敗", error)
                return {
                    usage: { ...base, status: "error", message: describeRefreshFailure(error) },
                    permanent: error instanceof RefreshTokenRevokedError,
                }
            }

            if (token) [res, detectedPlan] = await requestUsage(token.accessToken)
        }

        // 環境変数を設定した場合はそちらを表示名として優先する
        base.plan = process.env.CLAUDE_PLAN_NAME || detectedPlan

        if (!res.ok) {
            console.error("Claude usage API error:", res.status, await readErrorBody(res))
            return {
                usage: {
                    ...base,
                    status: "error",
                    denied: isPermissionStatus(res.status) || undefined,
                    ...refreshTokenExpiry(token),
                    message:
                        res.status === 429
                            ? "レート制限中のため取得できませんでした"
                            : res.status === 401
                              ? "認証されませんでした (401)。`claude login` でトークンを発行し直してください"
                              : res.status === 403
                              ? "トークンに user:profile スコープがありません（`claude login` で発行したものを使う必要があります）"
                              : `使用状況を取得できませんでした (${res.status})`,
                },
            }
        }

        const data: unknown = await res.json()
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            return { usage: { ...base, status: "error", message: "使用状況のレスポンスを解釈できませんでした" } }
        }

        const raw = data as Record<string, unknown>
        const { windows, credit } = parseClaudeUsageResponse(raw as OauthUsageResponse)

        if (windows.length === 0) {
            return {
                usage: { ...base, status: "error", message: "使用状況のレスポンスを解釈できませんでした" },
                raw,
            }
        }

        return {
            usage: { ...base, status: "ok", windows, credit, ...refreshTokenExpiry(token) },
            raw,
        }
    } catch (error) {
        console.error("Claude usage: 取得に失敗", error)
        return { usage: { ...base, status: "error", message: "使用状況の取得に失敗しました" } }
    }
}

/**
 * Claudeの使用状況を、提供元ごとのキャッシュを通して返す。
 * ダッシュボードとウィジェットの両方がここを通るため、同じエンドポイントを別々に叩かない（#273）
 */
export function getClaudeUsageEntry(force = false): Promise<ProviderCacheEntry> {
    return getProviderEntry("claude", fetchClaudeUsage, force)
}
