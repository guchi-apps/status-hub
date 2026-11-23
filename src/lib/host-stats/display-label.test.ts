import assert from "node:assert/strict"
import test from "node:test"
import { resolveHostLabel } from "@/lib/host-stats/display-label"

test("subpc は送信された表示名によらず DeskMini になる", () => {
    assert.equal(resolveHostLabel("subpc", "サブPC", "subpc"), "DeskMini")
    assert.equal(resolveHostLabel("subpc", undefined, "subpc"), "DeskMini")
})

test("上書きの無いホストは送信された表示名、無ければホスト名を使う", () => {
    assert.equal(resolveHostLabel("vps", "VPS", "x162"), "VPS")
    assert.equal(resolveHostLabel("pi0w", "", "pi0w"), "pi0w")
})
