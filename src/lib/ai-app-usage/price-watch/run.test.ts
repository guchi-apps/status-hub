import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { estimateCostUsd, listModels } from "@/lib/ai-app-usage/models"
import { DEFAULT_SCHEDULE } from "@/lib/ai-app-usage/price-watch/schedule"
import {
    EMPTY_WATCH_STATE,
    isDue,
    isManualRunThrottled,
    MANUAL_MIN_INTERVAL_MS,
    readWatchState,
    runModelPriceWatch,
    summarizeOutcome,
    type FetchText,
} from "@/lib/ai-app-usage/price-watch/run"
import { ANTHROPIC_MODELS_URL, ANTHROPIC_PRICING_URL, OPENAI_PRICING_URL } from "@/lib/ai-app-usage/price-watch/sources"
import { redirectStateFile } from "@/lib/ai-usage/test-support"
import type { PushMessage } from "@/lib/push/web-push"

const ROW = (m: ReturnType<typeof listModels>[number]) =>
    `| ${m.id} | $${m.price.input} | $${m.price.cacheRead} | $${m.price.cacheWrite} | $${m.price.output} | - | - | - | - |`

/** 登録済みのOpenAIモデルと同じ単価を載せた、公式の料金ページ（`extra` で行を足す） */
function openaiPage(extra: string[] = [], override: Record<string, string> = {}, omit: string[] = []): string {
    const rows = listModels()
        .filter((m) => m.provider === "OpenAI" && !omit.includes(m.id))
        .map((m) => override[m.id] ?? ROW(m))
    return [
        "### Standard pricing data",
        "",
        "| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...rows,
        ...extra,
        "",
    ].join("\n")
}

function anthropicPage(): string {
    const rows = listModels()
        .filter((m) => m.provider === "Anthropic")
        .map((m) => `| Claude ${m.label} | $${m.price.input} / MTok | $${m.price.cacheWrite} / MTok | $0 / MTok | $${m.price.cacheRead} / MTok | $${m.price.output} / MTok |`)
    return [
        "## Model pricing",
        "",
        "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
        "| :--- | :--- | :--- | :--- | :--- | :--- |",
        ...rows,
        "",
    ].join("\n")
}

const MODELS_PAGE = "| | A |\n| :--- | :--- |\n| Model page | [Claude Opus 5.5](https://example.com) |\n| Claude API ID | `claude-opus-5-5` |\n"

const NEW_MODEL = "| gpt-7-sol | $3.00 | $0.30 | $3.75 | $15.00 | - | - | - | - |"

function makeFetch(pages: { openai?: string | Error; anthropic?: string | Error }): FetchText {
    return async (url) => {
        const page = url === OPENAI_PRICING_URL ? pages.openai : url === ANTHROPIC_PRICING_URL ? pages.anthropic : MODELS_PAGE
        if (page === undefined) throw new Error(`想定外のURL: ${url} ${ANTHROPIC_MODELS_URL}`)
        if (page instanceof Error) throw page
        return page
    }
}

function collectNotify(delivered = true) {
    const sent: PushMessage[] = []
    return { sent, notify: async (message: PushMessage) => (sent.push(message), delivered) }
}

const NOW = Date.UTC(2026, 9, 4, 20, 0) // 2026-10-05(月) 05:00 JST
const SLOT = NOW

