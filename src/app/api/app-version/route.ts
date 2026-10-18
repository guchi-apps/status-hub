import packageJson from "../../../../package.json" with { type: "json" }

// CDN/ブラウザにキャッシュされると稼働中の版を取り違えるため常に無効化する。
export const dynamic = "force-dynamic"

/**
 * 稼働しているコミットの SHA（#607。guchi-apps/car-care#257 と同じ形）。`deploy.yml` が `.env` へ書く
 * `APP_COMMIT_SHA` を返す。デプロイのヘルスチェックはこれが今回のコミットと一致するまで成功にしない
 * （旧版が HTTP 200 を返しているだけの状態を成功と見なさないため）。ローカル開発など未設定なら null。
 *
 * 未ログインで 127.0.0.1 から叩かれるため `src/lib/public-paths.ts` で proxy の認証対象から外している。
 * 返すのは版とSHAだけ（どちらも公開情報）にし、ここへ他の値を足さないこと。
 */
export async function GET() {
    // 素の Response.json にしているのは node --test から next/server を読まずに確かめるため。
    return Response.json(
        { version: packageJson.version, sha: process.env.APP_COMMIT_SHA || null },
        { headers: { "Cache-Control": "no-store" } },
    )
}
