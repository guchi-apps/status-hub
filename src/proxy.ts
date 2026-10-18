import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

import { isPublicPath } from "@/lib/public-paths";

// 未ログインで素通りさせるパスの一覧と理由は src/lib/public-paths.ts に置く（#607 で回帰テストのため切り出した）。

/**
 * リクエストごとに Supabase のアクセストークンをリフレッシュし、更新後のCookieを
 * レスポンスに書き戻す。Server Component は Cookie を書き込めないため、この処理が
 * ないとアクセストークン（デフォルト有効期限1時間）失効後にリフレッシュトークンが
 * 有効でもセッションが切れて見えてしまう。
 *
 * ここでの認証チェックは楽観的なもの（Next.js公式ドキュメントの "optimistic checks"）
 * であり、許可リスト判定などの本格的な検証は各ページ/APIルートから呼ばれる
 * src/lib/session.ts 側で行う。
 */
export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // createServerClient と getClaims() の間に他のロジックを挟まない
  // （トークンリフレッシュが getClaims() 呼び出しの副作用として行われるため）。
  const { data } = await supabase.auth.getClaims();

  const { pathname } = request.nextUrl;
  if (!data && !isPublicPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
    }
    // request.url はリバースプロキシ配下だと内部アドレス（localhost:PORT）を
    // 指すことがあるため、Host + X-Forwarded-Proto から組み立てる。
    const host = request.headers.get("host");
    const protocol = request.headers.get("x-forwarded-proto") ?? "http";
    return NextResponse.redirect(`${protocol}://${host}/login`);
  }

  return supabaseResponse;
}

// matcher から外したパスでは proxy 自体が動かない（＝未ログインでも素通りする）。
// `public/` 配下のアイコンとWebアプリマニフェストは、ログイン画面のタブアイコン表示に必要で、
// 中身は画像とマニフェストだけで秘密情報を含まないため除外する（#165）。
// これらは静的配信なのでセッションのリフレッシュも不要で、除外すればアイコン取得のたびに
// Supabaseへ問い合わせる無駄も無くなる。
// `sw.js`（通知用のService Worker。#263）も外す。スクリプトの取得がリダイレクトされると、
// ブラウザが登録を失敗させるため。中身は通知を出すだけの静的ファイル。
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sw.js).*)"],
};
