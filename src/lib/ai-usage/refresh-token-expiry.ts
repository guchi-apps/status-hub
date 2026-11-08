/**
 * リフレッシュトークン自体の失効予定から、画面の注記と通知の段階を決める（#641）。
 *
 * Anthropic のリフレッシュトークンにはローテーションしても延びない絶対期限（約4週間）があり、
 * 過ぎると再ログインしてトークンを差し替えるしかない。黙って失効しないよう、手前で知らせる。
 * 画面（クライアント）からも読むため、`node:fs` を含むモジュールを import しない。
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** 画面に注記を出し始める残り日数 */
export const REFRESH_TOKEN_WARN_DAYS = 7

/** 通知の段階。残り7日を切った・残り1日を切った・期限を過ぎた */
export type RefreshTokenExpiryStage = "7d" | "1d" | "expired"

/** 失効予定までの段階を返す。まだ7日より先なら null */
export function refreshTokenExpiryStage(expiresAt: number, now: number): RefreshTokenExpiryStage | null {
    const remaining = expiresAt - now
    if (remaining <= 0) return "expired"
    if (remaining <= DAY_MS) return "1d"
    if (remaining <= REFRESH_TOKEN_WARN_DAYS * DAY_MS) return "7d"
    return null
}

/** 失効予定を日本時間の「11月6日 15:07」の形にする */
export function formatRefreshTokenExpiresAt(expiresAt: number): string {
    return new Date(expiresAt).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    })
}

/**
 * カードに出す注記。7日より先なら null（毎日目に入ると読まれなくなるため、近づいてから出す）。
 * 残りは切り上げの日数で出す（残り30時間なら「あと2日」）
 */
export function describeRefreshTokenExpiry(expiresAtIso: string | undefined, now: number): string | null {
    if (!expiresAtIso) return null
    const expiresAt = Date.parse(expiresAtIso)
    if (!Number.isFinite(expiresAt)) return null

    const stage = refreshTokenExpiryStage(expiresAt, now)
    if (!stage) return null

    const when = formatRefreshTokenExpiresAt(expiresAt)
    if (stage === "expired") {
        return `リフレッシュトークンの有効期限（${when}）を過ぎています。再ログインしてトークンを差し替えてください`
    }

    const days = Math.ceil((expiresAt - now) / DAY_MS)
    return `リフレッシュトークンはあと${days}日（${when}）で失効します。それまでに再ログインしてトークンを差し替えてください`
}
