import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { TestContext } from "node:test"
import {
    CLEANUP_QUEUED_TTL_MS,
    CLEANUP_RUNNING_TTL_MS,
    enqueueCleanupRequest,
    readPendingCleanup,
    settleCleanupRequests,
} from "@/lib/host-stats/cleanup-requests"
import { redirectStateFile } from "@/lib/ai-usage/test-support"
import type { HostStatsCleanup, HostStatsCleanupRun } from "@/types/host-stats"

const NOW = Date.UTC(2026, 10, 17, 11, 0, 0)

function redirectDataDir(t: TestContext) {
    redirectStateFile(t, "HOST_STATS_DATA_DIR") // ファイル名だが、ここではディレクトリとして使われる
}

function cleanup(lastRun?: HostStatsCleanupRun): HostStatsCleanup {
    return {
        targets: [
            { id: "tmux-stale", bytes: null, count: null },
            { id: "npm-cache", bytes: 100, count: null, lastRun },
        ],
    }
}

describe("enqueueCleanupRequest", () => {
    it("エージェントが申告した対象だけを受け付け、同じ対象の二重依頼は積まない", async (t) => {
        redirectDataDir(t)

        assert.equal(await enqueueCleanupRequest("subpc", "npm-cache", cleanup(), NOW), "queued")
        assert.equal(await enqueueCleanupRequest("subpc", "npm-cache", cleanup(), NOW + 1000), "exists")
        assert.equal(await enqueueCleanupRequest("subpc", "tmp-stale", cleanup(), NOW), "unsupported")
        assert.equal(await enqueueCleanupRequest("subpc", "npm-cache", undefined, NOW), "unsupported")
        assert.equal(await enqueueCleanupRequest("subpc", "../etc", cleanup(), NOW), "invalid")
        // tmux は閉じる依頼（#409）で扱うため、このキューには積まない
        assert.equal(await enqueueCleanupRequest("subpc", "tmux-stale", cleanup(), NOW), "invalid")

        assert.deepEqual(await readPendingCleanup("subpc", NOW), [{ target: "npm-cache", requestedAt: NOW }])
    })

    it("ホストIDがパスとして危ない形なら投げる", async (t) => {
        redirectDataDir(t)
        await assert.rejects(enqueueCleanupRequest("../x", "npm-cache", cleanup(), NOW))
    })
})

describe("settleCleanupRequests", () => {
    it("始まるまでは毎回同じ依頼を返し、running の結果が届いたら返すのをやめる", async (t) => {
        redirectDataDir(t)
        await enqueueCleanupRequest("subpc", "npm-cache", cleanup(), NOW)

        assert.deepEqual(await settleCleanupRequests("subpc", cleanup(), NOW + 60_000), [`npm-cache:${NOW}`])
        assert.deepEqual(await settleCleanupRequests("subpc", cleanup(), NOW + 120_000), [`npm-cache:${NOW}`])

        const running = cleanup({ requestedAt: NOW, status: "running" })
        assert.deepEqual(await settleCleanupRequests("subpc", running, NOW + 180_000), [])
        // 実行中は画面に残す
        assert.equal((await readPendingCleanup("subpc", NOW + 180_000)).length, 1)

        // 実行中のまま受け取られない期限（15分）を過ぎても、実行中なら捨てない
        assert.deepEqual(await settleCleanupRequests("subpc", running, NOW + CLEANUP_QUEUED_TTL_MS + 1), [])
        assert.equal((await readPendingCleanup("subpc", NOW + CLEANUP_QUEUED_TTL_MS + 1)).length, 1)

        const done = cleanup({ requestedAt: NOW, status: "ok", freedBytes: 100 })
        assert.deepEqual(await settleCleanupRequests("subpc", done, NOW + CLEANUP_QUEUED_TTL_MS + 2), [])
        assert.deepEqual(await readPendingCleanup("subpc", NOW + CLEANUP_QUEUED_TTL_MS + 2), [])
    })

    it("前回の（古い）結果では完了にしない", async (t) => {
        redirectDataDir(t)
        await enqueueCleanupRequest("subpc", "npm-cache", cleanup(), NOW)

        const previous = cleanup({ requestedAt: NOW - 86_400_000, status: "ok" })
        assert.deepEqual(await settleCleanupRequests("subpc", previous, NOW + 1000), [`npm-cache:${NOW}`])
    })

    it("受け取られないまま期限が過ぎたら捨てる", async (t) => {
        redirectDataDir(t)
        await enqueueCleanupRequest("subpc", "npm-cache", cleanup(), NOW)

        assert.deepEqual(await settleCleanupRequests("subpc", cleanup(), NOW + CLEANUP_QUEUED_TTL_MS), [])
        assert.deepEqual(await readPendingCleanup("subpc", NOW + CLEANUP_QUEUED_TTL_MS), [])
    })

    it("実行中のまま結果が戻らなければ、長い期限で捨てる", async (t) => {
        redirectDataDir(t)
        await enqueueCleanupRequest("subpc", "npm-cache", cleanup(), NOW)
        const running = cleanup({ requestedAt: NOW, status: "running" })
        await settleCleanupRequests("subpc", running, NOW + 60_000)

        assert.deepEqual(await settleCleanupRequests("subpc", running, NOW + CLEANUP_RUNNING_TTL_MS), [])
        assert.deepEqual(await readPendingCleanup("subpc", NOW + CLEANUP_RUNNING_TTL_MS), [])
    })
})
