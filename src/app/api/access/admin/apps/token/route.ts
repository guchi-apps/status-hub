import { NextResponse } from "next/server"

import { getAccessDb } from "@/lib/access/db"
import { handleAdminWrite } from "@/lib/access/admin-route"
import { accessAppTokenName, sharedTokenWriteConfigurationError, writeSharedToken } from "@/lib/shared-token"
import { AccessError, issueAppToken, recordSharedTokenWrite, revokeAppToken } from "@/lib/access/policy"

/**
 * アプリ別トークンの発行・再発行（POST）と失効（DELETE）。管理者のセッションのみ。
 *
 * 平文のトークンはこのレスポンスでしか返さない（DBにはハッシュだけを残す）。
 * 発行時に平文をissue-deckの共有トークン（`<アプリID大文字>_ACCESS_APP_TOKEN`）へ書き込む（#504）。
 * 共有トークンの削除APIは無いため、失効しても共有トークン側の値は残る（失効済みで判定には通らない）。
 * `POST { id }` / `DELETE ?id=<appId>`
 */
export async function POST(request: Request) {
    return handleAdminWrite(request, async (actor, body) => {
        if (typeof body.id !== "string") throw new AccessError("invalid", "id を指定してください")
        // 再発行は旧トークンを即失効させるため、設定不備はDB更新の前に拒否する。
        const configurationError = sharedTokenWriteConfigurationError(accessAppTokenName(body.id))
        if (configurationError) throw new AccessError("invalid", configurationError)
        const db = getAccessDb()
        const token = issueAppToken(db, actor, body.id, new Date())
        // 書き込みに失敗しても発行は成功のまま返す。平文は画面に1回だけ出し、手で登録してもらう
        const written = await writeSharedToken(
            accessAppTokenName(body.id),
            token,
            `${body.id}がStatusHubの判定APIを呼ぶトークン（StatusHubが発行時に自動登録）`
        )
        if (written.ok) recordSharedTokenWrite(db, actor, body.id, written.name, new Date())
        return {
            token,
            sharedToken: written.ok
                ? { name: written.name, written: true }
                : { name: written.name, written: false, reason: written.reason },
        }
    }).then((response) => {
        // トークンを含むレスポンスはキャッシュさせない
        response.headers.set("Cache-Control", "no-store")
        return response
    })
}

export async function DELETE(request: Request) {
    const id = new URL(request.url).searchParams.get("id")
    if (!id) return NextResponse.json({ error: "id を指定してください" }, { status: 400 })
    return handleAdminWrite(request, (actor) => {
        revokeAppToken(getAccessDb(), actor, id, new Date())
        return {}
    })
}
