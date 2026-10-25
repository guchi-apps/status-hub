// /auth 配下（callback・signout）は未ログイン状態で叩かれても安全なため素通りさせる。
// /api/claude-usage はScriptableのウィジェットから叩く中継APIで、ログイン画面を通れないため
// ここでは素通りさせ、ルート側で WIDGET_TOKEN による認証を行う。
// /api/host-stats はサブPCのエージェントがメトリクスをPOSTする受け口で、同じくログイン画面を
// 通れないため素通りさせ、ルート側で HOST_STATS_TOKEN による認証を行う。
// /api/access/v1 は各アプリのサーバーが共通アクセス設定を引く契約API（#489）。ログイン画面を
// 通れないため素通りさせ、ルート側でアプリ別トークンを照合する。管理用の /api/access/admin は
// 含めず、ここを通ったうえで管理者のセッションを求める。
// /api/pi-ai-quota はラズパイのroom-panelが残り割合を読む専用API（#618）。ログイン画面を通れないため
// 素通りさせ、ルート側で PI_PANEL_TOKEN だけを照合する（セッション・OPS_API_TOKENでは通さない）。
// /api/app-version は deploy.yml のヘルスチェックが 127.0.0.1 から未ログインで叩き、稼働中の
// コミットSHAを照合する（#607）。返すのは版とSHAだけで、どちらも公開情報。
// 残りの読み取りAPIは、同一VPS上のAIDE（MCPサーバー）から参照するために素通りさせ、ルート側の
// requireSessionOrApiToken() でログインセッションまたは OPS_API_TOKEN による認証を行う。
//
// **ここに載せたパスの保護はルート側だけが担う。** 以下のディレクトリへルート（特にGET以外の
// メソッド）を足すときは、必ずルート側で認証すること。付け忘れるとそのまま無認証で公開される。
export const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/auth",
  "/api/claude-usage",
  "/api/host-stats",
  "/api/access/v1",
  "/api/app-version",
  "/api/monitors",
  "/api/uptime-kuma",
  "/api/ai-usage",
  "/api/ai-app-usage",
  "/api/pi-ai-quota",
  "/api/github-usage",
  "/api/onepassword-usage",
];

/** 未ログインでも proxy がログイン画面へ飛ばさずに通すパスか。 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