describe("runModelPriceWatch", () => {
    it("公式に新モデルがあれば、未使用でも出典付きの更新候補にして通知する", async (t) => {
        redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
        const { sent, notify } = collectNotify()
        const state = await runModelPriceWatch({
            now: NOW,
            slotAt: SLOT,
            notify,
            fetchText: makeFetch({ openai: openaiPage([NEW_MODEL]), anthropic: anthropicPage() }),
        })

        assert.equal(state.lastRun?.outcome, "candidates")
        const added = state.candidates.find((entry) => entry.id === "gpt-7-sol")
        assert.equal(added?.kind, "add")
        assert.match(added?.sourceUrl ?? "", /^https:\/\//)
        assert.ok(added?.checkedAt)
        assert.equal(sent.length, 1)
        assert.match(sent[0].body, /追加 1件/)
    })

    it("同じ差分は再通知せず、価格がさらに変わると新しい差分として通知する", async (t) => {
        redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
        const { sent, notify } = collectNotify()
        const anthropic = anthropicPage()
        const run = (extra: string) =>
            runModelPriceWatch({ now: NOW, slotAt: SLOT, notify, fetchText: makeFetch({ openai: openaiPage([extra]), anthropic }) })

        await run(NEW_MODEL)
        await run(NEW_MODEL)
        assert.equal(sent.length, 1)

        await run(NEW_MODEL.replace("$3.00", "$4.00"))
        assert.equal(sent.length, 2)
    })

    it("届かなかった通知は記録せず、次の実行で送り直す", async (t) => {
        redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
        const lost = collectNotify(false)
        const fetchText = makeFetch({ openai: openaiPage([NEW_MODEL]), anthropic: anthropicPage() })
        await runModelPriceWatch({ now: NOW, slotAt: SLOT, notify: lost.notify, fetchText })
        const retry = collectNotify(true)
        await runModelPriceWatch({ now: NOW, slotAt: SLOT, notify: retry.notify, fetchText })
        assert.equal(retry.sent.length, 1)
    })

    it("変更なしは候補なしで、実行履歴に残る", async (t) => {
        redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
        const { sent, notify } = collectNotify()
        const state = await runModelPriceWatch({
            now: NOW,
            slotAt: SLOT,
            notify,
            // gpt-6-* は「出典未確認」のため、公式と一致すると出典確認の候補が出る。ここでは別の行だけを見る
            fetchText: makeFetch({ openai: openaiPage(), anthropic: anthropicPage() }),
        })
        assert.equal(state.history.length, 1)
        assert.ok(state.lastSuccessAt)
        assert.deepEqual(
            state.candidates.map((entry) => entry.kind).filter((kind) => kind !== "verify"),
            []
        )
        assert.ok(sent.length <= 1)
    })

    it("全体の失敗は「変更なし」にせず、前回の候補を保持し、同じ失敗は1回だけ通知する", async (t) => {
        redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
        const { sent, notify } = collectNotify()
        await runModelPriceWatch({ now: NOW, slotAt: SLOT, notify, fetchText: makeFetch({ openai: openaiPage([NEW_MODEL]), anthropic: anthropicPage() }) })
        const before = sent.length

        const failing = makeFetch({ openai: new Error("x"), anthropic: new Error("x") })
        const first = await runModelPriceWatch({ now: NOW, slotAt: SLOT, notify, fetchText: failing })
        const second = await runModelPriceWatch({ now: NOW, slotAt: SLOT, notify, fetchText: failing })

        assert.equal(first.lastRun?.outcome, "failed")
        assert.ok(first.candidates.some((entry) => entry.id === "gpt-7-sol"), "前回の候補を持ち越す")
        assert.equal(second.lastSuccessAt, first.lastSuccessAt, "失敗は最終成功にならない")
        assert.equal(sent.length - before, 1, "同じ失敗は1回だけ通知")
        assert.match(sent.at(-1)?.title ?? "", /失敗/)
    })

    it("一部の提供元だけの失敗は「一部失敗」で、成功した側の差分は反映する", async (t) => {
        redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
        const { notify } = collectNotify()
        const state = await runModelPriceWatch({
            now: NOW,
            slotAt: SLOT,
            notify,
            fetchText: makeFetch({ openai: openaiPage([NEW_MODEL]), anthropic: new Error("x") }),
        })
        assert.equal(state.lastRun?.outcome, "partial")
        assert.ok(state.candidates.some((entry) => entry.id === "gpt-7-sol"))
        const anthropic = state.lastRun?.providers.find((entry) => entry.provider === "Anthropic")
        assert.equal(anthropic?.status, "failed")
    })

    it("表の形が想定と違う応答は、失敗として記録する（変更なしと混同しない）", async (t) => {
        redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
        const { notify } = collectNotify()
        const state = await runModelPriceWatch({
            now: NOW,
            slotAt: SLOT,
            notify,
            fetchText: makeFetch({ openai: "<html>blocked</html>", anthropic: anthropicPage() }),
        })
        assert.equal(state.lastRun?.outcome, "partial")
        assert.match(state.lastRun?.providers.find((entry) => entry.provider === "OpenAI")?.reason ?? "", /形式/)
    })

    it("TypeSafeは失敗ではなく「対象外」として理由を残す", async (t) => {
        redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
        const { notify } = collectNotify()
        const state = await runModelPriceWatch({ now: NOW, slotAt: SLOT, notify, fetchText: makeFetch({ openai: openaiPage(), anthropic: anthropicPage() }) })
        const typesafe = state.lastRun?.providers.find((entry) => entry.provider === "TypeSafe")
        assert.equal(typesafe?.status, "unavailable")
        assert.ok(typesafe?.reason)
    })

    it("公式から消えた旧モデルも単価表には残り、過去の金額を換算できる。反映すれば概算は新単価になる", async (t) => {
        redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
        const { notify } = collectNotify()
        const count = listModels().length
        const sol = listModels().find((m) => m.id === "gpt-5.6-sol")!
        const page = openaiPage([], {}, ["gpt-5.6-sol"])
        const state = await runModelPriceWatch({ now: NOW, slotAt: SLOT, notify, fetchText: makeFetch({ openai: page, anthropic: anthropicPage() }) })

        assert.ok(state.candidates.some((entry) => entry.kind === "delisted" && entry.id === "gpt-5.6-sol"))
        assert.equal(listModels().length, count, "チェックは単価表を書き換えない")
        const tokens = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
        assert.equal(estimateCostUsd("gpt-5.6-sol", tokens), sol.price.input)
        // 反映した場合の影響: 同じトークン数でも、単価が変われば過去の期間の概算も変わる（確定した請求額ではない）
        assert.notEqual(estimateCostUsd("gpt-5.6-sol", tokens), (tokens.inputTokens * (sol.price.input + 1)) / 1_000_000)
    })
})

describe("isDue / summarizeOutcome", () => {
    it("一度も実行していなければ実行する。同じ予定時刻のうちは再実行しない", () => {
        assert.equal(isDue(EMPTY_WATCH_STATE, NOW, DEFAULT_SCHEDULE), true)
        const done = { ...EMPTY_WATCH_STATE, slot: { at: SLOT, attempts: 1 }, lastRun: { startedAt: "", finishedAt: new Date(NOW).toISOString(), outcome: "unchanged" as const, providers: [], candidateCount: 0 } }
        assert.equal(isDue(done, NOW + 60_000, DEFAULT_SCHEDULE), false)
        assert.equal(isDue(done, NOW + 7 * 86_400_000, DEFAULT_SCHEDULE), true)
    })

    it("失敗した回は、間隔をあけて回数の上限までやり直す", () => {
        const failed = (attempts: number) => ({
            ...EMPTY_WATCH_STATE,
            slot: { at: SLOT, attempts },
            lastRun: { startedAt: "", finishedAt: new Date(NOW).toISOString(), outcome: "failed" as const, providers: [], candidateCount: 0 },
        })
        assert.equal(isDue(failed(1), NOW + 60 * 60_000, DEFAULT_SCHEDULE), false)
        assert.equal(isDue(failed(1), NOW + 7 * 60 * 60_000, DEFAULT_SCHEDULE), true)
        assert.equal(isDue(failed(3), NOW + 7 * 60 * 60_000, DEFAULT_SCHEDULE), false)
    })

    it("結果は変更なし・更新候補あり・一部失敗・失敗を区別する", () => {
        const ok = { provider: "A", status: "ok" as const, reason: null, sourceUrls: [], modelCount: 1, warnings: [] }
        const ng = { ...ok, status: "failed" as const, reason: "HTTP 500" }
        assert.equal(summarizeOutcome([ok], 0), "unchanged")
        assert.equal(summarizeOutcome([ok], 2), "candidates")
        assert.equal(summarizeOutcome([ok, ng], 2), "partial")
        assert.equal(summarizeOutcome([ng, ng], 0), "failed")
    })

    it("状態ファイルが無ければ空の状態を返す", async (t) => {
        redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
        assert.deepEqual(await readWatchState(), EMPTY_WATCH_STATE)
    })
})

describe("手動更新（#561）", () => {
    const okFetch = () => makeFetch({ openai: openaiPage([NEW_MODEL]), anthropic: anthropicPage() })

    it("slot（予定時刻と試行回数）を進めず、結果と候補だけを更新する", async (t) => {
        redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
        const { notify } = collectNotify()
        const failing = makeFetch({ openai: new Error("x"), anthropic: new Error("x") })
        const scheduled = await runModelPriceWatch({ now: NOW, slotAt: SLOT, notify, fetchText: failing })
        assert.deepEqual(scheduled.slot, { at: SLOT, attempts: 1 })

        const manual = await runModelPriceWatch({ now: NOW + 3_600_000, manual: true, notify, fetchText: okFetch() })
        assert.deepEqual(manual.slot, { at: SLOT, attempts: 1 }, "手動は試行回数を数えない")
        assert.equal(manual.lastRun?.outcome, "candidates")
        assert.ok(manual.candidates.some((entry) => entry.id === "gpt-7-sol"))
    })

    it("定期の実行が一度も無くても、手動で slot を作らない（その週の定期実行は予定どおり走る）", async (t) => {
        redirectStateFile(t, "MODEL_PRICE_WATCH_PATH")
        const { notify } = collectNotify()
        const state = await runModelPriceWatch({ now: NOW, manual: true, notify, fetchText: okFetch() })
        assert.equal(state.slot, null)
        assert.equal(isDue(state, NOW, DEFAULT_SCHEDULE), true)
    })

    it("直近の実行（成功・失敗とも）から60秒以内は連打として止める", () => {
        const at = new Date(NOW).toISOString()
        const withRun = (outcome: "unchanged" | "failed") => ({
            ...EMPTY_WATCH_STATE,
            lastRun: { startedAt: at, finishedAt: at, outcome, providers: [], candidateCount: 0 },
        })
        assert.equal(isManualRunThrottled(EMPTY_WATCH_STATE, NOW), false)
        assert.equal(isManualRunThrottled(withRun("unchanged"), NOW + MANUAL_MIN_INTERVAL_MS - 1), true)
        assert.equal(isManualRunThrottled(withRun("failed"), NOW + 1_000), true)
        assert.equal(isManualRunThrottled(withRun("unchanged"), NOW + MANUAL_MIN_INTERVAL_MS), false)
    })
})
