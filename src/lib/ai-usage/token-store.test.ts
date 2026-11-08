import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { describe, it } from "node:test"
import { parseRefreshTokenExpiresAt } from "@/lib/ai-usage/claude"
import {
    describeRefreshTokenExpiry,
    refreshTokenExpiryStage,
} from "@/lib/ai-usage/refresh-token-expiry"
import { DAY, HOUR, redirectStateFile } from "@/lib/ai-usage/test-support"
import { getAccessToken, readState, type RefreshResult } from "@/lib/ai-usage/token-store"

const EXPIRES_AT = Date.UTC(2026, 10, 6, 6, 7, 12)

/** 呼ばれた回数を数える作り物の更新処理 */
function fakeRefresh(results: RefreshResult[]) {
    const calls: string[] = []
    const refresh = async (refreshToken: string) => {
        calls.push(refreshToken)
        const result = results.shift()
        if (!result) throw new Error("想定より多く呼ばれました")
        return result
    }
    return { refresh, calls }
}

describe("getAccessToken: リフレッシュトークンの失効予定", () => {
    it("更新の応答で返った失効予定を保存し、期限内の使い回しでも返す", async (t) => {
        redirectStateFile(t, "AI_USAGE_STATE_PATH")
        const { refresh, calls } = fakeRefresh([
            { accessToken: "a1", refreshToken: "r2", expiresInSeconds: 3600, refreshTokenExpiresAt: EXPIRES_AT },
        ])

        const first = await getAccessToken("claude", "r1", refresh)
        assert.equal(first.refreshed, true)
        assert.equal(first.refreshTokenExpiresAt, EXPIRES_AT)

        const second = await getAccessToken("claude", "r1", refresh)
        assert.equal(second.refreshed, false)
        assert.equal(second.refreshTokenExpiresAt, EXPIRES_AT)
        assert.deepEqual(calls, ["r1"])
    })

    it("応答に失効予定が無い回は、記録済みの値を持ち越す", async (t) => {
        redirectStateFile(t, "AI_USAGE_STATE_PATH")
        const { refresh } = fakeRefresh([
            { accessToken: "a1", refreshToken: "r2", expiresInSeconds: 3600, refreshTokenExpiresAt: EXPIRES_AT },
            { accessToken: "a2", refreshToken: "r3", expiresInSeconds: 3600 },
        ])

        await getAccessToken("claude", "r1", refresh)
        const again = await getAccessToken("claude", "r1", refresh, { invalidate: "a1" })

        assert.equal(again.refreshed, true)
        assert.equal(again.refreshTokenExpiresAt, EXPIRES_AT)
        assert.equal((await readState()).claude?.refreshTokenExpiresAt, EXPIRES_AT)
    })

    it("環境変数のトークンが差し替わったら、古い失効予定を引き継がない", async (t) => {
        const file = redirectStateFile(t, "AI_USAGE_STATE_PATH")
        writeFileSync(
            file,
            JSON.stringify({
                claude: { seededFrom: "old", refreshToken: "old2", refreshTokenExpiresAt: EXPIRES_AT },
            })
        )
        const { refresh, calls } = fakeRefresh([{ accessToken: "a1", refreshToken: "n2", expiresInSeconds: 3600 }])

        const token = await getAccessToken("claude", "new", refresh)

        assert.deepEqual(calls, ["new"])
        assert.equal(token.refreshTokenExpiresAt, undefined)
        assert.equal((await readState()).claude?.refreshTokenExpiresAt, undefined)
    })
})

describe("parseRefreshTokenExpiresAt", () => {
    const NOW = Date.UTC(2026, 9, 10, 0, 0, 0)

    it("有効期間（秒）を現在時刻からの時刻にする", () => {
        assert.equal(parseRefreshTokenExpiresAt({ refresh_token_expires_in: 3600 }, NOW), NOW + HOUR)
    })

    it("時刻で返った場合は秒・ミリ秒・文字列のどれでも読む", () => {
        assert.equal(parseRefreshTokenExpiresAt({ refresh_token_expires_at: EXPIRES_AT / 1000 }, NOW), EXPIRES_AT)
        assert.equal(parseRefreshTokenExpiresAt({ refresh_token_expires_at: EXPIRES_AT }, NOW), EXPIRES_AT)
        assert.equal(
            parseRefreshTokenExpiresAt({ refresh_token_expires_at: new Date(EXPIRES_AT).toISOString() }, NOW),
            EXPIRES_AT
        )
    })

    it("無い・不正な値なら undefined", () => {
        assert.equal(parseRefreshTokenExpiresAt({}, NOW), undefined)
        assert.equal(parseRefreshTokenExpiresAt({ refresh_token_expires_in: 0 }, NOW), undefined)
        assert.equal(parseRefreshTokenExpiresAt({ refresh_token_expires_at: "不明" }, NOW), undefined)
    })
})

describe("refreshTokenExpiryStage / describeRefreshTokenExpiry", () => {
    it("7日より先は何も出さず、7日・1日・期限切れで段階が変わる", () => {
        assert.equal(refreshTokenExpiryStage(EXPIRES_AT, EXPIRES_AT - 8 * DAY), null)
        assert.equal(refreshTokenExpiryStage(EXPIRES_AT, EXPIRES_AT - 7 * DAY), "7d")
        assert.equal(refreshTokenExpiryStage(EXPIRES_AT, EXPIRES_AT - DAY), "1d")
        assert.equal(refreshTokenExpiryStage(EXPIRES_AT, EXPIRES_AT), "expired")
    })

    it("残り日数は切り上げで出す", () => {
        const iso = new Date(EXPIRES_AT).toISOString()
        assert.equal(describeRefreshTokenExpiry(iso, EXPIRES_AT - 8 * DAY), null)
        assert.match(describeRefreshTokenExpiry(iso, EXPIRES_AT - 30 * HOUR) ?? "", /あと2日/)
        assert.match(describeRefreshTokenExpiry(iso, EXPIRES_AT + HOUR) ?? "", /過ぎています/)
        assert.equal(describeRefreshTokenExpiry(undefined, EXPIRES_AT), null)
    })
})
