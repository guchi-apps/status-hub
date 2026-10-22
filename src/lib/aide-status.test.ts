import assert from "node:assert/strict"
import { afterEach, describe, it, mock } from "node:test"
import { getAideStatusSnapshot, isAideStatusConfigured, runAideStatusChecks } from "@/lib/aide-status"

/**
 * 環境変数へのフォールバックは無い（#610）。ここでは未設定・取得失敗の振る舞いだけを確かめる。
 * 共有トークンAPI自体のキャッシュ・取得成功の挙動は `shared-token.test.ts` で確かめている
 * （プロセス内キャッシュを持つモジュールのため、成功するテストを混ぜると
 * 前のテストのキャッシュが残ってしまう。この順序に依存するので、成功の経路は足さない）。
 */

const ENV_KEYS = ["AIDE_BASE_URL", "ISSUE_DECK_URL", "SHARED_TOKEN_API_SECRET"] as const

function setEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
    const previous = ENV_KEYS.map((key) => [key, process.env[key]] as const)
    for (const key of ENV_KEYS) delete process.env[key]
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value

    return () => {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    return mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(handler(String(input), init))
    )
}

const goodStatusPayload = {
    health: {
        severity: "ok",
        attention: [],
        jobs: [],
        connectors: [],
        server: {},
        cache: {},
        mcp: {},
        mcpAccess: {},
    },
    tools: ["weather"],
}

afterEach(() => mock.restoreAll())

describe("isAideStatusConfigured", () => {
    it("共有トークンAPIの設定が無ければfalse", () => {
        const restore = setEnv({})
        try {
            assert.equal(isAideStatusConfigured(), false)
        } finally {
            restore()
        }
    })

    it("共有トークンAPIの設定（URL・secret）が揃えばtrue", () => {
        const restore = setEnv({ ISSUE_DECK_URL: "https://issuedeck.example", SHARED_TOKEN_API_SECRET: "secret" })
        try {
            assert.equal(isAideStatusConfigured(), true)
        } finally {
            restore()
        }
    })

    it("共有トークンAPIのURL・secretの片方だけではfalse", () => {
        const restore = setEnv({ ISSUE_DECK_URL: "https://issuedeck.example" })
        try {
            assert.equal(isAideStatusConfigured(), false)
        } finally {
            restore()
        }
    })
})

describe("未設定", () => {
    it("共有トークンAPIが未設定ならAIDEへ問い合わせず未設定を返す", async () => {
        const restore = setEnv({})
        try {
            const fetchMock = stubFetch(() => Response.json(goodStatusPayload))

            const snapshot = await getAideStatusSnapshot()

            assert.equal(snapshot.status, "unconfigured")
            assert.equal(fetchMock.mock.calls.length, 0)
            assert.equal((await runAideStatusChecks()).status, "unconfigured")
        } finally {
            restore()
        }
    })
})

describe("getAideStatusSnapshot: 共有トークンAPI", () => {
    const sharedEnv = {
        ISSUE_DECK_URL: "https://issuedeck.example",
        SHARED_TOKEN_API_SECRET: "secret",
    }

    it("取得に失敗したときは、未設定ではなくエラーとして返す", async () => {
        const restore = setEnv(sharedEnv)
        try {
            stubFetch(() => new Response("down", { status: 503 }))

            const snapshot = await getAideStatusSnapshot()

            assert.equal(snapshot.status, "error")
            assert.match(snapshot.message ?? "", /issue-deck/)
        } finally {
            restore()
        }
    })
})
