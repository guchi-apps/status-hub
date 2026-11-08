/**
 * サーバー起動時に1回だけ呼ばれる（Next.js の instrumentation）。
 *
 * ホスト停止・再起動の検知は、画面の表示や停止したホストからの次回POSTに頼れないため、
 * VPSのプロセス内で定期的に判定する（#495）。PM2は fork モード1プロセスのため、プロセス内の
 * タイマーで足りる。`next build` では `register` は呼ばれず、Edgeでは動かさない。
 */

const INTERVAL_MS = 30_000

/** 単価の定期チェック（#497）が「予定時刻を過ぎたか」を見にいく間隔。実際の取得は週1回だけ */
const PRICE_WATCH_INTERVAL_MS = 60_000

/** リフレッシュトークンの失効予定を見にいく間隔（#641）。記録済みの期限を読むだけで、提供元へは問い合わせない */
const TOKEN_EXPIRY_INTERVAL_MS = 60 * 60_000

export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return

    const globalForTimer = globalThis as unknown as {
        __incidentTimer?: ReturnType<typeof setInterval>
        __priceWatchTimer?: ReturnType<typeof setInterval>
        __tokenExpiryTimer?: ReturnType<typeof setInterval>
    }
    if (globalForTimer.__incidentTimer) return

    const { runIncidentCheck } = await import("@/lib/incidents/run")
    const tick = () => {
        runIncidentCheck().catch((error) => console.error("[incidents] 判定に失敗しました:", error))
    }

    globalForTimer.__incidentTimer = setInterval(tick, INTERVAL_MS)
    // プロセスの終了を止めない
    globalForTimer.__incidentTimer.unref?.()
    tick()

    // モデル単価表の定期チェック。画面を開いていなくても動き、停止中に予定時刻を過ぎていれば起動後すぐ実行する
    const { runModelPriceWatchIfDue } = await import("@/lib/ai-app-usage/price-watch/run")
    const priceTick = () => {
        runModelPriceWatchIfDue().catch((error) => console.error("[model-price-watch] チェックに失敗しました:", error))
    }

    globalForTimer.__priceWatchTimer = setInterval(priceTick, PRICE_WATCH_INTERVAL_MS)
    globalForTimer.__priceWatchTimer.unref?.()
    priceTick()

    // AI利用枠のリフレッシュトークンの失効が近づいたらDiscordへ知らせる
    const { runTokenExpiryAlerts } = await import("@/lib/ai-usage/token-expiry-alert")
    const tokenExpiryTick = () => {
        runTokenExpiryAlerts().catch((error) =>
            console.error("[token-expiry-alert] 判定に失敗しました:", error)
        )
    }

    globalForTimer.__tokenExpiryTimer = setInterval(tokenExpiryTick, TOKEN_EXPIRY_INTERVAL_MS)
    globalForTimer.__tokenExpiryTimer.unref?.()
    tokenExpiryTick()
}
