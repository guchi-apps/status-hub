import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { estimateCostUsd, findModel, listModels } from "@/lib/ai-app-usage/models"
import { applyPriceAction, OverrideError } from "@/lib/ai-app-usage/price-watch/actions"
import { readOverridesSync } from "@/lib/ai-app-usage/price-watch/overrides"
import { EMPTY_WATCH_STATE, getPriceWatchView } from "@/lib/ai-app-usage/price-watch/run"
import type { PriceCandidate } from "@/lib/ai-app-usage/price-watch/types"
import { redirectStateFile } from "@/lib/ai-usage/test-support"
import fs from "node:fs/promises"

const CANDIDATE: PriceCandidate = {
    key: "add|Anthropic|claude-sonnet-5-5|3/15/3.75/0.3",
    kind: "add",
    provider: "Anthropic",
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    before: null,
    after: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    changedFields: [],
    basis: "USD/100万トークン",
    note: null,
    sourceUrl: "https://example.com",
    checkedAt: "2026-10-10T00:00:00.000Z",
}

async function seed(t: Parameters<typeof redirectStateFile>[0], candidates: PriceCandidate[]) {
    const watch = redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
    redirectStateFile(t, "MODEL_PRICE_OVERRIDES_PATH")
    await fs.writeFile(watch, JSON.stringify({ ...EMPTY_WATCH_STATE, candidates }))
}

describe("単価表の画面操作", () => {
    it("候補を反映すると一覧・金額の計算へ載り、候補一覧から消える", async (t) => {
        await seed(t, [CANDIDATE])
        assert.equal(findModel("claude-sonnet-5-5")?.id, "claude-sonnet-5") // 反映前は前方一致で別モデルに当たる

        const view = await applyPriceAction({ action: "add-candidate", key: CANDIDATE.key })

        assert.equal(view.candidates.length, 0)
        const row = view.models.find((info) => info.id === "claude-sonnet-5-5")
        assert.equal(row?.added, true)
        assert.equal(row?.note, undefined)
        assert.equal(findModel("claude-sonnet-5-5-20260101")?.label, "Sonnet 5.5")
        const cost = estimateCostUsd("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })
        assert.equal(cost, 18)
    })

    it("価格変更の反映は、同じIDの行を置き換えて行を増やさない", async (t) => {
        await seed(t, [])
        const before = listModels().length
        const change: PriceCandidate = { ...CANDIDATE, key: "change|x", kind: "change", id: "claude-opus-5", name: "Claude Opus 5", after: { input: 6, output: 30, cacheWrite: 7.5, cacheRead: 0.6 } }
        await fs.writeFile(process.env.MODEL_PRICE_WATCH_PATH!, JSON.stringify({ ...EMPTY_WATCH_STATE, candidates: [change] }))

        await applyPriceAction({ action: "add-candidate", key: "change|x" })

        assert.equal(listModels().length, before)
        assert.equal(findModel("claude-opus-5")?.price.input, 6)
        assert.equal(findModel("claude-opus-5")?.label, "Opus 5")
    })

    it("IDが未確定・通常価格が無い・存在しない候補は反映できない", async (t) => {
        const noId = { ...CANDIDATE, key: "a", id: null }
        const noPrice = { ...CANDIDATE, key: "b", after: null }
        await seed(t, [noId, noPrice])
        for (const key of ["a", "b", "missing"]) {
            await assert.rejects(applyPriceAction({ action: "add-candidate", key }), OverrideError)
        }
        assert.deepEqual(readOverridesSync().added, [])
    })

    it("候補の非表示は同じキーのあいだだけで、価格が変わると別のキーとして再び出る", async (t) => {
        const repriced = { ...CANDIDATE, key: `${CANDIDATE.key}-new`, after: { ...CANDIDATE.after!, input: 4 } }
        await seed(t, [CANDIDATE])

        assert.equal((await applyPriceAction({ action: "hide-candidate", key: CANDIDATE.key })).candidates.length, 0)

        await fs.writeFile(process.env.MODEL_PRICE_WATCH_PATH!, JSON.stringify({ ...EMPTY_WATCH_STATE, candidates: [CANDIDATE, repriced] }))
        assert.deepEqual((await getPriceWatchView()).candidates.map((entry) => entry.key), [repriced.key])
    })

    it("モデルの非表示は印だけで、一覧・金額の計算には残り、再表示できる", async (t) => {
        await seed(t, [])
        const hidden = await applyPriceAction({ action: "hide-model", id: "gpt-6-sol" })
        assert.equal(hidden.models.find((info) => info.id === "gpt-6-sol")?.hidden, true)
        assert.notEqual(findModel("gpt-6-sol"), null)

        const shown = await applyPriceAction({ action: "show-model", id: "gpt-6-sol" })
        assert.equal(shown.models.find((info) => info.id === "gpt-6-sol")?.hidden, false)
        await assert.rejects(applyPriceAction({ action: "hide-model", id: "no-such-model" }), OverrideError)
    })
})
