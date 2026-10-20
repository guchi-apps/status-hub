import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it, mock } from "node:test"
import { readOpsApiToken, resetOpsApiTokenCache } from "@/lib/ops-api-token"

const ENV_KEYS = ["ISSUE_DECK_URL", "SHARED_TOKEN_API_SECRET", "OPS_API_TOKEN"] as const

let saved: Array<readonly [string, string | undefined]> = []

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
    for (const key of ENV_KEYS) {
        const value = values[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    return mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(handler(String(input), init))
    )
}

beforeEach(() => {
    saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
    resetOpsApiTokenCache()
})

afterEach(() => {
    mock.restoreAll()
    for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
})

const API_ENV = { ISSUE_DECK_URL: "https://issuedeck.example", SHARED_TOKEN_API_SECRET: "api-secret" }

describe("readOpsApiToken", () => {
    it("共有トークンをOPS_API_TOKENの名前・ops-dashboardの利用元で取得し、環境変数より優先する", async () => {
        setEnv({ ...API_ENV, OPS_API_TOKEN: "env-token" })
        const fetchMock = stubFetch(() => Response.json({ value: "shared-token" }))

        assert.equal(await readOpsApiToken(), "shared-token")

        const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit]
        assert.match(url, /\/api\/shared-tokens\?name=OPS_API_TOKEN$/)
        assert.equal((init.headers as Record<string, string>)["x-shared-token-consumer"], "ops-dashboard")
    })

    it("受ける側・送る側・TypeSafeでキャッシュを共有し、取得は1回で済む", async () => {
        setEnv(API_ENV)
        const fetchMock = stubFetch(() => Response.json({ value: "shared-token" }))

        await readOpsApiToken()
        await readOpsApiToken()
        assert.equal(await readOpsApiToken(), "shared-token")
        assert.equal(fetchMock.mock.calls.length, 1)
    })

    it("取得に失敗しても環境変数へはフォールバックしない", async () => {
        setEnv({ ...API_ENV, OPS_API_TOKEN: "env-token" })
        stubFetch(() => new Response("error", { status: 500 }))
        mock.method(console, "error", () => {})

        assert.equal(await readOpsApiToken(), undefined)
    })

    it("共有トークンAPIが未設定なら、取得を試みずundefinedを返す", async () => {
        setEnv({ OPS_API_TOKEN: "env-token" })
        const fetchMock = stubFetch(() => Response.json({ value: "unused" }))

        assert.equal(await readOpsApiToken(), undefined)
        assert.equal(fetchMock.mock.calls.length, 0)
    })
})
