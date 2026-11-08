import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { describe, it, type TestContext } from "node:test"
import { runTokenExpiryAlerts, type SendAlert } from "@/lib/ai-usage/token-expiry-alert"
import { DAY, HOUR, redirectStateFile } from "@/lib/ai-usage/test-support"

const EXPIRES_AT = Date.UTC(2026, 10, 6, 6, 7, 12)

/** トークンストアと通知の記録を一時ファイルへ向け、Claudeの失効予定を書いておく */
function prepare(t: TestContext, { seededFrom = "env-token", expiresAt = EXPIRES_AT } = {}) {
    const tokens = redirectStateFile(t, "AI_USAGE_STATE_PATH")
    redirectStateFile(t, "AI_TOKEN_EXPIRY_ALERTS_PATH")

    const previous = process.env.ANTHROPIC_OAUTH_REFRESH_TOKEN
    process.env.ANTHROPIC_OAUTH_REFRESH_TOKEN = "env-token"
    t.after(() => {
        if (previous === undefined) delete process.env.ANTHROPIC_OAUTH_REFRESH_TOKEN
        else process.env.ANTHROPIC_OAUTH_REFRESH_TOKEN = previous
    })

    writeFileSync(
        tokens,
        JSON.stringify({ claude: { seededFrom, refreshToken: "rotated", refreshTokenExpiresAt: expiresAt } })
    )
}

function recorder(delivered = true) {
    const titles: string[] = []
    const send: SendAlert = async ({ title }) => {
        titles.push(title)
        return delivered
    }
    return { send, titles }
}

describe("runTokenExpiryAlerts", () => {
    it("7日より先なら送らない", async (t) => {
        prepare(t)
        const { send, titles } = recorder()
        await runTokenExpiryAlerts({ now: EXPIRES_AT - 8 * DAY, send })
        assert.deepEqual(titles, [])
    })

    it("段階ごとに1回だけ送る", async (t) => {
        prepare(t)
        const { send, titles } = recorder()

        await runTokenExpiryAlerts({ now: EXPIRES_AT - 6 * DAY, send })
        await runTokenExpiryAlerts({ now: EXPIRES_AT - 5 * DAY, send })
        await runTokenExpiryAlerts({ now: EXPIRES_AT - 12 * HOUR, send })
        await runTokenExpiryAlerts({ now: EXPIRES_AT - 6 * HOUR, send })
        await runTokenExpiryAlerts({ now: EXPIRES_AT + HOUR, send })

        assert.equal(titles.length, 3)
        assert.match(titles[0], /7日以内/)
        assert.match(titles[1], /1日以内/)
        assert.match(titles[2], /過ぎました/)
    })

    it("いきなり1日を切っていたら、あとから7日の通知は送らない", async (t) => {
        prepare(t)
        const { send, titles } = recorder()

        await runTokenExpiryAlerts({ now: EXPIRES_AT - 12 * HOUR, send })
        await runTokenExpiryAlerts({ now: EXPIRES_AT - 11 * HOUR, send })

        assert.equal(titles.length, 1)
        assert.match(titles[0], /1日以内/)
    })

    it("届かなかった通知は記録せず、次の判定で送り直す", async (t) => {
        prepare(t)
        const failing = recorder(false)
        await runTokenExpiryAlerts({ now: EXPIRES_AT - 6 * DAY, send: failing.send })

        const ok = recorder()
        await runTokenExpiryAlerts({ now: EXPIRES_AT - 6 * DAY, send: ok.send })

        assert.equal(failing.titles.length, 1)
        assert.equal(ok.titles.length, 1)
    })

    it("環境変数のトークンが差し替わった直後（記録が古いトークンのもの）は判定しない", async (t) => {
        prepare(t, { seededFrom: "old-token" })
        const { send, titles } = recorder()
        await runTokenExpiryAlerts({ now: EXPIRES_AT - DAY / 2, send })
        assert.deepEqual(titles, [])
    })
})
