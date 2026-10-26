import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { processTimerAlerts } from "@/lib/host-stats/timer-alerts"
import type { HostStatsTimer } from "@/types/host-stats"

const WEBHOOK = "https://discord.example/api/webhooks/123/SECRET-TOKEN"

const okTimer: HostStatsTimer = {
    name: "job",
    unit: "job.timer",
    available: true,
    loaded: true,
    active: true,
    result: "success",
    lastFinishedAt: "2026-10-26T00:00:00Z",
}
const failed = (finishedAt: string): HostStatsTimer => ({
    ...okTimer,
    result: "exit-code",
    exitStatus: 1,
    lastFinishedAt: finishedAt,
})

describe("定期ジョブの異常通知（Discord）", () => {
    const realFetch = globalThis.fetch
    const realError = console.error
    let dir: string
    let posts: { url: string; body: string }[]
    let status: number
    let logs: string[]

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), "timer-alerts-test-"))
        process.env.HOST_STATS_DATA_DIR = dir
        process.env.DISCORD_ALERT_WEBHOOK_URL = WEBHOOK
        delete process.env.HOST_STATS_TIMER_FAILURE_THRESHOLD
        posts = []
        logs = []
        status = 204
        console.error = (...args: unknown[]) => void logs.push(args.join(" "))
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            posts.push({ url: String(url), body: String(init?.body) })
            return new Response(status === 204 ? null : "err", { status })
        }) as typeof fetch
    })

    afterEach(() => {
        globalThis.fetch = realFetch
        console.error = realError
        delete process.env.HOST_STATS_DATA_DIR
        delete process.env.DISCORD_ALERT_WEBHOOK_URL
        rmSync(dir, { recursive: true, force: true })
    })

    const run = (timer: HostStatsTimer) =>
        processTimerAlerts({ hostId: "h", hostLabel: "ホスト", timers: [timer] })

    it("失敗は1回だけ送り、同じ失敗の繰り返しでは送らない", async () => {
        await run(okTimer)
        await run(failed("2026-10-26T01:00:00Z"))
        await run(failed("2026-10-26T01:00:00Z"))
                assert.equal(posts.length, 1)
        assert.equal(posts[0].url, WEBHOOK)
        assert.match(posts[0].body, /定期ジョブの異常/)
    })

    it("復旧は新規投稿しない", async () => {
        await run(failed("2026-10-26T01:00:00Z"))
        await run(okTimer)
                assert.equal(posts.length, 1)
        // 復旧後に再び失敗すれば新しい異常として送る
        await run(failed("2026-10-26T03:00:00Z"))
        assert.equal(posts.length, 2)
    })

    it("正常のままなら何も送らない", async () => {
        await run(okTimer)
        await run(okTimer)
        assert.equal(posts.length, 0)
    })

    it("配送失敗はログに残り、URLを漏らさず、次の受信で再送する", async () => {
        status = 500
        await run(failed("2026-10-26T01:00:00Z"))
                assert.equal(posts.length, 1)
        assert.ok(logs.some((line) => line.includes("500")))
        assert.ok(logs.every((line) => !line.includes("SECRET-TOKEN")))

        status = 204
        await run(failed("2026-10-26T01:00:00Z"))
        assert.equal(posts.length, 2)
    })

    it("Webhook未設定なら送らない", async () => {
        delete process.env.DISCORD_ALERT_WEBHOOK_URL
        await run(failed("2026-10-26T01:00:00Z"))
        assert.equal(posts.length, 0)
    })
})
