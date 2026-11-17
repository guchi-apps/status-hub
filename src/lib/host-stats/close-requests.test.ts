import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, it } from "node:test"
import type { TestContext } from "node:test"
import {
    CLOSE_REQUEST_TTL_MS,
    enqueueCloseRequest,
    enqueueCloseStaleRequest,
    isValidCloseTarget,
    settleCloseRequests,
    settleCloseStaleRequest,
} from "@/lib/host-stats/close-requests"
import { redirectStateFile } from "@/lib/ai-usage/test-support"
import type { HostStatsTmuxSession } from "@/types/host-stats"

const NOW = Date.UTC(2026, 8, 24, 3, 0, 0)

function session(name: string, user = "guchi"): HostStatsTmuxSession {
    return { name, user, windows: 1, attached: false }
}

/** ホストのデータ置き場を一時ディレクトリへ向ける */
function redirectDataDir(t: TestContext) {
    redirectStateFile(t, "HOST_STATS_DATA_DIR") // ファイル名だが、ここではディレクトリとして使われる
}

describe("isValidCloseTarget", () => {
    it("通常のセッション名とユーザー名を通す", () => {
        assert.equal(isValidCloseTarget("guchi", "ops-dashboard-issue-409"), true)
        assert.equal(isValidCloseTarget("uid:1000", "a.b_c-1"), true)
    })

    it("シェルやtmuxのオプションに読まれうる文字を弾く", () => {
        for (const name of ["", "-t", ".hidden", "a b", "a;rm -rf /", "$(id)", "a`b`", "a\nb", "a/b", "../x"]) {
            assert.equal(isValidCloseTarget("guchi", name), false, name)
        }
        assert.equal(isValidCloseTarget("gu chi", "x"), false)
        assert.equal(isValidCloseTarget(undefined, "x"), false)
        assert.equal(isValidCloseTarget("guchi", 1), false)
    })
})

describe("enqueueCloseRequest", () => {
    it("一覧に載っているセッションだけを受け付ける", async (t) => {
        redirectDataDir(t)
        const sessions = [session("a")]

        assert.equal(await enqueueCloseRequest("subpc", { user: "guchi", name: "a" }, sessions, NOW), "queued")
        assert.equal(await enqueueCloseRequest("subpc", { user: "guchi", name: "b" }, sessions, NOW), "unknown-session")
        assert.equal(await enqueueCloseRequest("subpc", { user: "other", name: "a" }, sessions, NOW), "unknown-session")
        assert.equal(await enqueueCloseRequest("subpc", { user: "guchi", name: "-x" }, sessions, NOW), "invalid")
    })

    it("同じ依頼は二重に積まない。期限が切れたら積み直せる", async (t) => {
        redirectDataDir(t)
        const sessions = [session("a")]
        const target = { user: "guchi", name: "a" }

        assert.equal(await enqueueCloseRequest("subpc", target, sessions, NOW), "queued")
        assert.equal(await enqueueCloseRequest("subpc", target, sessions, NOW + 1000), "exists")
        assert.equal(
            await enqueueCloseRequest("subpc", target, sessions, NOW + CLOSE_REQUEST_TTL_MS),
            "queued"
        )
    })

    it("パスに繋げないホストIDを弾く", async (t) => {
        redirectDataDir(t)
        await assert.rejects(
            enqueueCloseRequest("../etc", { user: "guchi", name: "a" }, [session("a")], NOW)
        )
    })
})

describe("settleCloseRequests", () => {
    it("残っている依頼を <ユーザー>|<名前> で返す", async (t) => {
        redirectDataDir(t)
        await enqueueCloseRequest("subpc", { user: "guchi", name: "a" }, [session("a")], NOW)

        assert.deepEqual(await settleCloseRequests("subpc", [session("a")], NOW + 60_000), ["guchi|a"])
    })

    it("一覧から消えた依頼は完了として捨てる", async (t) => {
        redirectDataDir(t)
        await enqueueCloseRequest("subpc", { user: "guchi", name: "a" }, [session("a")], NOW)

        assert.deepEqual(await settleCloseRequests("subpc", [session("b")], NOW + 60_000), [])
        assert.deepEqual(await settleCloseRequests("subpc", [session("a")], NOW + 61_000), [])
    })

    it("期限切れの依頼は渡さず、ファイルからも消す", async (t) => {
        redirectDataDir(t)
        await enqueueCloseRequest("subpc", { user: "guchi", name: "a" }, [session("a")], NOW)

        const expired = NOW + CLOSE_REQUEST_TTL_MS
        assert.deepEqual(await settleCloseRequests("subpc", [session("a")], expired), [])

        const file = path.join(process.env.HOST_STATS_DATA_DIR ?? "", "subpc", "close-requests.json")
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [])
    })

    it("一覧を送ってこないホストでは、期限だけで捨てる", async (t) => {
        redirectDataDir(t)
        await enqueueCloseRequest("subpc", { user: "guchi", name: "a" }, [session("a")], NOW)

        assert.deepEqual(await settleCloseRequests("subpc", undefined, NOW + 1000), ["guchi|a"])
    })
})

describe("放置セッションをまとめて閉じる依頼", () => {
    it("セッションを指さず依頼時刻だけを積み、期限内は二重に積まない", async (t) => {
        redirectDataDir(t)

        assert.equal(await settleCloseStaleRequest("subpc", NOW), null)
        assert.equal(await enqueueCloseStaleRequest("subpc", NOW), "queued")
        assert.equal(await enqueueCloseStaleRequest("subpc", NOW + 1000), "exists")
        assert.equal(await settleCloseStaleRequest("subpc", NOW + 60_000), NOW)
    })

    it("期限が切れたら捨て、積み直せる", async (t) => {
        redirectDataDir(t)
        await enqueueCloseStaleRequest("subpc", NOW)

        assert.equal(await settleCloseStaleRequest("subpc", NOW + CLOSE_REQUEST_TTL_MS), null)
        assert.equal(await enqueueCloseStaleRequest("subpc", NOW + CLOSE_REQUEST_TTL_MS + 1), "queued")
    })

    it("パスに繋げないホストIDを弾く", async (t) => {
        redirectDataDir(t)
        await assert.rejects(enqueueCloseStaleRequest("../etc", NOW))
        await assert.rejects(settleCloseStaleRequest("../etc", NOW))
    })
})
