import fs from "fs/promises"
import path from "path"

import { notifyDiscordAlert } from "@/lib/discord-alert"
import {
    formatRefreshTokenExpiresAt,
    refreshTokenExpiryStage,
    type RefreshTokenExpiryStage,
} from "@/lib/ai-usage/refresh-token-expiry"
import { readState, type TokenProvider } from "@/lib/ai-usage/token-store"

/**
 * リフレッシュトークンの失効が近づいたら Discord（`DISCORD_ALERT_WEBHOOK_URL`）へ知らせる（#641）。
 *
 * `src/instrumentation.ts` のプロセス内タイマーから呼ぶ。トークンストア（`.data/ai-usage-tokens.json`）に
 * 記録された失効予定だけを読み、提供元へは問い合わせない。段階（残り7日・1日・期限切れ）ごとに1回だけ送り、
 * **届いたときだけ記録する**（届かなければ次の判定で送り直す）。
 */

const PROVIDERS: { id: TokenProvider; name: string; envKey: string }[] = [
    { id: "claude", name: "Claude", envKey: "ANTHROPIC_OAUTH_REFRESH_TOKEN" },
    { id: "chatgpt", name: "ChatGPT", envKey: "OPENAI_CHATGPT_REFRESH_TOKEN" },
]

/** 重い順。期限を過ぎてから初めて判定した場合でも、軽い段階をあとから送らないために使う */
const STAGE_ORDER: RefreshTokenExpiryStage[] = ["7d", "1d", "expired"]

interface AlertEntry {
    /** 判定した失効予定（epoch ミリ秒）。トークンが差し替わって変われば、送った段階を数え直す */
    expiresAt: number
    /** 届いた段階 */
    sent: RefreshTokenExpiryStage[]
}

type AlertState = Partial<Record<TokenProvider, AlertEntry>>

function getAlertStatePath(): string {
    return (
        process.env.AI_TOKEN_EXPIRY_ALERTS_PATH ||
        path.join(process.cwd(), ".data", "ai-token-expiry-alerts.json")
    )
}

async function readAlertState(): Promise<AlertState> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(getAlertStatePath(), "utf8"))
        if (!parsed || typeof parsed !== "object") return {}
        return parsed as AlertState
    } catch {
        return {}
    }
}

async function writeAlertState(state: AlertState): Promise<void> {
    const file = getAlertStatePath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tempFile = `${file}.tmp`
    await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`)
    await fs.rename(tempFile, file)
}

function describeStage(stage: RefreshTokenExpiryStage): string {
    if (stage === "expired") return "有効期限を過ぎました"
    if (stage === "1d") return "あと1日以内に失効します"
    return "あと7日以内に失効します"
}

export type SendAlert = (input: { title: string; description?: string }) => Promise<boolean>

/**
 * 失効が近いトークンを判定し、まだ届いていない段階を送る。送った提供元の id を返す（テスト用）。
 * 環境変数のトークンと記録の `seededFrom` が食い違う（差し替え直後でまだ更新していない）ときは、
 * 古いトークンの期限なので判定しない。
 */
export async function runTokenExpiryAlerts({
    now = Date.now(),
    send = notifyDiscordAlert,
}: { now?: number; send?: SendAlert } = {}): Promise<TokenProvider[]> {
    const tokens = await readState()
    const state = await readAlertState()
    const sentProviders: TokenProvider[] = []
    let changed = false

    for (const provider of PROVIDERS) {
        const stored = tokens[provider.id]
        const expiresAt = stored?.refreshTokenExpiresAt
        if (!stored || typeof expiresAt !== "number") continue
        if (stored.seededFrom !== process.env[provider.envKey]) continue

        const stage = refreshTokenExpiryStage(expiresAt, now)
        if (!stage) continue

        const previous = state[provider.id]
        const sent = previous && previous.expiresAt === expiresAt ? previous.sent : []
        if (sent.includes(stage)) continue

        const delivered = await send({
            title: `${provider.name}のリフレッシュトークンが${describeStage(stage)}`,
            description:
                `失効予定: ${formatRefreshTokenExpiresAt(expiresAt)}（日本時間）。` +
                `${provider.name}へ再ログインして ${provider.envKey} を差し替えてください（手順はStatusHubのREADME「認証情報の取得方法」）`,
        })
        if (!delivered) continue

        // この段階より軽い段階も届いたものとして扱い、あとから古い段階の通知を送らない
        const reached = STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(stage) + 1)
        state[provider.id] = { expiresAt, sent: Array.from(new Set([...sent, ...reached])) }
        sentProviders.push(provider.id)
        changed = true
    }

    if (changed) await writeAlertState(state)
    return sentProviders
}
