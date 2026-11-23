import assert from "node:assert/strict"
import { test } from "node:test"
import { hostAnchorId, shouldJumpOnClick } from "@/lib/section-anchors"

test("ホストIDはidに使える形になる", () => {
    assert.equal(hostAnchorId("mac-mini"), "host-mac-mini")
    assert.equal(hostAnchorId("a b/c"), "host-a-b-c")
})

test("内側のリンク・ボタンを押したときは遷移しない", () => {
    const inside = { closest: () => ({}) }
    const plain = { closest: () => null }
    assert.equal(shouldJumpOnClick(inside, false), false)
    assert.equal(shouldJumpOnClick(plain, false), true)
})

test("文字を選択しているときは遷移しない", () => {
    assert.equal(shouldJumpOnClick({ closest: () => null }, true), false)
})
