import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { fetchGitHubAppRateLimits, parseAppRateLimitResponse } from "@/lib/github-app-rate-limit"
import { resetOpsApiTokenCache } from "@/lib/ops-api-token"

const ENV_KEYS = ["ISSUE_DECK_URL", "SHARED_TOKEN_API_SECRET", "OPS_API_TOKEN"] as const
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
    }
    resetOpsApiTokenCache()
})

const VALID = {
    installations: [
        {
            accountLogin: "guchi-apps",
            resources: [
                { key: "core", label: "REST", limit: 5600, remaining: 2898, used: 2702, reset: 1_700_000_000 },
                { key: "graphql", label: "GraphQL", limit: 5600, remaining: 5600, used: 0, reset: 1_700_003_600 },
            ],
        },
    ],
}

test("RESTとGraphQLの枠を読み取り、resetを時刻へ直す", () => {
    const parsed = parseAppRateLimitResponse(VALID)
    assert.equal(parsed?.[0].accountLogin, "guchi-apps")
    assert.deepEqual(parsed?.[0].resources.map((r) => r.label), ["REST", "GraphQL"])
    assert.equal(parsed?.[0].resources[0].resetsAt, "2023-11-14T22:13:20.000Z")
})

test("1行でも形が違えば全体を捨てる", () => {
    const broken = { installations: [{ accountLogin: "x", resources: [{ key: "core", label: "REST" }] }] }
    assert.equal(parseAppRateLimitResponse(broken), null)
    assert.equal(parseAppRateLimitResponse({}), null)
})

test("設定が無ければ取得せず unconfigured", async () => {
    delete process.env.ISSUE_DECK_URL
    delete process.env.SHARED_TOKEN_API_SECRET
    delete process.env.OPS_API_TOKEN
    assert.equal((await fetchGitHubAppRateLimits()).status, "unconfigured")
})

test("成功・HTTPエラー・形式不正を区別する", async (t) => {
    process.env.ISSUE_DECK_URL = "https://issuedeck.example"
    process.env.SHARED_TOKEN_API_SECRET = "api-secret"
    delete process.env.OPS_API_TOKEN

    const responses = [Response.json(VALID), new Response(null, { status: 404 }), Response.json({ foo: 1 })]
    const authHeaders: (string | null)[] = []
    t.mock.method(globalThis, "fetch", (input: unknown, init?: RequestInit) => {
        if (String(input).includes("/api/shared-tokens")) return Promise.resolve(Response.json({ value: "token" }))
        authHeaders.push(new Headers(init?.headers).get("authorization"))
        return Promise.resolve(responses.shift() as Response)
    })

    const ok = await fetchGitHubAppRateLimits()
    assert.equal(ok.status, "ok")
    assert.equal(authHeaders[0], "Bearer token")

    const notFound = await fetchGitHubAppRateLimits()
    assert.deepEqual([notFound.status, notFound.message], ["error", "HTTP 404"])

    const malformed = await fetchGitHubAppRateLimits()
    assert.deepEqual([malformed.status, malformed.message], ["error", "応答の形式が想定と異なります"])
})
