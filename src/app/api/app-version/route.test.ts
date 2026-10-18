import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import packageJson from "../../../../package.json" with { type: "json" }
import { GET } from "@/app/api/app-version/route"

const original = process.env.APP_COMMIT_SHA

describe("GET /api/app-version", () => {
    afterEach(() => {
        if (original === undefined) delete process.env.APP_COMMIT_SHA
        else process.env.APP_COMMIT_SHA = original
    })

    it("APP_COMMIT_SHA と版を返し、キャッシュさせない", async () => {
        process.env.APP_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
        const response = await GET()
        assert.equal(response.headers.get("cache-control"), "no-store")
        assert.deepEqual(await response.json(), {
            version: packageJson.version,
            sha: "0123456789abcdef0123456789abcdef01234567",
        })
    })

    it("未設定なら sha は null", async () => {
        delete process.env.APP_COMMIT_SHA
        const body = await (await GET()).json()
        assert.equal(body.sha, null)
    })
})
