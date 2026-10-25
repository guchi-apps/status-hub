import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { toPiAiQuota, type HeldWindows } from "@/lib/pi-ai-quota"
import {
    FIVE_HOUR_SECONDS,
    HOUR,
    WEEK_SECONDS,
    makeProvider,
    makeSnapshot,
    makeWindow,
} from "@/lib/ai-usage/test-support"

const NOW = Date.UTC(2026, 9, 25, 7, 0, 0)
const RESET_5H = new Date(NOW + 3 * HOUR).toISOString()
const RESET_7D = new Date(NOW + 30 * HOUR).toISOString()

function claudeWindows() {
    return [
        makeWindow({ label: "5時間", usedPercent: 25, resetsAt: RESET_5H, windowSeconds: FIVE_HOUR_SECONDS }),
        makeWindow({ usedPercent: 43, resetsAt: RESET_7D, windowSeconds: WEEK_SECONDS }),
        makeWindow({ usedPercent: 90, resetsAt: RESET_7D, windowSeconds: WEEK_SECONDS, note: "Opus" }),
    ]
}

function chatGptWindows() {
    return [makeWindow({ usedPercent: 3.4, resetsAt: RESET_7D, windowSeconds: WEEK_SECONDS })]
}

function quotaOf(result: ReturnType<typeof toPiAiQuota>, id: string) {
    const quota = result.quotas.find((entry) => entry.id === id)
    assert.ok(quota, `${id} が quotas に無い`)
    return quota
}

describe("toPiAiQuota", () => {
    it("残り割合と時刻だけを3枠で返し、note付きの枠は拾わない", () => {
        const store: HeldWindows = new Map()
        const result = toPiAiQuota(
            makeSnapshot([makeProvider("claude", claudeWindows()), makeProvider("chatgpt", chatGptWindows())], NOW),
            store
        )

        assert.deepEqual(
            result.quotas.map((quota) => quota.id),
            ["claude_5h", "claude_7d", "codex_7d"]
        )
        assert.equal(quotaOf(result, "claude_5h").remaining_percent, 75)
        assert.equal(quotaOf(result, "claude_5h").resets_at, RESET_5H)
        assert.equal(quotaOf(result, "claude_7d").remaining_percent, 57)
        assert.equal(quotaOf(result, "codex_7d").remaining_percent, 97)
        assert.equal(result.stale, false)
        assert.equal(result.fetched_at, new Date(NOW).toISOString())
    })

    it("金額・クレジット・プラン名などは応答に含めない", () => {
        const provider = makeProvider("claude", claudeWindows(), { plan: "Max" })
        const result = toPiAiQuota(makeSnapshot([provider], NOW), new Map())
        const text = JSON.stringify(result)
        assert.ok(!text.includes("Max"))
        assert.deepEqual(Object.keys(result).sort(), ["fetched_at", "quotas", "stale"])
        assert.deepEqual(Object.keys(result.quotas[0]).sort(), ["id", "label", "remaining_percent", "resets_at"])
    })

    it("使用率が範囲外でも残り割合は0〜100に収める", () => {
        const over = makeWindow({ usedPercent: 120, resetsAt: RESET_5H, windowSeconds: FIVE_HOUR_SECONDS })
        const result = toPiAiQuota(makeSnapshot([makeProvider("claude", [over])], NOW), new Map())
        assert.equal(quotaOf(result, "claude_5h").remaining_percent, 0)
    })

    it("提供元が無い・枠が無いときは外さず null にする（保持値も無い場合は stale にしない）", () => {
        const result = toPiAiQuota(makeSnapshot([makeProvider("claude", claudeWindows())], NOW), new Map())
        assert.deepEqual(quotaOf(result, "codex_7d"), {
            id: "codex_7d",
            label: "Codex 7d",
            remaining_percent: null,
            resets_at: null,
        })
        assert.equal(result.stale, false)
    })

    it("Claudeだけ失敗してChatGPTは成功: Claudeは保持値で埋めて stale、ChatGPTは新しい値", () => {
        const store: HeldWindows = new Map()
        toPiAiQuota(
            makeSnapshot([makeProvider("claude", claudeWindows()), makeProvider("chatgpt", chatGptWindows())], NOW),
            store
        )

        const failed = makeProvider("claude", [], { status: "error", message: "HTTP 429" })
        const newer = [makeWindow({ usedPercent: 10, resetsAt: RESET_7D, windowSeconds: WEEK_SECONDS })]
        const result = toPiAiQuota(makeSnapshot([failed, makeProvider("chatgpt", newer)], NOW + HOUR), store)

        assert.equal(quotaOf(result, "claude_5h").remaining_percent, 75)
        assert.equal(quotaOf(result, "claude_7d").remaining_percent, 57)
        assert.equal(quotaOf(result, "codex_7d").remaining_percent, 90)
        assert.equal(result.stale, true)
    })

    it("失敗して保持値も無い枠は null のままで、取れている枠だけで stale にはならない", () => {
        const failed = makeProvider("claude", [], { status: "error", message: "HTTP 500" })
        const result = toPiAiQuota(makeSnapshot([failed, makeProvider("chatgpt", chatGptWindows())], NOW), new Map())
        assert.equal(quotaOf(result, "claude_5h").remaining_percent, null)
        assert.equal(quotaOf(result, "codex_7d").remaining_percent, 97)
        assert.equal(result.stale, false)
    })
})
