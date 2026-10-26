import { isIP } from "node:net"

import { NextResponse } from "next/server"

import { getAccessDb } from "@/lib/access/db"
import { findAppByToken, normalizeEmail } from "@/lib/access/policy"
import { clientIpFromForwardedFor } from "@/lib/client-ip"
import { recordAppLogin } from "@/lib/login-notify"

export const dynamic = "force-dynamic"

/**
 * 各アプリのログイン成功を報告し、新しい接続元ならDiscordの異常通知へ送る契約API（#625。Signalyの代わり）。
 *
 * 認証は判定API（`/api/access/v1/decision`）と同じアプリ別トークン。**通常のログインは通知しない。**
 * 初出の判定は「同じメールで、履歴（全アプリ共通）に無い接続元IP」。
 *
 * - `POST { email, forwardedFor?, ip?, userAgent? }`
 * - 呼び出し元のアプリが自分のサーバーで検証したメールだけを送る（ブラウザの申告をそのまま送らない）
 * - 接続元は `forwardedFor`（アプリが受けた `X-Forwarded-For` の生の値）を渡すのが望ましい。
 *   **末尾の要素だけを採る**（先頭はクライアントが決められるため、見覚えのある接続元を名乗れてしまう）。
 *   `ip` は、アプリ側で既に末尾から取り出した値を渡す場合に使う。IPとして読めない値は「不明」扱いで、初出にしない
 * - 失敗してもアプリのログインは止めない（呼び出し側は結果を待たず、エラーを握りつぶしてよい）
 */
export async function POST(request: Request) {
    const noStore = { "Cache-Control": "no-store" }

    try {
        const authorization = request.headers.get("authorization")
        const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : ""
        const app = findAppByToken(getAccessDb(), token)
        if (!app) {
            return NextResponse.json({ error: "認証が必要です" }, { status: 401, headers: noStore })
        }

        let payload: unknown
        try {
            payload = await request.json()
        } catch {
            return NextResponse.json({ error: "JSONとして読めませんでした" }, { status: 400, headers: noStore })
        }

        const body = (payload ?? {}) as Record<string, unknown>
        const email = normalizeEmail(body.email)
        if (!email) {
            return NextResponse.json({ error: "email が必要です" }, { status: 400, headers: noStore })
        }

        const rawIp =
            typeof body.forwardedFor === "string"
                ? clientIpFromForwardedFor(body.forwardedFor)
                : typeof body.ip === "string"
                  ? body.ip.trim()
                  : null
        const ip = rawIp && isIP(rawIp) ? rawIp : null
        const userAgent = typeof body.userAgent === "string" ? body.userAgent.slice(0, 500) : null

        const result = await recordAppLogin({ email, ip, userAgent, source: app.name })
        return NextResponse.json({ newIp: result.newIp }, { headers: noStore })
    } catch (error) {
        console.error("[access] ログイン報告APIでエラー:", error)
        return NextResponse.json({ error: "アクセス設定を読めません" }, { status: 503, headers: noStore })
    }
}
