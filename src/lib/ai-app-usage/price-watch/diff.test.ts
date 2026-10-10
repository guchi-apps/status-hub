import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { dedupeAliases, diffProvider, matchRegistered } from "@/lib/ai-app-usage/price-watch/diff"
import type { ModelInfo } from "@/lib/ai-app-usage/models"
import type { OfficialPrice } from "@/lib/ai-app-usage/price-watch/types"

const AT = "2026-10-05T05:00:00.000Z"

const REGISTERED: ModelInfo[] = [
    { id: "claude-sonnet-5", label: "Sonnet 5", provider: "Anthropic", family: "sonnet", price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
    { id: "gpt-6-sol", label: "GPT-6 Sol", provider: "OpenAI", family: "gpt", note: "出典未確認", price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "OpenAI", family: "gpt", price: { input: 4, output: 20, cacheWrite: 4, cacheRead: 0.4 } },
    { id: "gpt-old", label: "GPT Old", provider: "OpenAI", family: "gpt", price: { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 } },
    { id: "jev", label: "Jev", provider: "TypeSafe", family: "jev", price: { input: 0.042, output: 0, cacheWrite: 0, cacheRead: 0 } },
]

const openai = (id: string, price: OfficialPrice["price"], condition: string | null = null): OfficialPrice => ({
    provider: "OpenAI",
    id,
    name: id,
    price,
    condition,
    retired: false,
})

const anthropic = (name: string, id: string | null, input = 2): OfficialPrice => ({
    provider: "Anthropic",
    id,
    name,
    price: { input, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    condition: null,
    retired: false,
})

describe("diffProvider（OpenAI）", () => {
    const run = (official: OfficialPrice[]) => diffProvider({ provider: "OpenAI", official, registered: REGISTERED, checkedAt: AT })

    it("公式に載っていて単価表に無い（未使用の）モデルを追加候補にする", () => {
        const [added] = run([
            openai("gpt-6.1-sol", { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 }),
            openai("gpt-6-sol", { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }),
            openai("gpt-5.6-sol", { input: 4, output: 20, cacheWrite: 4, cacheRead: 0.4 }),
            openai("gpt-old", { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 }),
        ])
        assert.equal(added.kind, "add")
        assert.equal(added.id, "gpt-6.1-sol")
        assert.equal(added.before, null)
        assert.equal(added.after?.cacheRead, 0.1)
        assert.match(added.sourceUrl, /^https:\/\/developers\.openai\.com/)
    })

    it("価格変更は変更前後と、変わった項目を持つ", () => {
        const candidates = run([
            openai("gpt-5.6-sol", { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.4 }),
            openai("gpt-6-sol", { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }),
            openai("gpt-old", { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 }),
        ])
        const change = candidates.find((entry) => entry.kind === "change")
        assert.deepEqual(change?.changedFields, ["cacheWrite"])
        assert.equal(change?.before?.cacheWrite, 4)
        assert.equal(change?.after?.cacheWrite, 5)
    })

    it("「出典未確認」の単価が公式と一致したら出典確認の候補にする。違えば価格変更", () => {
        const base = [
            openai("gpt-5.6-sol", { input: 4, output: 20, cacheWrite: 4, cacheRead: 0.4 }),
            openai("gpt-old", { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 }),
        ]
        const same = run([...base, openai("gpt-6-sol", { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 })])
        assert.deepEqual(same.map((entry) => entry.kind), ["verify"])

        const diff = run([...base, openai("gpt-6-sol", { input: 3, output: 10, cacheWrite: 2.5, cacheRead: 0.2 })])
        assert.deepEqual(diff.map((entry) => entry.kind), ["change"])
    })

    it("確認できない値は確定価格にしない: 変更なしなら候補は出ない", () => {
        const candidates = run([
            openai("gpt-6-sol", { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }),
            openai("gpt-5.6-sol", { input: 4, output: 20, cacheWrite: 4, cacheRead: 0.4 }),
            openai("gpt-old", { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 }),
        ])
        assert.deepEqual(candidates.map((entry) => entry.kind), ["verify"])
    })

    it("公式で `-`（その課金なし）の項目は、登録済みの値と比べない", () => {
        const candidates = run([
            openai("gpt-5.6-sol", { input: 4, output: 20, cacheWrite: null, cacheRead: 0.4 }),
            openai("gpt-6-sol", { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }),
            openai("gpt-old", { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 }),
        ])
        assert.equal(candidates.some((entry) => entry.kind === "change"), false)
    })

    it("条件付き価格の行は、既存モデルの価格変更にも使わず、追加では通常価格なしとして出す", () => {
        const candidates = run([
            openai("gpt-6-sol", null, "<272K context length"),
            openai("gpt-9", null, "<272K context length"),
            openai("gpt-5.6-sol", { input: 4, output: 20, cacheWrite: 4, cacheRead: 0.4 }),
            openai("gpt-old", { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 }),
        ])
        const added = candidates.find((entry) => entry.kind === "add")
        assert.equal(added?.after, null)
        assert.equal(added?.note, "<272K context length")
        assert.equal(candidates.some((entry) => entry.kind === "change" || entry.kind === "verify"), false)
    })

    it("公式から消えた登録済みモデルは掲載終了の情報にとどめ、他の提供元は巻き込まない", () => {
        const candidates = run([openai("gpt-6-sol", { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 })])
        const delisted = candidates.filter((entry) => entry.kind === "delisted").map((entry) => entry.id)
        assert.deepEqual(delisted.sort(), ["gpt-5.6-sol", "gpt-old"])
    })

    it("日付付きIDは本体のIDへ寄せ、重複した候補にしない", () => {
        const official = [
            openai("gpt-6.2", { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 }),
            openai("gpt-6.2-2026-10-01", { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 }),
        ]
        assert.equal(dedupeAliases(official).length, 1)
        assert.equal(matchRegistered(openai("gpt-6-sol-2026-10-01", null), REGISTERED)?.id, "gpt-6-sol")
    })

    it("価格が再び変わると、別の差分（別のキー）になる", () => {
        const make = (cacheWrite: number) =>
            run([
                openai("gpt-5.6-sol", { input: 4, output: 20, cacheWrite, cacheRead: 0.4 }),
                openai("gpt-6-sol", { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }),
                openai("gpt-old", { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 }),
            ]).find((entry) => entry.kind === "change")
        assert.equal(make(5)?.key, make(5)?.key)
        assert.notEqual(make(5)?.key, make(6)?.key)
    })
})

describe("diffProvider（Anthropic）", () => {
    it("Sonnet 5.5 を Sonnet 5 への前方一致で「登録済み」と見なさない", () => {
        const candidates = diffProvider({
            provider: "Anthropic",
            official: [anthropic("Claude Sonnet 5.5", "claude-sonnet-5-5"), anthropic("Claude Sonnet 5", null)],
            registered: REGISTERED,
            checkedAt: AT,
        })
        assert.deepEqual(candidates.map((entry) => [entry.kind, entry.id]), [["add", "claude-sonnet-5-5"]])
    })

    it("IDを確かめられない新モデルは「ID未確定」の候補にする（IDを推測しない）", () => {
        const [added] = diffProvider({
            provider: "Anthropic",
            official: [anthropic("Claude Sonnet 5", null), anthropic("Claude Opus 4.8", null)],
            registered: REGISTERED,
            checkedAt: AT,
        })
        assert.equal(added.id, null)
        assert.match(added.note ?? "", /ID未確定/)
    })

    it("提供終了のモデルは追加候補にしない", () => {
        const retired = { ...anthropic("Claude Opus 4", null), retired: true }
        const candidates = diffProvider({ provider: "Anthropic", official: [anthropic("Claude Sonnet 5", null), retired], registered: REGISTERED, checkedAt: AT })
        assert.deepEqual(candidates, [])
    })
})
