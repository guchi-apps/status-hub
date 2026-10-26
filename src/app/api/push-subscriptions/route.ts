import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { rejectCrossSiteRequest } from "@/lib/csrf"
import { requireSessionForApi } from "@/lib/session"
import {
    getVapidPublicKey,
    isLoginAlertsMode,
    isPushSubscription,
    isWebPushConfigured,
    listSubscriptions,
    removeSubscriptionOf,
    saveSubscription,
    sendPushTo,
} from "@/lib/push/web-push"
import { getIncidentSnapshot } from "@/lib/incidents/run"
import { buildTestMessage } from "@/lib/incidents/messages"

/**
 * AI利用枠のプッシュ通知（#263）を受け取る端末の登録。
 *
 * 登録した端末へは、サーバーが使用状況を取るたびに判定した通知が届く（`src/lib/ai-usage/alerts.ts`）。
 * 書き込みを伴うため、ログインセッションでだけ受け付ける（`OPS_API_TOKEN` では通さない）。
 */

/**
 * 通知ボタンを出すかと、購読に使う公開鍵。鍵が未設定なら publicKey は null。
 * `?endpoint=` を付けると、その端末のホスト・監視の通知がオンかを `hostAlerts` で返す（#495。
 * 自分の購読か、持ち主が未記録の購読だけ。他の利用者の端末の設定は返さない）
 */
export async function GET(request: NextRequest) {
    const { session, response } = await requireSessionForApi()
    if (response) return response

    const publicKey = isWebPushConfigured() ? getVapidPublicKey() : null
    const endpoint = request.nextUrl.searchParams.get("endpoint")
    if (!endpoint) return NextResponse.json({ publicKey })

    const target = (await listSubscriptions()).find((item) => item.endpoint === endpoint)
    const own = target && (!target.email || target.email === session.user.email)
    return NextResponse.json({ publicKey, hostAlerts: own ? target.hostAlerts !== false && !!target.email : null,
        loginAlerts: own ? (target.loginAlerts ?? "new") : null,
    })
}

/**
 * `{ subscription, confirm, hostAlerts, test }` — 端末を登録する。confirm が true なら確認の通知を1通送る
 * （ボタンで通知をオンにしたときだけ。起動のたびの登録し直しでは送らない）。
 * `hostAlerts`（真偽値）を渡すと、この端末のホスト・監視の通知を切り替える（渡さなければ現状のまま）。
 * `loginAlerts`（always / new / off）は管理者の端末へのログイン通知（#516）。
 * test が true なら、この端末だけへホスト通知のテストを送る。
 * 登録した端末は、ログインしている利用者のものとして記録する。
 */
export async function POST(request: NextRequest) {
    const { session, response } = await requireSessionForApi()
    if (response) return response

    const rejected = rejectCrossSiteRequest(request)
    if (rejected) return rejected

    if (!isWebPushConfigured()) {
        return NextResponse.json({ error: "通知の鍵が設定されていません" }, { status: 503 })
    }

    let payload: unknown
    try {
        payload = await request.json()
    } catch {
        return NextResponse.json({ error: "JSONとして読めませんでした" }, { status: 400 })
    }

    const { subscription, confirm, hostAlerts, loginAlerts, test } = (payload ?? {}) as Record<string, unknown>
    if (!isPushSubscription(subscription)) {
        return NextResponse.json({ error: "購読の形式が正しくありません" }, { status: 400 })
    }

    await saveSubscription(subscription, {
        email: session.user.email,
        hostAlerts: typeof hostAlerts === "boolean" ? hostAlerts : undefined,
        loginAlerts: isLoginAlertsMode(loginAlerts) ? loginAlerts : undefined,
    })

    if (test === true) {
        const delivered = await sendPushTo(subscription, buildTestMessage(await getIncidentSnapshot()))
        return NextResponse.json({ ok: true, delivered }, { status: 201 })
    }

    if (confirm === true) {
        const delivered = await sendPushTo(subscription, {
            title: "通知をオンにしました",
            body: "AI利用枠が上限に近づいたときと、ホストの停止・再起動があったときに、アプリを閉じていてもこの端末へ通知します。",
            tag: "push-confirm",
            url: "/?tab=usage",
        })
        return NextResponse.json({ ok: true, delivered }, { status: 201 })
    }

    return NextResponse.json({ ok: true }, { status: 201 })
}

/** `{ endpoint }` — この端末への通知を止める。他の利用者が登録した端末は止められない */
export async function DELETE(request: NextRequest) {
    const { session, response } = await requireSessionForApi()
    if (response) return response

    const rejected = rejectCrossSiteRequest(request)
    if (rejected) return rejected

    let payload: unknown
    try {
        payload = await request.json()
    } catch {
        return NextResponse.json({ error: "JSONとして読めませんでした" }, { status: 400 })
    }

    const { endpoint } = (payload ?? {}) as Record<string, unknown>
    if (typeof endpoint !== "string") {
        return NextResponse.json({ error: "endpoint を指定してください" }, { status: 400 })
    }

    if ((await removeSubscriptionOf(endpoint, session.user.email)) === "forbidden") {
        return NextResponse.json({ error: "この端末の通知は止められません" }, { status: 403 })
    }
    return NextResponse.json({ ok: true })
}
