import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isPublicPath } from "@/lib/public-paths"

describe("isPublicPath", () => {
    it("デプロイのヘルスチェックが叩く /api/app-version は未ログインで通す（#607）", () => {
        assert.equal(isPublicPath("/api/app-version"), true)
    })

    it("既存の公開パスは引き続き通す", () => {
        assert.equal(isPublicPath("/login"), true)
        assert.equal(isPublicPath("/api/access/v1/decision"), true)
    })

    it("画面・管理用APIはログインを求める", () => {
        assert.equal(isPublicPath("/"), false)
        assert.equal(isPublicPath("/admin"), false)
        assert.equal(isPublicPath("/api/access/admin/apps"), false)
        assert.equal(isPublicPath("/api/aide-status"), false)
    })
})
