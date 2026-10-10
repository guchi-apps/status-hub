import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { canonicalModelId, estimateCostUsd, findModel, listModels, modelLabel } from "@/lib/ai-app-usage/models"
import { TYPESAFE_INPUT_USD_PER_MILLION_TOKENS } from "@/lib/ai-usage/typesafe"

const NONE = { cacheReadTokens: 0, cacheWriteTokens: 0 }

describe("findModel", () => {
    it("日付付きのIDや派生名も同じモデルとして引く", () => {
        assert.equal(findModel("claude-haiku-4-5-20251001")?.id, "claude-haiku-4-5")
        assert.equal(findModel("Jev-1")?.id, "jev")
        assert.equal(canonicalModelId("claude-opus-5"), "claude-opus-5")
    })

    it("前方一致は区切りの - を挟むものだけ（別のモデル名を巻き込まない）", () => {
        assert.equal(findModel("claude-opus-50"), null)
        assert.equal(findModel("jevons"), null)
    })

    it("別モデルのIDへの前方一致にはならず、完全一致するモデルとして引ける（#362）", () => {
        // "claude-opus-5-5"（Opus 5.5）は "claude-opus-5"（Opus 5）への前方一致にも
        // 当てはまってしまう文字列だが、別モデルとして単価が異なるため巻き込んではいけない
        assert.equal(findModel("claude-opus-5-5")?.id, "claude-opus-5-5")
        assert.equal(findModel("claude-opus-5")?.id, "claude-opus-5")
    })

    it("GPT-5.6のSol・Terra・LunaとFable 5.1も一覧から引ける（#418）", () => {
        assert.equal(findModel("gpt-5.6-sol")?.id, "gpt-5.6-sol")
        assert.equal(modelLabel("gpt-5.6-terra"), "GPT-5.6 Terra")
        assert.equal(findModel("gpt-5.6-luna")?.id, "gpt-5.6-luna")
        assert.equal(findModel("claude-fable-5-1")?.id, "claude-fable-5-1")
        // 使わなくなった・これから使うモデルの行も残っている
        assert.equal(findModel("gpt-6-sol")?.id, "gpt-6-sol")
    })

    it("一覧に無いモデルは名前をそのまま出し、集計のキーも変えない", () => {
        assert.equal(findModel("gpt-9"), null)
        assert.equal(modelLabel("gpt-9"), "gpt-9")
        assert.equal(canonicalModelId("gpt-9"), "gpt-9")
    })

    it("GPT-6のSol・Lunaも一覧から引ける（#377）", () => {
        assert.equal(findModel("gpt-6-sol")?.id, "gpt-6-sol")
        assert.equal(modelLabel("gpt-6-sol"), "GPT-6 Sol")
        assert.equal(findModel("gpt-6-luna")?.id, "gpt-6-luna")
        assert.equal(modelLabel("gpt-6-luna"), "GPT-6 Luna")
    })
})

describe("estimateCostUsd", () => {
    it("入力・出力・キャッシュをそれぞれの単価で換算する", () => {
        // Opus 5: 入力 $5 / 出力 $25 / 書き込み $6.25 / 読み出し $0.5（100万トークンあたり）
        const cost = estimateCostUsd("claude-opus-5", {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cacheReadTokens: 2_000_000,
            cacheWriteTokens: 400_000,
        })
        assert.ok(cost !== null)
        assert.ok(Math.abs(cost - (5 + 2.5 + 1 + 2.5)) < 1e-9)
    })

    it("Opus 5.5は別単価（Opus 5より安い）として計算する（#362）", () => {
        // Opus 5.5: 入力 $4 / 出力 $20 / 書き込み $5 / 読み出し $0.2（100万トークンあたり）
        const cost = estimateCostUsd("claude-opus-5-5", {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cacheReadTokens: 2_000_000,
            cacheWriteTokens: 400_000,
        })
        assert.ok(cost !== null)
        assert.ok(Math.abs(cost - (4 + 2 + 0.4 + 2)) < 1e-9)
    })

    it("単価に無いモデルは推測せず null", () => {
        assert.equal(estimateCostUsd("gpt-9", { inputTokens: 10, outputTokens: 10, ...NONE }), null)
    })

    it("出力が有料のモデルで出力トークンが不明なら、入力だけの金額を出さず null", () => {
        assert.equal(estimateCostUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: null, ...NONE }), null)
    })

    it("Jevは出力が無料なので、出力トークンが不明でも入力単価だけで計算できる", () => {
        assert.equal(
            estimateCostUsd("jev", { inputTokens: 1_000_000, outputTokens: null, ...NONE }),
            TYPESAFE_INPUT_USD_PER_MILLION_TOKENS
        )
    })

    it("GPT-6 Sol・Lunaもそれぞれの単価で計算する（#377）", () => {
        // Sol: 入力 $2 / 出力 $10 / 書き込み $2.5 / 読み出し $0.2（100万トークンあたり）
        const sol = estimateCostUsd("gpt-6-sol", {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cacheReadTokens: 2_000_000,
            cacheWriteTokens: 400_000,
        })
        assert.ok(sol !== null)
        assert.ok(Math.abs(sol - (2 + 1 + 0.4 + 1)) < 1e-9)

        // Luna: 入力 $0.1 / 出力 $0.5 / 書き込み $0.125 / 読み出し $0.01（100万トークンあたり）
        const luna = estimateCostUsd("gpt-6-luna", {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cacheReadTokens: 2_000_000,
            cacheWriteTokens: 400_000,
        })
        assert.ok(luna !== null)
        assert.ok(Math.abs(luna - (0.1 + 0.05 + 0.02 + 0.05)) < 1e-9)
    })

    it("GPT-5.6系とFable 5.1はそれぞれの単価で計算する（#418）", () => {
        const tokens = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 400_000 }
        const near = (actual: number | null, expected: number) => {
            assert.ok(actual !== null)
            assert.ok(Math.abs(actual - expected) < 1e-9)
        }
        near(estimateCostUsd("gpt-5.6-sol", tokens), 4 + 2 + 0.8 + 1.6)
        near(estimateCostUsd("gpt-5.6-terra", tokens), 2 + 1.2 + 0.4 + 0.8)
        near(estimateCostUsd("gpt-5.6-luna", tokens), 0.2 + 0.12 + 0.04 + 0.08)
        near(estimateCostUsd("claude-fable-5-1", tokens), 10 + 5 + 0.5 + 5)
    })
})

describe("listModels", () => {
    it("IDが重複せず、どの行も findModel で自分自身に引き当たる", () => {
        const models = listModels()
        assert.equal(new Set(models.map((info) => info.id)).size, models.length)
        for (const info of models) assert.equal(findModel(info.id), info)
    })

    it("返した配列を書き換えても元の一覧は変わらない", () => {
        const before = listModels().length
        ;(listModels() as unknown[]).pop()
        assert.equal(listModels().length, before)
    })

    it("GPT-6系は出典未確認の注記を持ち、GPT-5.6系・Claude系は注記を持たない", () => {
        assert.equal(findModel("gpt-5.6-sol")?.note, undefined)
        assert.equal(findModel("gpt-6-sol")?.note, "出典未確認")
        assert.equal(findModel("claude-opus-5")?.note, undefined)
    })
})
