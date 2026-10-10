import assert from "node:assert/strict"
import { afterEach, describe, it, mock } from "node:test"
import {
    getAideWorkReportsSnapshot,
    isAideWorkReportsConfigured,
    mergeWorkListings,
    parseWorkListing,
} from "@/lib/aide-work-reports"
import { displayWork, safeLink } from "@/lib/aide-work-reports-format"
import type { WorkReport } from "@/types/aide-work-reports"

function work(overrides: Partial<WorkReport> = {}): Record<string, unknown> {
    return {
        workId: "w1", version: 1, status: "running", title: "テスト作業", progress: null, waitReason: null,
        resultSummary: null, links: [], occurredAt: "2026-10-10T01:00:00.000Z",
        receivedAt: "2026-10-10T01:00:01.000Z", reporter: "client", freshness: "fresh", ...overrides,
    }
}

function listing(works: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
    return {
        reportState: works.length ? "reported" : "none", works, total: works.length, limit: 20, staleCount: 0,
        staleAfterMinutes: 30, retention: { days: 90, maxWorks: 200 }, checkedAt: "2026-10-10T01:05:00.000Z",
        ...overrides,
    }
}

afterEach(() => mock.restoreAll())

describe("parseWorkListing", () => {
    it("無報告の空一覧は reportState none として読める", () => {
        const parsed = parseWorkListing(listing([]))
        assert.equal(parsed?.reportState, "none")
        assert.deepEqual(parsed?.works, [])
    })

    it("1件でも形が違えば全体を捨てる（黙って少なく見せない）", () => {
        assert.equal(parseWorkListing(listing([work(), work({ workId: "w2", status: "unknown" as never })])), null)
        assert.equal(parseWorkListing(listing([work({ links: [1 as never] })])), null)
        assert.equal(parseWorkListing(listing([work({ receivedAt: "x" })])), null)
    })

    it("無報告なのに作業がある応答は取得不可にする", () => {
        assert.equal(parseWorkListing(listing([work()], { reportState: "none" })), null)
    })

    it("同じ作業IDが重なっても1件にし、版の大きいほうを残す", () => {
        const parsed = parseWorkListing(listing([work({ version: 2 }), work({ version: 5 })], { total: 2 }))
        assert.equal(parsed?.works.length, 1)
        assert.equal(parsed?.works[0]?.version, 5)
    })
})

describe("mergeWorkListings", () => {
    const newer = parseWorkListing(listing([work({ version: 3, status: "waiting" })], { checkedAt: "2026-10-10T02:00:00.000Z" }))!
    const older = parseWorkListing(listing([work({ version: 2 })], { checkedAt: "2026-10-10T01:00:00.000Z" }))!

    it("遅れて届いた古い一覧では巻き戻さない", () => {
        assert.equal(mergeWorkListings(newer, older), newer)
    })

    it("新しい一覧でも、作業の版が小さくなる行は採らない", () => {
        const next = parseWorkListing(listing([work({ version: 1 })], { checkedAt: "2026-10-10T03:00:00.000Z" }))!
        assert.equal(mergeWorkListings(newer, next).works[0]?.version, 3)
    })

    it("版が進んでいれば採り、一覧から消えた作業は消える", () => {
        const next = parseWorkListing(listing([work({ workId: "w9", version: 1 })], { checkedAt: "2026-10-10T03:00:00.000Z" }))!
        assert.deepEqual(mergeWorkListings(newer, next).works.map((w) => w.workId), ["w9"])
    })
})

describe("displayWork / safeLink", () => {
    const parsed = (overrides: Partial<WorkReport>) => parseWorkListing(listing([work(overrides)]))!.works[0]!

    it("更新途絶は報告された状態を現在として出さず、完了・失敗にもしない", () => {
        const display = displayWork(parsed({ status: "running", freshness: "stale" }))
        assert.equal(display.stale, true)
        assert.match(display.label, /更新なし/)
    })

    it("終端状態は報告どおりに出す", () => {
        assert.equal(displayWork(parsed({ status: "failed", freshness: "final" })).label, "失敗")
        assert.equal(displayWork(parsed({ status: "cancelled", freshness: "final" })).label, "取消")
    })

    it("リンクは https だけ。javascript:・http・ユーザー情報付きは出さない", () => {
        assert.equal(safeLink("https://example.com/a")?.host, "example.com")
        assert.equal(safeLink("javascript:alert(1)"), null)
        assert.equal(safeLink("http://example.com"), null)
        assert.equal(safeLink("https://user:pw@example.com"), null)
        assert.equal(safeLink("not a url"), null)
    })
})

describe("getAideWorkReportsSnapshot", () => {
    function setToken(value: string | undefined) {
        const previous = process.env.AIDE_WORK_REPORTS_TOKEN
        if (value === undefined) delete process.env.AIDE_WORK_REPORTS_TOKEN
        else process.env.AIDE_WORK_REPORTS_TOKEN = value
        return () => {
            if (previous === undefined) delete process.env.AIDE_WORK_REPORTS_TOKEN
            else process.env.AIDE_WORK_REPORTS_TOKEN = previous
        }
    }
    const stub = (handler: () => Response) =>
        mock.method(globalThis, "fetch", () => Promise.resolve(handler()))

    it("トークン未設定は unconfigured（取得しない）", async () => {
        const restore = setToken(undefined)
        try {
            assert.equal(isAideWorkReportsConfigured(), false)
            assert.equal((await getAideWorkReportsSnapshot()).status, "unconfigured")
        } finally {
            restore()
        }
    })

    it("成功→失敗の順で、失敗しても直前の一覧は残るが status は error（無報告・正常にしない）", async () => {
        const restore = setToken("t")
        try {
            let call = 0
            stub(() => (call++ === 0 ? Response.json(listing([work()])) : new Response("x", { status: 503 })))
            const ok = await getAideWorkReportsSnapshot()
            assert.equal(ok.status, "ok")
            const failed = await getAideWorkReportsSnapshot()
            assert.equal(failed.status, "error")
            assert.match(failed.message ?? "", /503/)
            assert.equal(failed.listing?.works.length, 1)
            assert.equal(failed.listingFetchedAt, ok.fetchedAt)
        } finally {
            restore()
        }
    })

    it("401 は denied", async () => {
        const restore = setToken("t")
        try {
            stub(() => new Response("x", { status: 401 }))
            assert.equal((await getAideWorkReportsSnapshot()).denied, true)
        } finally {
            restore()
        }
    })

    it("形の違う応答は取得不可", async () => {
        const restore = setToken("t")
        try {
            stub(() => Response.json({ works: "x" }))
            assert.equal((await getAideWorkReportsSnapshot()).status, "error")
        } finally {
            restore()
        }
    })
})
