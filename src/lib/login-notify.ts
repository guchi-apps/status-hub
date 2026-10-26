import { headers } from "next/headers"

import { notifyDiscordAlert } from "@/lib/discord-alert"

import { getAccessDb } from "@/lib/access/db"
import { recordLoginEvent, type LoginEventRecord } from "@/lib/access/policy"
import { getStatusHubAccess } from "@/lib/access/status-hub"
import { clientIpFromForwardedFor } from "@/lib/client-ip"
import { sendPushWhere } from "@/lib/push/web-push"

/** 通知に載せるメールは先頭1文字だけ残す（Discordへ渡す個人情報を最小限にする） */
function maskEmail(email: string): string {
    const [local = "", domain = ""] = email.split("@")
    return `${local.slice(0, 1)}***@${domain}`
}

/**
 * 新しい接続元だけをDiscordの異常通知へ送る（#625）。通常のログインは通知しない。
 * 届いたかどうかは呼び出し元が気にしなくてよい（ログインを止めない）。
 */
function alertNewIp(event: LoginEventRecord, source: string): Promise<boolean> {
    return notifyDiscordAlert({
        title: `新しい接続元からのログイン: ${source}`,
        description: "このアカウントで初めて見る接続元IPです。心当たりがなければアクセス管理で利用者を停止してください。",
        fields: [
            { name: "アカウント", value: maskEmail(event.email), inline: true },
            { name: "接続元IP", value: event.ip ?? "不明", inline: true },
            { name: "端末", value: event.userAgent?.slice(0, 100) ?? "不明" },
        ],
    })
}

/**
 * 他アプリのログイン成功を履歴へ残し、新しい接続元ならDiscordへ知らせる（#625。`POST /api/access/v1/login-events`）。
 * 初出判定はStatusHubの履歴（メール×接続元IP）で行い、アプリ間で共有する。
 */
export async function recordAppLogin(input: {
    email: string
    ip: string | null
    userAgent: string | null
    source: string
}): Promise<{ newIp: boolean }> {
    const event = recordLoginEvent(getAccessDb(), input, new Date())
    if (event.newIp) {
        await alertNewIp(event, input.source).catch((error) => console.error("[login-notify] Discord通知に失敗しました:", error))
    }
    return { newIp: event.newIp }
}

/**
 * Googleログイン成功を、アクセス管理の履歴へ残し、管理者の端末へWeb Pushで知らせる（#516）。新しい接続元はDiscordの異常通知にも送る（#625）。
 *
 * **ログインを止めない。** 記録・送信の失敗はログに残すだけで例外を投げない。送信はプッシュサービスの
 * 応答を待たない（`void`）ため、ログインの完了はその遅さに引きずられない。
 *
 * 接続元IPは `X-Forwarded-For` の末尾から読む（`clientIpFromForwardedFor`。先頭はクライアントが決められる）。
 * 送り先は、いまアクセスが許可されている管理者の、端末ごとの設定（`loginAlerts`）がオフでない購読だけ。
 * 「新しい接続元のみ」の端末へは、初めて見る接続元IPのときだけ送る。
 */
export async function recordAndNotifyLogin(options: { email: string }): Promise<void> {
    try {
        const headersList = await headers()
        const event = recordLoginEvent(
            getAccessDb(),
            {
                email: options.email,
                ip: clientIpFromForwardedFor(headersList.get("x-forwarded-for")),
                userAgent: headersList.get("user-agent")?.slice(0, 500) ?? null,
            },
            new Date()
        )

        const detail = [
            event.newIp ? "新しい接続元" : null,
            event.ip,
            event.userAgent?.slice(0, 120),
        ].filter(Boolean)

        if (event.newIp) void alertNewIp(event, "StatusHub")

        void sendPushWhere(
            (subscription) => {
                if (!subscription.email || !getStatusHubAccess(subscription.email).isAdmin) return false
                const mode = subscription.loginAlerts ?? "new"
                return mode === "always" || (mode === "new" && event.newIp)
            },
            {
                title: `🔐 ログイン: ${event.email}`,
                body: detail.join(" ・ "),
                tag: `login-${event.id}`,
                url: "/admin/access",
            }
        ).catch((error) => console.error("[login-notify] 通知の送信に失敗しました:", error))
    } catch (error) {
        console.error("[login-notify] ログインの記録に失敗しました:", error)
    }
}
