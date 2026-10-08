import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it, mock } from "node:test"
import { sharedTokenWriteConfigurationError, writeSharedToken } from "@/lib/shared-token"

const keys = ["ISSUE_DECK_URL", "SHARED_TOKEN_API_SECRET", "SHARED_TOKEN_WRITE_SECRET"] as const
let previous: (string | undefined)[]
beforeEach(() => {
    previous = keys.map((key) => process.env[key])
    process.env.ISSUE_DECK_URL = "https://issuedeck.example"
    process.env.SHARED_TOKEN_API_SECRET = "read-secret"
    process.env.SHARED_TOKEN_WRITE_SECRET = "write-secret"
})
afterEach(() => {
    keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key]
        else process.env[key] = previous[index]
    })
    mock.restoreAll()
})

describe("保護対象の共有トークン更新", () => {
    it("専用Bearerを通常Bearerと併せて送り、値を戻り値に含めない", async () => {
        const calls = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            assert.equal(headers.get("authorization"), "Bearer read-secret")
            assert.equal(headers.get("x-shared-token-write-authorization"), "Bearer write-secret")
            assert.equal(headers.get("x-shared-token-consumer"), "ops-dashboard")
            return Response.json({})
        })
        assert.equal(sharedTokenWriteConfigurationError("ISSUE_DECK_ACCESS_APP_TOKEN"), null)
        assert.deepEqual(await writeSharedToken("ISSUE_DECK_ACCESS_APP_TOKEN", "token", "description"), {
            ok: true, name: "ISSUE_DECK_ACCESS_APP_TOKEN",
        })
        assert.equal(calls.mock.callCount(), 1)
    })
    for (const invalid of [undefined, "read-secret"]) {
        it(`専用キーが${invalid === undefined ? "未設定" : "読み取りキーと同一"}なら通信前に拒否する`, async () => {
            if (invalid === undefined) delete process.env.SHARED_TOKEN_WRITE_SECRET
            else process.env.SHARED_TOKEN_WRITE_SECRET = invalid
            const calls = mock.method(globalThis, "fetch", async () => Response.json({}))
            assert.ok(sharedTokenWriteConfigurationError("ISSUE_DECK_ACCESS_APP_TOKEN"))
            assert.equal((await writeSharedToken("ISSUE_DECK_ACCESS_APP_TOKEN", "token", "description")).ok, false)
            assert.equal(calls.mock.callCount(), 0)
        })
    }
    it("他アプリの更新には専用キーを送らず、未設定でも継続できる", async () => {
        delete process.env.SHARED_TOKEN_WRITE_SECRET
        mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
            assert.equal(new Headers(init?.headers).get("x-shared-token-write-authorization"), null)
            return Response.json({})
        })
        assert.equal(sharedTokenWriteConfigurationError("AIDE_ACCESS_APP_TOKEN"), null)
        assert.equal((await writeSharedToken("AIDE_ACCESS_APP_TOKEN", "token", "description")).ok, true)
    })
})
