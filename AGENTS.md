<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# status-hub（旧 ops-dashboard）— エージェント向けガイド

自宅VPS・サブPC・AI利用枠などの状態を1画面で見るための個人向けダッシュボード。技術スタックと
セットアップ手順は [README.md](./README.md) を参照する。ここにはエージェント（Claude Code）が守る
運用ルールと、READMEに書かれていない判断基準だけを書く。

**GitHubのリポジトリ名だけを `status-hub` に改めた（#457）。** PM2のプロセス名・systemdユニット名・
1Passwordの `apps/ops-dashboard` アイテム・`TARGET_DIR`・`NOTIFY_APP` などの識別子は本番が参照しているため
`ops-dashboard` のまま据え置いている。**これらを黙って改名しないこと**（改名するなら手作業を伴う別Issueにする）。

**GitHub Actions 上での無人実行は、このリポジトリをチェックアウトしたワークツリーしか参照できない。**
ローカル実行ではユーザー個人環境のグローバルルール（`~/.claude/CLAUDE.md`）も読み込まれるが、
無人実行では読み込まれない。したがって無人実行でも守られる必要があるルールは、このファイルに
明文化しておく必要がある。

## 検証コマンド

**このリポジトリには `typecheck` の npm script が無い。** CI（`.github/workflows/ci.yml`）は
下記の4つを実行している。**存在しないコマンドを探さず、下記を使うこと。**

| 目的 | コマンド |
|---|---|
| Lint | `npm run lint` |
| 型チェック | `npx tsc --noEmit` |
| テスト | `npm test` |
| ビルド | `npm run build` |

`npm run build` はラッパーを通さないため無人実行から使える。DBは使わない（`prisma/` を持たない）ので、
マイグレーションやシードの手順は無い。

### 自動テスト（`npm test`）

Node標準の `node:test` で `src/**/*.test.ts` を実行する（#279）。**テストランナーやモックの
パッケージは足さない。** 枠の同定（リセット時刻のずれの許容）・使用額の減少をリセットとみなす判定・
期限切れ購入の除外・日の区切りの6時間ルールなど、境界の判定が集中している `src/lib/ai-usage/` の
処理を対象にしている。「作り物の値を流して確かめる」ことになる変更は、手で確かめる代わりに
ここへテストを足す。

- **TypeScriptはNodeの型除去でそのまま読む。** 列挙型（`enum`）・パラメータプロパティなど、
  型を消すだけでは動かない構文はテスト対象のコードに書けない
- **`@/` の解決は `scripts/test-alias-loader.mjs`**（`--import` で `scripts/test-register.mjs` が登録）。
  tsconfig の `paths` と同じ `@/*` → `src/*` の対応を、`.ts`・`/index.ts` を探す形で再現している。
  **`paths` を変えたらここも合わせる**
- **記録ファイルはテストごとの一時ディレクトリへ向ける**（`test-support.ts` の `redirectStateFile`。
  `AI_USAGE_HISTORY_PATH` などの環境変数を差し替える）。本番の `.data/` を触らない。時刻は関数の引数
  （`now`）か、スナップショットの `fetchedAt` で渡す。`Date.now()` を直接読む処理は、そのぶん
  テストしづらいので、テストを書くなら引数で渡せる形にする
- 追加した `*.test.ts` は `tsc --noEmit` と ESLint の対象にもなる。**`use` で始まる関数は
  React Hookとして扱われて lint が落ちる**ため、テスト用の補助関数の名前に `use` を付けない

### 開発サーバーでの画面確認

**`/login` 配下以外の全ページはログイン必須**（`src/proxy.ts` の `PUBLIC_PATH_PREFIXES`）で、
Supabaseのセッションが無いと `/login` へリダイレクトされる。`.env.local` が無いworktree
（GUIが無くOAuthを完了できない環境を含む）では、素の `curl` で画面を確認できない。

**`public/` 配下の静的ファイルも proxy を通る。** Next.js が自動で除外するのは
`_next/static` ・ `_next/image` などだけで、`public/` に置いたファイルは `config.matcher` の
除外か `PUBLIC_PATH_PREFIXES` に載せない限り、未ログインだと `/login` へ307で飛ばされる
（ログイン画面のファビコンが出なくなる。#165）。ログイン画面から参照される静的ファイルを
足すときは `src/proxy.ts` の `config.matcher` の除外に追記する。

ログイン不要な描画だけを確かめたい場合は、`PUBLIC_PATH_PREFIXES` に載っている `/login` 配下へ
**一時的な確認用ルート**（例: `src/app/login/preview-xxx/page.tsx`）を置き、ダミーのSupabase
環境変数を与えて `npm run dev` を起動すれば `curl` で描画結果を取得できる。

`.env.local` が無いworktreeでは、ポートとSupabaseの変数をコマンドに直接渡す。**`src/proxy.ts` が
読むキーは `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`** で、`..._ANON_KEY` を渡しても全リクエストが
500になる（値の中身は検証されないのでダミーでよい）。

```bash
PORT=17096 NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=dummy npm run dev
```

レスポンシブの確認は `curl` では見た目まで分からないため、取得したHTMLの `class` に狙った
ユーティリティ（`hidden sm:flex` など）が乗っているかと、`/_next/static/chunks/*.css` にその
クラスが生成されているかで確かめる。
**確認後は必ずそのルートを削除し、`.next` を消してから `npx tsc --noEmit` をやり直す**
（消したルートの型定義が `.next/dev/types/` に残り、存在しないモジュールとして型エラーになる）。

**開発サーバーのPIDは `lsof -ti :<ポート>` ではなく `ss -ltnp` で引く。** `next dev` はIPv6の
`*:<ポート>` で待ち受けており、このホストでは `lsof -ti` が空を返すことがある（#237）。空のまま
止めたつもりになると、動き続けたサーバーが `.next/dev/types/` を書き戻し、上の型エラーが消えない。

```bash
ss -ltnp | grep ':17096 '   # users:(("next-server",pid=…)) のpidだけを kill する
```

ダッシュボード本体（`DashboardShell`）は確認用ルートからでもそのまま描画できる。`DashboardDataProvider`
に `initial={{ uptimeKuma: { monitors: [], error: null }, uptimeRobot: { monitors: [], error: null } }}` を渡せば、実データが無くてもタブの構造まで
HTMLに出るため、レイアウトやクラスの確認はこれで足りる（#136）。

## 本番のメモリ設定（PM2）

RSSを下げるため、次の2点を入れている（#291。guchi-apps/issue-deck#3017・#3027のカナリア横展開）。

- **`next.config.mjs` をTypeScriptに戻さない。** `next.config.ts` だと本番の `next start` が設定を
  トランスパイルするためだけにSWCのネイティブバイナリを読み込み、そのまま常駐する（issue-deckの実測で
  RSS約43MB・スレッド12本ぶん）。型は `// @ts-check` とJSDocで付け、`tsconfig.json` の `include` へ
  `next.config.mjs` を個別に足して `npx tsc --noEmit` の対象に残している（`**/*.ts` では `.mjs` は対象にならない）
- **`deploy/ecosystem.config.js` の `--max-semi-space-size=8`** は若い世代の上限。Node 24は既定で大きく
  取ってヒープが膨らむため明示している。**Nodeのメジャーを上げたら測り直す**（既定値はV8の版で変わる）。
  `max_memory_restart` を先に下げると再起動ループになる（issue-deck#1546・#2331）ので、変えるなら
  反映後の `VmHWM` を測ってから（下の「反映前後の実測」）
- `deploy.yml` は設定ファイル名を2か所（アーカイブと掃除の `rm -rf`）で書いている。名前を変えたら両方直す

### 反映前後の実測（#304）

v0.32.2（上の2点を入れたリリース）のデプロイ前後を本番で測った値。**測定には `sudo`（`github-user` のPM2）が
要るため、エージェントは代行できない。**

```bash
sudo su github-user -s /bin/bash -c 'pm2 describe ops-dashboard | grep -E "restarts|uptime|Used Heap|Heap Size|memory"; P=$(pm2 pid ops-dashboard); grep -E "VmRSS|VmHWM|Threads" /proc/$P/status'
```

| | 反映前（v0.32.1・稼働13h） | 反映後（v0.32.2・稼働4h） |
| --- | ---: | ---: |
| `VmHWM`（起動からのピーク） | 246.6 MB | **159.6 MB** |
| `VmRSS`（その時点） | 132.9 MB | 158.9 MB |
| `Threads` | 14 | **11** |
| `Used Heap` / `Heap Size` | 49.34 / 54.12 MiB | 53.85 / 64.36 MiB |
| `restarts` | 0 | 0 |

- **比べるのは `VmHWM` だけ。** `VmRSS` はその時点の値で、稼働時間が違うと比較にならない（反映前は
  ピークから戻った後の値、反映後はまだピーク付近）。反映後のほうが `VmRSS` は大きいが、悪化ではない
- **効いたのは `.mjs` のほう。** スレッドが14→11に減っており、SWCが読み込まれていない。`Heap Size` は
  下がっていないので `--max-semi-space-size=8` の寄与はほぼ無い。ops-dashboardは元からヒープが50MB台で、
  issue-deck（195MB→85MB）のような削り代が無いため
- **`max_memory_restart` は `320M` のまま据え置く。** 閾値を下げても使用量は減らず（PM2が殺す時期が
  早まるだけ）、再起動ループの前例がある。反映後のピークは稼働4時間時点の値でしかなく、反映前は13時間で
  246.6MBまで伸びていた。下げるなら、同じ稼働時間どうしで比べたピークを取ってから

## iOS 27のPWAが自動で付けるヘッダーのぼかし

iOS 27のホーム画面Webアプリは、画面上端に「有効な固定ヘッダー」（CSSの`position: fixed`かつ
高さ10pxを超える要素）が無いと判定すると、**実際の描画結果とは無関係にその判定だけで**
半透明のプログレッシブブラーをステータスバー周辺へ自動で付ける
（https://qiita.com/na-trium-144/items/0add98a80ca2391e3f17 。#361。KurashioやDaySpanでも同じ
症状を確認）。以前の#347の調査で`backdrop-filter`・`blur`・`position: fixed`のいずれもこの
リポジトリに存在しないと確認していたのは事実だが、それ自体が「固定ヘッダー無し」と判定されて
ブラーが出る条件だったと分かった。**別のエンドポイントやコード上の原因を探さないこと。**

- `opacity: 0` / `visibility: hidden` / `display: none` はこの判定から外れて無効。
  `background-clip: text` で「有効な背景を持つ固定要素として認識されるが、テキストが無いため
  何も描画されない」ダミー要素（`.ios-status-bar-blur-fix`。`globals.css` の`@layer base`・
  `layout.tsx` の`<body>`直下）を実DOM要素として置き、判定条件だけを満たしてブラーの発生自体を止める
- DaySpanは先に色ずれ（`theme-color`・manifestの`theme_color`・ヘッダー色が不一致）が原因の
  ブラーの中の色混ざりを別途修正していたが、StatusHubは背景色・`theme-color`・manifestの
  `theme_color`が元からライト/ダーク共通の同一色（`#071B38`）で揃っているため、この対応は不要
- この判定はAppleの非公式な内部挙動のため、iOSの将来のバージョンで条件が変わりうる

## 監視（Kuma・UptimeRobot）の取得失敗

`fetchUptimeKumaDashboardMonitors` / `fetchUptimeRobotMonitorsServer` は `MonitorFeed`
（`src/lib/monitor-feed.ts`、`{ monitors, error }`）を返す（#276）。**失敗と「モニター0件」を区別するため、
失敗を `[]` で返す形に戻さないこと。** 区別が無いと、Kumaが落ちたとき監視チップが黙って消え、
片方だけ落ちたときは残りの件数で「すべて正常」と出る。

- `error` は画面に出す短い理由（`HTTP 500`・`接続できません`・`応答の形式が想定と異なります`・
  `APIエラー: <type>`）。トークンやURLなど秘匿値を含めない
- **未設定（ベースURL・スラッグ・APIキーが無い）は失敗ではなく `error: null`・0件**。未設定の系統は
  チップにも数えず、worktreeでそのまま動かしてよい
- 失敗はチップ（`monitorChip`）・概要タブの見出しとタイル・監視タブのカードで `danger` として出す。
  片方だけ失敗したときは、チップの値を「一部 取得不可」にして残りの件数は注記へ回す
- `GET /api/uptime-kuma`・`GET /api/monitors` は失敗でも200で `{ monitors: [], error }` を返す。
  `monitors` は残してあるので、それだけを読む呼び出し元（AIDE）は変わらず動く。`error` を見るかは呼び出し元次第

## AIDEの動作状況（AIDEタブ）

AIDEタブは `aide.gucchii.com/status` と同じ内容を、AIDEの `GET /api/status`（guchi-apps/aide#276）から
読んで出している（#237）。**状態はAIDEのプロセス内の値（稼働時間・MCPアクセスの記録・トークン数）から
組み立てられるため、AIDEのデータファイルを直接読む形にはできない。**

- **応答の形の正はAIDE側**（`src/core/views/health.ts` の `Health`）。`src/types/aide-status.ts` はその写しで、
  AIDE側を変えたら合わせ直す。骨格が合わないときは画面ごと落とさず「取得不可」になる（`isStatusPayload`）
- **トークンは `AIDE_STATUS_TOKEN`（AIDE側は `AIDE_STATUS_SECRET`）で、`OPS_API_TOKEN` とは別。**
  `OPS_API_TOKEN` はAIDEがこちらを読む向きのもので、同じ値にすると片方が漏れたときに両方向とも読める。
  AIDEの `AIDE_READ_SECRET` も流用しない（残高のAPIまで読めてしまう）
- **トークンの正は1Passwordではなくissue-deckの共有トークンAPI**（`src/lib/shared-token.ts`。#444）。
  `readAideConfig()`（`src/lib/aide-status.ts`）が起動のたびに`GET $ISSUE_DECK_URL/api/shared-tokens?name=AIDE_STATUS_TOKEN`
  を叩き、結果をプロセス内に10分キャッシュする。取得に失敗したら直前の値を使い続け、キャッシュも無ければ
  環境変数 `AIDE_STATUS_TOKEN` へフォールバックする（1Password複製の移行期のみの経路。移行後は
  `ISSUE_DECK_URL`・`SHARED_TOKEN_API_SECRET`の2つだけが残る想定）。**`isAideStatusConfigured()`は
  同期関数のまま**（タブを出すかの判定に使うため）で、実際に取得を試みず「フォールバックenvか
  共有トークンAPIの設定が揃っているか」だけで判定している
- **`OPS_API_TOKEN` も同じ共有トークンAPIから取る**（#448。`src/lib/ops-api-token.ts` の `readOpsApiToken()`）。
  受ける側（`requireSessionOrApiToken()`。セッションで通る場合は取得を待たない）・連携先へ送るBearer・TypeSafe使用量
  （フォールバックは `TYPESAFE_USAGE_TOKEN`）の3か所でキャッシュを共有し、利用元は `ops-dashboard` で記録される。
  取得できなければ環境変数へフォールバックするため、**フォールバックに黙って落ちていないかは
  issue-deckの設定画面の利用元表示で確かめる**
- 取得に失敗したときのステータスで原因を切り分ける。401はトークンのずれ、503はAIDE側の未設定、
  404はAIDEにAPIがまだ無い（デプロイ前）
- `AIDE_STATUS_TOKEN`・`ISSUE_DECK_URL`+`SHARED_TOKEN_API_SECRET`のいずれも未設定ならタブもチップも
  出ない。worktreeでそのまま動かしてよい
- **「定期ジョブ」の行を押すと実行記録のモーダルが開く**（#387。`job-history-modal.tsx`）。ただしAIDEは
  実行記録をジョブごとに直近1件しか持たず、履歴（`jobs[].recentRuns`・新しい順・最大30件）を返すのは
  guchi-apps/aide#441の対応後。それまでは任意フィールドが届かず「実行記録がありません」の空状態になる。
  **こちらで履歴を貯め直す形にはしない**（AIDE側が正）。モーダルは、タブ切り替えの transform の中では
  `fixed` が画面基準にならないため `createPortal` で body 直下に出している

## dotの作業状況（AIDEタブの上部）

dotが**明示的に報告した作業だけ**を、AIDEの `GET /api/work-reports`（aide#609。契約は AIDE の
`docs/work-reports.md`）から読んで出している（#575）。**状態・版の順序・更新途絶の判定はAIDE側が正で、
StatusHubは推測しない。** 形の写しは `src/types/aide-work-reports.ts`。

- **トークンは `AIDE_WORK_REPORTS_TOKEN`（AIDE側は `AIDE_WORK_REPORTS_READ_SECRET`）で、`AIDE_STATUS_TOKEN`・`OPS_API_TOKEN` とは別。**
  共有トークンAPIは使わない（提供側のop://を参照するマニフェスト行で配る）。未設定なら節ごと出さない
- **更新途絶（`freshness: stale`＝最終受信から30分超）は「更新なし（状態不明）」と出し、完了・失敗へ推定しない。**
  「最終報告（AIDEの受信時刻）」と「確認（StatusHubの取得時刻）」は別に出す。取得失敗は無報告（空一覧）と区別し、
  直前の一覧を残すときは「最新とは限りません」と添える
- 1行でも形が違う応答は全体を捨てる（`parseWorkListing`）。遅れて届いた古い一覧・版が小さくなる行は採らない（`mergeWorkListings`）
- リンクは https のみ（`safeLink`）。内容はすべてテキストとして描画し、HTMLとして解釈しない
- **導入順（マージだけでは接続確認済みにならない）**: AIDEの再接続と `work-reports:*` scope の許可、実際のdot接続からの
  無害なテスト作業1件での確認は、利用者の承認と操作が要る（aide#609の導入順3・4）

## 監視モニターの表示名の変更

監視タブのカードの鉛筆ボタンで、モニターの表示名を変えられる（#479）。**名前はこのダッシュボードの
`.data/monitor-display-names.json`（`{"kuma:12": "名前"}` の形。環境変数 `MONITOR_NAMES_PATH` で差し替え可）にだけ
持ち、Kuma・UptimeRobot 側のモニター名は変えない。** UptimeRobot は読み取り専用キーで書けず、Kuma の
改名は socket 経路（`uptime-kuma-admin.ts`）頼みで壊れやすいため。別の経路で改名を探さないこと。

- 上書きは取得結果へ適用する（`applyMonitorDisplayNames`）。`name`（UptimeRobotは `friendly_name`）が
  変更後の名前になり、変更済みのときだけ `originalName` が付く。`/api/uptime-kuma`・`/api/monitors` を読む
  AIDEにも変更後の名前で届く
- キーは `kuma:<id>` / `robot:<id>`。IDは別系統で重なるため系統を前に付ける。空文字で保存すると上書きを消す
- 書き込みは `PUT/DELETE /api/monitor-names`（セッション＋`rejectCrossSiteRequest`。`OPS_API_TOKEN` では通さない）
- ダイアログは portal で body 直下へ出す（カードが外部リンクの `<a>` で、タブ切り替えの transform もあるため）。
  クライアントが読む定数は `node:fs` を含む `monitor-names.ts` ではなく `monitor-source.ts` に置く

## Uptime Kuma へのモニター登録

**Uptime Kuma にはモニターを作るREST APIが無い**（1.x・2.x とも）。公開されている
`/api/status-page/*` は読み取り専用で、作成できるのは**管理者としてログインした socket.io
セッションから `add` イベントを送る経路だけ**（v1.23.17 の `server/server.js:643`）。
別のエンドポイントを探さないこと。`src/lib/uptime-kuma-admin.ts` がこの経路を実装している。
公式に約束された仕様ではないので、Kumaを更新したらここが最初に壊れる。

- **`add` だけではダッシュボードに出ない。** この画面はモニターを公開ステータスページ
  （`/api/status-page/<slug>`）から読んでいるため、作成したあと `saveStatusPage` でその
  ページへ載せるところまでやって初めて一覧に並ぶ
- **`saveStatusPage` はグループとモニターの割り当てを丸ごと置き換える。** 送らなかった
  グループは消えるので、いま公開されている `publicGroupList` を読み直し、末尾に1件足したものを
  送り返す。差分だけを送る形にはできない
- **登録は `serialize` で1件ずつ通している**（#278）。「一覧を読む → 足す → 丸ごと保存」なので、
  並行して走ると後から保存した側が先の1件をページから外し、同じURLのモニターも二重に作られる。
  画面の「モニター追加」とサーバー間呼び出しは同じプロセスの同じ関数に入るため、この直列化で足りる
  （PM2を複数プロセスにしたら成り立たない）
- **グループ一覧は公開APIから読むしかない。** 管理者socketの `getStatusPage` は設定しか返さず、
  グループ一覧を返すイベントは無い。公開APIはKumaが応答を数分キャッシュすることがあり、古い一覧を
  読むと直前に足したモニターを外して保存してしまうため、`?_=<時刻>` を付けてキャッシュのキーを
  毎回変えている（Kuma側はクエリを見ない。Kumaを更新したら挙動を確かめ直す）
- **ページの設定は公開APIではなく管理者socketの `getStatusPage` から取る。** 公開APIが返す
  `config` には `domainNameList` が無く、それを渡して保存するとドメイン設定が消える
- **`login` の応答は、2要素認証が有効だと `{ tokenRequired: true }` で `ok` を持たない**
  （`server/server.js:377`）。`ok` だけを見ていると「拒否された」と誤って報告する
- **モニターは画面が送るのと同じ形で渡す。** サーバー側は受け取ったオブジェクトを RedBean の
  bean へ丸ごと import するだけで既定値を補完しない。`src/pages/EditMonitor.vue` の
  `monitorDefaults` を写した定数を `uptime-kuma-admin.ts` に持たせてあるので、Kumaを
  更新したときはそこを合わせ直す

`UPTIMEKUMA_USERNAME` / `UPTIMEKUMA_PASSWORD` が未設定なら登録機能は無効になり、監視タブの
「モニター追加」はKumaの `/add` を開くリンクへ戻る。設定を欠いたまま壊れないので、worktreeで
そのまま動かしてよい。

## アプリ別のAI利用（連携先のアプリが集計した使用量）

「どのアプリが、どのモデルで、どれだけ使ったか」は、**各アプリが使用量APIを持ち、こちらが読みにいく**
形で出している（#325）。応答の形・単価の扱いは README の「アプリ別のAI利用」を参照する。
提供元ごとの利用枠（Claude・ChatGPT）とは別の軸で、そちらのキャッシュ・記録・通知には触れない。

- **アプリから送りつける形（`POST`で受けて `.data/` に貯める）にはしていない。** 過去の推移は見えないが、
  全アプリへ送信処理と保管・認証を足さずに済む。推移が要るなら別Issueで、`history.ts` と同じ
  「観測を積む」仕組みを検討する
- **1行でも形が違う応答は全体を捨てる**（`parseAiAppUsageResponse`）。TypeSafeの `parse` は不正な行を
  捨てて表示を続けるが、こちらは合計が黙って少なくなるほうを避けている。揃えるべきは連携先のアプリ側
- **`inputTokens` を省略した行は「数えていない」（`null`）で、金額も `null`**（#414。research-deskはChatGPT認証のCodex CLIで、DBにはモデル名と実行時間しか残らずトークン数が無い）。合計は数えた行だけを足し、画面に「トークン未集計のアプリを除く」と注記する。Issueの「workrelay」はresearch-deskのこと。連携先のURLは research-desk 側に使用量APIが入ってから `AI_APP_USAGE_SOURCES` へ足す（先に足すと「取得不可（HTTP 404）」の行が出る）
- **単価表に無いモデルの金額は `null`（画面では「—」）。** 近いモデルの単価で推測しない。出力トークンを数えて
  いない行も、出力が有料のモデルなら `null`（入力だけの金額を全体の金額として出さないため）。
  合計に金額不明の行が混じるときは、画面に「+」と注記を出す
- **`AI_APP_USAGE_SOURCES` に `issue-deck` が無いあいだだけ、TypeSafeの取得結果をissue-deckの行として
  補っている**（`collect.ts` の `typeSafeAppFromUsage`）。issue-deckが使用量APIを持ったら、
  設定へ足すだけでTypeSafeからの補完は止まる。両方を数えるとJevが二重になる
- **`/api/ai-app-usage` は `src/proxy.ts` の除外に載せ、ルート側の `requireSessionOrApiToken()` で認証する。**
  AIDEなどサーバー間からも `OPS_API_TOKEN` で読めるようにするため。連携先へ送るBearerも同じ `OPS_API_TOKEN`
  （TypeSafe連携の `TYPESAFE_USAGE_TOKEN` を同じ値で配っているのと同じ考え方）。URLは https かループバックに限る
- **行の並びは `globals.css` の `.ai-app-row`（grid-template-areas）で3通りに切り替えている。** 列を足すときは
  3つのブレークポイントすべての `grid-template-areas` を合わせる
- **画面確認は2通り。** 描画は `AiAppUsageView`（取得から切り離してある）に作り物の `AiAppUsageSnapshot` を
  渡す `/login` 配下の一時ルートで確かめる（`AiAppUsage` 本体は取得後にしか描かないため、`curl` ではHTMLに出ない）。
  取得の経路は、`node` で `127.0.0.1` に `Authorization: Bearer` を検証する疑似の連携先を立て、
  `AI_APP_USAGE_SOURCES` と `OPS_API_TOKEN` を渡した `npm run dev` へ `curl` する（成功・形式不正・接続失敗の各行を作れる）

**「AIの用途一覧」は手で保守する登録簿**（`src/lib/ai-app-usage/purposes.ts` の `AI_PURPOSES`。#415）。
他リポジトリのAI呼び出しは実行時に検出できないため、AIを使う機能が増えたらここへ足す。状態は
スナップショットの `apps` に同名のアプリがあるか・`status` が `ok` か（計測中・取得不可・未連携）で決まり（環境変数ではなく取得結果で判定するため、issue-deckのTypeSafe補完も計測中になる）、`kind: "quota"` は常に「枠のみ」。
`app` は `AI_APP_USAGE_SOURCES` のアプリ名と同じ綴りにする。

## AI利用枠のクレジット（サブスク外）

サブスクの制限枠とは別会計の「クレジット枠」は、**両方とも使用状況のレスポンスに同居している**。
別のエンドポイントを探さないこと（2026-08-30に実レスポンスで確認）。

- **Claude**（`GET /api/oauth/usage`）は同じ内容を `extra_usage` と `spend` の2箇所で返す。
  読むのは **`extra_usage`**（`is_enabled` / `monthly_limit` / `used_credits` / `utilization` /
  `currency` / `decimal_places`）。Claude Code 本体が読んでいるのがこちらで、金額は最小単位
  （USDならセント）。`spend` は同じ値を `amount_minor` + `exponent` で持つ古い形で、
  `src/lib/ai-usage/claude.ts` ではフォールバックとしてだけ残している。
  **リセット時刻はレスポンスに無い**ため、Claude Code と同じく翌月1日として扱う
- **ChatGPT**（`GET /backend-api/wham/usage`）は `credits`（`has_credits` / `unlimited` /
  `balance` / `approx_local_messages`）。**`balance` は数値ではなく文字列**で返る。
  購入した総量は返らないので**使用率（分母）を出せない**——バーではなく残高だけを出す。
  ワークスペースの上限（`spend_control.individual_limit`）は個人アカウントでは `null`

`/api/oauth/usage` の Claude `extra_usage` は前払い残高ではなく、月額上限と当月の使用額を返す。

**Claude.aiの画面に出る前払い残高・購入履歴は、サーバーから取得できない。** Claude Webの非公開API
（`GET https://claude.ai/api/organizations/{org}/prepaid/credits` など）は `sessionKey` cookieを要求するが、
その手前のCloudflareのボット判定で、cookieの有無・User-Agent・curl/Nodeの別によらず
**403（`cf-mitigated: challenge`）**が返る（#252でサブPCから確認）。sessionKeyを本番へ渡す経路を
作っても効果は無いので、再挑戦しないこと。#250で入れたsessionKey経路は#252で削除した。

代わりに `src/lib/ai-usage/claude-credit-ledger.ts` の**手入力の台帳**（`.data/claude-credit-ledger.json`）で出している。

- 購入（日付・金額）と「ある時点の残高（補正値）」を画面の「購入・残高を記録」から登録する
  （`POST/DELETE /api/ai-usage/claude-credits`。`/api/ai-usage` 配下はproxyの認証対象外なので、
  ルート側でセッションを確かめている）
- 推定残高 = 補正値 ＋ 補正日より後の購入 − 補正後の使用額。使用額は `extra_usage.used_credits` を
  取得のたびに観測し、**値が減ったら月のリセットとみなしてその値を足す**累計で持つ（暦の月で区切ると、
  提供元が月を切るタイムゾーンとずれて二重計上しうるため）。月末の最後の観測からリセットまでの分は
  取りこぼすので、ずれたら補正し直す運用
- 購入総額は購入日から1年以内（有効期限内）のものだけを合計する。期限切れで消えた残りの差し引きは再現しない
- 台帳の値は提供元の取得をキャッシュから返す回も毎回載せ直す（`applyClaudeCreditLedger`）。
  記録直後に画面へ出すため
- バーの青い区間（購入済み・未使用。#258）の幅は `getReservedPercent` が「推定残高 ÷ 月の上限」で出し、
  使用済みの右隣に描く。**残高が上限の残りを超える分は切る**（右端が上限の位置で止まる）。
  推定残高が無い・上限が無い・残高ゼロのときは出さない。ChatGPTは上限が無いので対象外

**画面確認は `/login` 配下の一時ルートから `parseClaudeUsageResponse` /
`parseChatGptUsageResponse` に実レスポンスを流し込むのが早い。** どちらの提供元も
リフレッシュトークンが要り、worktreeには `.env.local` が無いため実データを直接引けない。

## AI利用枠の「使い切り」（枠ごとの実績）

**過去の制限枠の実績を返すAPIはどちらの提供元にも無い。** 返るのは常に「いまの枠の使用率」だけなので、
`src/lib/ai-usage/history.ts` が取得のたびに枠ごとの値を `.data/ai-usage-windows.json` へ書き留め、
リセット時刻を過ぎた枠を確定値として扱っている（#244）。別のエンドポイントを探さないこと。

- **記録は「観測できた時点の値」でしかない。** 取得はリクエスト契機でしか走らず、サーバー側の定期実行は
  無い。枠の終了間際に観測が無い枠は実際より低い値で確定するため、`undersampled` を立てて画面では
  斜線で区別している。精度は観測の頻度に依存し、過去に遡って埋めることはできない
- **観測をつないでいるのは `POST /api/host-stats`。** ダッシュボードを誰も開いていない時間帯は
  ブラウザからのポーリングが止まるため、ホストのメトリクス受信を契機に `getAiUsageSnapshot()` も
  回している。**これにより提供元への問い合わせは常時5分間隔になる**（それまでは画面を開いている
  間だけ）。エージェントは1分ごとに届くが、キャッシュ（既定300秒）を挟むので実取得は5分に1回で、
  Anthropicが推奨する180秒以上の間隔は保たれる。**ホストのエージェントが止まると枠の記録も粗くなる**
- **キャッシュは提供元ごとに分かれている**（`src/lib/ai-usage/provider-cache.ts`。#273）。1つにまとめると、
  片方のエラー用の短いTTL（30秒）に引きずられて、正常なもう片方まで毎分叩くことになる。Claudeは失敗時も
  180秒より短くは取り直さず、リフレッシュトークンの失効（`RefreshTokenRevokedError`）は短いTTLの対象から外す。
  ウィジェット（`/api/claude-usage`）も同じClaudeのキャッシュを読む。記録（区切り・実績・クレジット・通知）へ
  回すのは、取り直された提供元の結果だけ
- **リセット時刻の一致で枠を同定してはいけない。** ChatGPTは `reset_at` を返さないことがあり、
  その場合 `chatgpt.ts` が `Date.now() + reset_after_seconds` で組み立てるため、同じ枠でも取得の
  たびに数秒ずれる。同定は「リセット時刻が枠の半分より先へ進んだか」で行う
- **枠のキーは `windowSeconds` と `note` で組む。** Claudeの週間枠は全体・Opus・Sonnetの3本あり、
  `label` はどれも「週間」で同じなので、`label` でまとめると3本が1系列に潰れる
- **サンプルは1行ずつ足さず、枠ごとに最後の値だけを残す。** 使用率は枠の中で増える一方なので、
  確定値に要るのは最後の観測だけで、ログ形式にするとファイルだけが際限なく伸びる
- **取得中の要求は同じ取得へ相乗りさせている**（`usage-cache.ts` の `createSingleFlight`。AI・GitHub・
  1Passwordで共通。#274）。キャッシュが切れた瞬間に画面のポーリングと `POST /api/host-stats` が重なると、
  キャッシュの判定だけでは全員が提供元へ取りにいき、429になる。さらに、先に取った小さい使用額が
  後から `recordClaudeCreditUsage` へ積まれると「値が減った＝月のリセット」と誤認され、累計へ二重に
  足される。**キャッシュの判定から取得の開始までに `await` を挟まない**（挟むと相乗りをすり抜ける）
- **取得に失敗した提供元は記録しない**（`status !== "ok"`）。0%を実績として残すと、使わなかった枠として
  確定してしまう
- 画面は使用率で赤・橙へ色を変えない。ここは「払っている枠を使い切れたか」を見る場所で、
  たくさん使ったことは悪い状態ではないため、既存の `UsageBar` と同じ色使いにすると意味が逆に読める

## AI利用枠のプッシュ通知

利用枠が上限に近づくと、ヘッダー右上のメニュー内の「通知」行で登録した端末へWeb Pushで知らせる（#263・#268）。
条件は Claudeの5時間枠が90%以上・週間枠（Claudeの全体・Opus・Sonnet、ChatGPT）が95%以上・その枠が100%。
ChatGPTの5時間枠は対象外（Issueの指定）。

- **判定はサーバー側で、`getAiUsageSnapshot` が提供元から取れた回ごとに走る**（`src/lib/ai-usage/alerts.ts`）。
  `POST /api/host-stats` が取得を回しているため、画面を閉じていても5分おきに判定される。
  ホストのエージェントが止まると、画面を開くまで判定されない
- 同じ枠・同じ段階は1回だけ送り、`.data/ai-usage-alerts.json` に残す。枠の同定は history.ts と同じく
  「リセット時刻が枠の半分より先へ進んだか」で行う（ChatGPTのリセット時刻は取得のたびに数秒ずれる）。
  **登録した端末が無い間は記録もしない**（あとから登録した端末へ、いまの状態を送れるように）
- **記録は送った後に書き、1台にも届かなかった通知は記録しない**（#297）。以前は送る前に記録していたため、
  購読が無効（404・410）だった・送信に失敗した通知は、同じ枠では二度と送られなかった（実際に
  Claude 5時間枠の96%を取りこぼした）。届かなければ次の判定（5分後）で送り直し、アプリを開いて購読が
  登録し直された時点で届く。判定は `running` で直列化しているので、送信後に記録しても二重には送らない
- 購読は `.data/push-subscriptions.json`。プッシュサービスが404・410を返した購読は消し、ログに
  `[web-push] 無効になった購読を…削除しました` を出す。`createdAt` は初めて登録した日時で、アプリを開くたびの
  登録し直しでは `lastSeenAt` だけが進む（`createdAt` が新しければ、購読が入れ替わったということ）
- **送信の結果は `.data/ai-usage-alerts.json` の `attempts` に枠ごとに残る**（送ろうとした日時・届いた台数
  `delivered`・404/410で消した数 `removed`・それ以外の失敗のステータス `failures`）。届かなかった回も残す。
  `windows` は「届いた段階」なので、`attempts` にあって `windows` が進んでいなければ届いていない。
  #297の調査では本番のpm2ログから何も取れなかったため、ログ（`[ai-usage-alerts] … N台へ送信`）には頼らず
  こちらと `.data/ai-usage-windows.json`（枠ごとの最大使用率）を突き合わせる。**送信は `urgency: high`** で、
  iPhoneで配信を後回しにされないようにしている
- **`public/sw.js` は `src/proxy.ts` の matcher から外してある。** Service Workerのスクリプト取得が
  ログイン画面へリダイレクトされると、ブラウザは登録を失敗させる
- iPhone・iPadはホーム画面に追加したアプリからしか受け取れない（iOS 16.4以上）。Safariのタブでは
  「通知」行が「非対応」表示になる
- 鍵は `WEB_PUSH_VAPID_PUBLIC_KEY` / `WEB_PUSH_VAPID_PRIVATE_KEY`（`npx web-push generate-vapid-keys`）。
  未設定ならメニューに「通知」行を出さず、判定もしない。**鍵を作り直すと登録済みの端末へは届かなくなる**ため、
  入れ替えたら各端末で「通知」行から登録し直す
- **メニューを閉じている間も `UsageNotifications` はマウントされたまま**（`HeaderMenu` はパネルを
  `hidden` で隠すだけ）。Service Workerの登録と、許可済み端末の購読の登録し直しはマウント時に走るため、
  開いたときだけ描画する形に変えると、メニューを開かない端末では通知の準備が走らなくなる
- worktreeで送信まで確かめるには、鍵を作ってコマンドに渡し、ログインした画面から登録する必要がある。
  GUIの無い環境では購読を作れないため、判定だけを `evaluateUsageAlerts` に作り物のスナップショットを流して確かめる

## ホスト停止のPush通知と未解消エラー件数（#495）

詳細は [docs/host-incident-alerts.md](./docs/host-incident-alerts.md)。守ること:

- **判定は `src/instrumentation.ts` のプロセス内タイマー（30秒）。** 画面のGETや `POST /api/host-stats` を契機にしない。
  `register` は `NEXT_RUNTIME === "nodejs"` のときだけ動的importする（`node:sqlite`・`web-push` を読むため）
- **オンライン判定は `judgeHostOnline` の1関数を画面と共有する。** 通知と件数で別々に決めない。
  定期ジョブは `summarizeTimers` を使い回し、独自の除外処理を書かない
- **Pushはホストの停止・復旧・再起動だけ。** サイトDOWN・ジョブ・サービスの増減はPushしない（iOSは表示なしの
  バッジ更新Pushが使えず、ジョブはSignalyと二重になるため）。バッジは `seq` で巻き戻りを防ぎ、`public/sw.js` と
  `badge-client.ts` は同じIndexedDB（`status-hub-badge`）を読み書きする
- 送信先は `isHostAlertRecipient`（いまアクセス許可・端末オン・利用者記録あり）だけ。`sendPushToAll` を使わない
- 監視の取得失敗を「DOWN 0件」にしない（前回を持ち越し、取得不可へ出す）。通知の文面で原因を断定しない

## モデル単価表の定期チェック（#497）

詳細は [docs/model-price-watch.md](./docs/model-price-watch.md)。守ること:

- **チェックは `src/instrumentation.ts` のプロセス内タイマー**（`runModelPriceWatchIfDue`。既定は毎週月曜05:00 JST）。
  画面のGETから公式ページへ取りにいかない。本番（`NODE_ENV=production`）か `MODEL_PRICE_WATCH_ENABLED=1` のときだけ動く
- **`models.ts` は自動で書き換えない。** 結果は `.data/model-price-watch.json` に残し、人が候補を確かめて出典付きで直す。
  旧モデルの行は消さない（過去の金額を「不明」にしないため。価格を変えると過去期間の概算も新単価で再計算される）
- **公式の表の取り違えを避ける。** OpenAIは節見出し `### Standard pricing data` だけ読む（Batch等は同じ列構成の別節）。
  `-` は0にしない。条件付きの行は通常価格にしない。Anthropicの表示名からIDを推測しない。
  `findModel` の前方一致は使わない（`claude-sonnet-5-5` が `claude-sonnet-5` に当たる。#362）
- **取得失敗を「変更なし」にしない。** 失敗した提供元は前回の候補を持ち越す。通知の宛先は `sendPushWhere`（`sendPushToAll` を使わない）

## 週間枠の「1日ごとの区切り」

週間枠のバーに立つ細い点線は、**その日の終わりまでの累計使用率**の位置にあり、線と線の間隔が
その日に使った量になる（#243）。提供元が返すのは現在の累計だけなので、日ごとの内訳は
`src/lib/ai-usage/day-marks.ts` が取得のたびに観測を `.data/ai-usage-days.json` へ残して導いている。

- **記録が進むのはダッシュボードを開いたときだけ。** 使用状況の取得はリクエスト契機でしか走らず、
  サーバー側の定期実行は無い（`github-repo-visibility.ts` と同じ性質の制約）
- **区切りの手前 6時間以内に観測が無い日は、線を出さない。** 前日の値をその日の終わりの値として
  置くと、間に使ったぶんが翌日の量として現れてしまうため。線が出なかった日は隣の日とまとまり、
  ホバーの内訳も「4〜5日目 +16%」のようにまとまって出る
- リセット時刻（`resetsAt`）が変わったら別の枠として記録を作り直すので、**リセット直後は線が無い**
- 画面確認は `/login` 配下の一時ルートを立て、`AI_USAGE_DAYS_PATH` に作業用のパスを与えて
  `attachDayMarks` を作り物の時刻で何度か呼ぶのが早い（`.data/` はworktreeと本番で別物のため、
  開発サーバーをそのまま動かしても線は出ない）

## 共通アクセス設定（ログインの許可・アプリ別権限）

ログインの許可は `ALLOWED_EMAILS` ではなく、**StatusHub内のSQLite（`.data/access.sqlite`）**で判定する（#489）。
契約・失敗時の動作・反映時間・復旧手順は [docs/access-control.md](./docs/access-control.md)。
各アプリへの導入状況・移行CLIは [docs/access-rollout.md](./docs/access-rollout.md)（#490）。**対象アプリのリポジトリはすべて公開のため、アプリ別の弱点・迂回口はここにも導入Issue・PRにも書かない**（非公開の `guchi-apps/docs` に置く）。

- **`ALLOWED_EMAILS` は初回のDB作成時に管理者として取り込むだけ。** 判定へ戻さないこと。判定は `src/lib/access/status-hub.ts`
  （30秒キャッシュ。DBが読めないときは直前の判定を最大5分、一度も読めていなければ拒否）。**読めないことを理由に許可を広げない**
- **`ACCESS_ENVIRONMENT` は `deploy.yml` の `update_env ACCESS_ENVIRONMENT production` 1行で渡す**（秘密ではなく、env ブロックは
  `generate-workflow-env-block.sh` の生成物のため触らない）。DBの記録と食い違えば全拒否。直すのは `scripts/access-recover.mjs set-environment`
- **`node:sqlite` の型は `src/types/node-sqlite.d.ts` に手書き**（`@types/node` は v20 で型が無い。依存は上げていない）。使うメソッドを増やすときはここへ足す。
  CI・デプロイのNodeは22.23.1（`.nvmrc`）。`node:sqlite` はフラグ無しで動くがExperimentalWarningが出る
- **`/api/access/v1` だけが `src/proxy.ts` の認証対象外**（アプリ別トークンをルート側で照合）。`/api/access/admin/*` は管理者のセッション
  （`requireAdminForApi`）＋CSRF（`handleAdminWrite`）。アプリ別トークンでは管理APIを通さない
- 反映状況は**StatusHub側だけの推定**（アプリが申告する `appliedVersion` の記録）。保存成功を「反映済み」にしない
- 認可の判定・管理画面・復旧CLIのパスは `claude-review-develop.yml` の `risk-paths` に載せてある。新しいファイルを足したら合わせる

## セッションで受ける書き込みAPIのCSRF対策

**GET以外でログインセッション（Cookie）を受けるルートは、認証の直後に `rejectCrossSiteRequest(request)`
（`src/lib/csrf.ts`）を通す**（#466）。`request.json()` はContent-Typeを見ないため、`*.gucchii.com` の
他アプリのXSSからCookie付きでJSONを送れてしまう。画面側のfetchは `CSRF_HEADERS`
（`src/lib/csrf-headers.ts`。クライアントから `next/server` を読ませないため別ファイル）を `headers` へ
展開する。Bearerトークンで受ける経路（`ai-app-usage/sources` のPUTなど）はセッションのときだけ確認する。

## ログイン通知の接続元IP

ログイン通知（`src/lib/signaly.ts`）の `接続元IP` は、Signalyが「見覚えのない接続元か」を判定する
手がかりになる（#281）。**`X-Forwarded-For` は先頭ではなく末尾（`clientIpFromForwardedFor`）から読む。**
mod_proxy はクライアントが送った値を消さず、末尾へ実IPを足すだけなので、先頭はクライアントが自由に
決められる。`X-Real-IP` も読まない（Apacheは付けないため、クライアントの値がそのまま届く）。

- `deploy/apache-vhost.example.conf` は `RequestHeader unset X-Forwarded-For` でクライアントの値を捨てる。
  **一次情報源は `vps` リポジトリの `apache/sites-available/admin.gucchii.com.conf`** で、ここの雛形を
  直しただけでは本番へ反映されない。アプリ側が末尾を読むので、Apacheの反映前後でどちらも正しい値になる
- 手前にCDNなどを足すとプロキシが2段になり、末尾がそのIPになる。そのときは読み方を見直す
- 同じ書き方（先頭を読む）は共有ドキュメント `_docs/guides/signaly-notifications.md` の共通実装にもある

## GitHubの課金・使用量API

**Actions無料枠の「消費した分」を直接返すAPIは存在しない。** 旧 `GET /orgs/{org}/settings/billing/actions`
（`total_minutes_used` / `included_minutes` を返していた）と `.../shared-storage` は **HTTP 410 で廃止**され、
`GET /organizations/{org}/settings/billing/usage`（日次明細）と `.../usage/summary`（月次集計）へ統合された。
統合後のレスポンスには「無料枠を消費したか」を示す項目が無いため、ダッシュボードの無料枠ゲージは
**明細から導出した推定値**である。次の点に注意する。

- **無料枠を消費するのは非公開リポジトリの分だけ**だが、課金レポートは公開/非公開を返さない。
  リポジトリ一覧と突き合わせるしかないが、**「今」の公開状態で判定すると、月の途中で公開へ
  切り替えたリポジトリの非公開だった期間の分が丸ごと抜ける**（#151。実測で40%近くずれた）。
  `src/lib/github-repo-visibility.ts` が公開状態を `.data/` に記録し、使用日時点の状態で判定する。
  記録が始まる前の期間は `GH_USAGE_PRIVATE_UNTIL` で補う
- **記録に残るのは「切り替えた日」ではなく「切り替え後に初めてダッシュボードを開いた日」。**
  取得はリクエスト契機でしか走らず、サーバー側の定期実行は無い。開かない日が続くと、その期間は
  切り替え前の状態で判定される（非公開→公開なら多めに出る）。精度は開く頻度に依存する
- **月次集計 `usage/summary` を使う必要はない。** 同時刻に取れば分数も金額も日次明細の合計と一致する
  （実測で 41,048分・$246.72 が一致）。さらに `product` で絞らないとGHASのライセンス料まで
  混ざるうえ、明細とフィールド名（`quantity` と `grossQuantity`）も表記（`Minutes` と `minutes`）も違う
- `year` / `month` を付けずに叩くと、全リポジトリの合計が単一のリポジトリ名に束ねられて返る。
  リポジトリ別の内訳を出すときは必ず指定する
- 課金レポートのエンドポイントは **fine-grained PAT に非対応**。classic PAT（`repo` と `read:org`）を使う
- **「API レート制限」のPAT枠と、issue-deckの「guchi-apps」の枠は別物**（#517）。`GH_USAGE_TOKEN`（PAT）の
  `/rate_limit` は個人の枠（上限5,000）で、issue-deckが表示するのはGitHub Appインストールトークンの枠
  （上限5,600）。StatusHubはApp枠を `GET $ISSUE_DECK_URL/api/github/rate-limit/apps`（Bearer `OPS_API_TOKEN`）
  から読む（`src/lib/github-app-rate-limit.ts`。issue-deck側の対応は guchi-apps/issue-deck#3830）。
  対応前は404で「取得不可」と出る。**PATの `/rate_limit` にGraphQLを足して代用しない**（Projects v2の消費が現れない）

## マルチエージェント運用（GitHub Actions 無人実行）

`@claude` コメントを起点に、計画提示〜実装〜develop向けPR作成までを GitHub Actions 上で無人実行する。
ワークフローの実体は `guchi-apps/issue-deck` にあり、このリポジトリの `.github/workflows/` には
`uses:` で参照する薄い caller だけを置いている。**callerを追加・更新する
ときは、`uses:` のタグと `prompts-ref` をリポジトリ内の全callerで同じ値に揃える。**

設計・運用の詳細は issue-deck 側を参照する。

- 進捗管理の設計: [progress-status-architecture.md](https://github.com/guchi-apps/issue-deck/blob/main/docs/progress-status-architecture.md)
- 無人実行の挙動: [multi-agent/dispatch.md](https://github.com/guchi-apps/issue-deck/blob/main/docs/multi-agent/dispatch.md)

### ブランチ

- 機能開発: `develop`
- 安定版 / 本番デプロイ: `main`（マージ時に GitHub Actions が VPS へデプロイ）

Issue専用ブランチは `develop` から作成し、ブランチ名は **`issue-<Issue番号>`** とする（例: `issue-64`）。
ワークフローはブランチ名から対象Issueを特定するため、**この命名規約に従わないブランチはすべて対象外**になる。

**以前使っていた `feature/<番号>-<説明>` では進捗が一切遷移しない。** 既存の `feature/` ブランチは
そのまま残してあるが、新しく作るブランチはすべて `issue-<番号>` にする。

デフォルトブランチは `develop` にしておく。`issues`・`issue_comment` イベントはデフォルトブランチの
ワークフローしか起動しないため、`main` にすると `@claude` コメントに反応しなくなる。

### Issueの進捗

**進捗は GitHub Projects の Status で管理する。進捗ラベルは存在しない**
（issue-deck#1010 / #991 Phase 5 で `01.wip`〜`09.main` を廃止した）。

1. `Ready` — 未着手
2. `Planning` — 計画検討中（`21.plan-required` 選択時のみ経由）
3. `Implementation` — 実装中
4. `Develop PR` — developへPR作成・マージ中
5. `Develop` — developへマージ完了（main未反映）
6. `Release` — mainへPR作成・マージ中
7. `Done` — mainへマージ完了。この時点でissueをcloseする

**`gh issue edit` で進捗を進めることはできない。** Status を書けるのは issue-deck だけで、
ワークフローは進捗報告API（`POST /api/progress`）へ報告する。ブランチのpush・PR作成・PRマージを
トリガーに自動で遷移するため、エージェントが自分で進捗を動かす必要はない。

### リリース（develop→main）

**リリースは issue-deck の画面から起動する。** ヘッダーのロケットアイコン、またはブランチの流れ画面の
リリースボタンが `.github/workflows/release-develop-to-main.yml` を `workflow_dispatch` で起動し、
次の順に進む（issue-deck#1591）。

1. バージョンbump PR（`release/vX.Y.Z` → `develop`）が作られる。上げ幅は画面で指定するか、
   main と develop のコード差分から自動判定する。CI通過後に develop へ自動マージされる
2. バンプPRのマージで `package.json` が変わると同じワークフローが再度起動し、develop → main の
   リリースPRを作る
3. **リリースPRのマージは人が行う**（自動マージ不可カテゴリ）。マージすると `deploy.yml` が
   `v<version>` タグを作り、VPS へデプロイする

バンプ時には `npm version` の `version` フックから `scripts/version-changelog.mjs` が走り、
`src/data/changelog.ts` の先頭へ新バージョンのエントリを差し込む。文面は共有ワークフローが
差分から生成して `RELEASE_CHANGELOG` で渡してくるので、**バンプPRのレビュー時に内容を確認し、
必要なら直す**（利用者が読む文章のため）。

**`RELEASE_CHANGELOG` が空のときは、エントリを作らない**（バージョンだけが上がる。#336）。以前は
仮の文言（「（変更内容を追記してください）」）を1件入れていたが、画面で体感できる変化が無いリリースでは
誰も埋めず、更新履歴の画面に仮文言だけの版が残り続けた。`RELEASE_USAGE` だけが渡っても作らない
（`usage` は `changes` の補足のため）。`changelog.ts` のマーカーが見つからないときは、空でも
従来どおり失敗にする。**仮の文言を入れる形に戻さないこと。**

同じ経路で **`RELEASE_USAGE`（利用者向けの操作手順）** も渡ってくる（issue-deck#1729）。
`RELEASE_CHANGELOG` が「何が変わったか」、`RELEASE_USAGE` が「どう使うか」で、後者は
`ChangelogEntry.usage` として `changes` とは別に持たせ、更新履歴の画面でそのバージョンの
変更点の下に「使い方」として出す。**画面で使える変化が無いリリースでは空文字で渡るため、
そのときは `usage` の項目ごと出力しない**（空の見出しが残ると書き漏らしに見えるため）。
共有ワークフローの参照タグ（`@workflows/vN`）が上がるまでは実際には常に空文字が渡る。

**`preversion` にテストやlintを足さないこと。** 共有ワークフローはバージョンbumpのために
依存関係をインストールしない（`setup-node` も `npm ci` も無い）ため、`node_modules` を要する
スクリプトを lifecycle に置くとリリースが必ず失敗する。`version` フックから呼ぶスクリプトも
Node標準モジュールだけで書く。

エージェントはこのフローを自分で起動しない。バージョンを手で書き換える必要もない
（`package.json` の `version` はバンプPRだけが更新する）。

### 条件を表すラベル（進捗とは別軸）

Status = 今どこにいるか、Label = どんな性質・条件があるか、という役割分担にしている。

| ラベル | 意味 |
|---|---|
| `00.check-user` | ユーザーの確認・指示が必要。どの段階でも併用する |
| `00.qa-answered` | 質問への回答のみ完了（`00.check-user` と常に併用） |
| `11.local` | ローカル（VSCode等）で対応中。付いている間は無人実行を起動しない |
| `21.plan-required` | 実装前に計画を提示し承認を得る |
| `22.merge-confirm-required` | 内容によらず、developへのマージ前に必ず `00.check-user` を付ける |
| `23.preview-required` | PR作成前に開発サーバーでの画面確認を必須にする |
| `24.screenshot-required` | PR作成前にスクリーンショット取得を必須にする |
| `71.manual-step` | エージェントが代行できないユーザー自身の手作業 |

### 自動マージ不可カテゴリ

以下に該当する変更は自動マージせず `00.check-user` を付与してユーザーの確認を待つ。

- 認証・認可（`src/proxy.ts`・認証まわりの `src/app/api/**`）
- 本番環境の設定（`deploy/**`）
- GitHub Actionsやデプロイ設定（`.github/workflows/**`）
- Secretsや環境変数（`.env*`・`scripts/sync-github-secrets.sh`）
- 外部サービスのトークンを扱う経路（AI利用枠・UptimeRobot・GitHub の各APIクライアント）
- 課金・決済
- 大規模な依存関係の更新
- `develop` → `main` のマージ

**develop向けPRのClaude Codeレビューは、このリポジトリでは毎回走る**（#233）。共有ワークフローの既定は
「リスクパスに該当」か「10ファイルまたは500行以上」のときだけ `claude-review` を実行し、それ以外を
skipする（guchi-apps/issue-deck#992。コスト削減のため）。既定のままだと、トークン処理を変えた#223を
含む小さなPRがすべてskipされていた。数行でも致命的になりうる変更はパスで列挙しきれないため、
`.github/workflows/claude-review-develop.yml` で `review-file-threshold: "1"` にしてある。

上のカテゴリのうちパス名から判別できないもの（認証・APIルート・トークンを扱うクライアント）は、
同じcallerの `risk-paths` に列挙してある。**判定の対象はパスだけなので、トークンやセッションを
扱うファイルを新しく足したら `risk-paths` にも足す**（足さなくてもレビューは走るが、`risk-check`
ジョブのサマリー「Claude Review 実行判定」に該当理由が出ない）。`merge-policy` は既定の `relaxed` のままで、該当してもdevelopへのマージは
止まらない（レビューが要修正と判定した場合だけ止まる）。

### 実装エージェントの禁止事項

- `main` / `develop` への直接コミット・push
- 他Issueのブランチの編集
- 担当Issue以外の実装（別件を新規Issueとして起票するのはよい）
- 不要なforce push
- 自分が作成したPull Requestの自己マージ

### コミット・PR・コメントの書き方

- コミットメッセージ・PRタイトル・PR本文・issueコメントは**日本語**で書く
- コミットの author は `Claude Code <claude-code@example.com>` にする
- `develop` 宛のPR本文には、対応Issue・実装内容・テスト内容・確認方法・注意点を記載する。
  developマージ時点ではissueをcloseしない運用のため、`closes #番号` / `fixes #番号` は使わず
  `#番号` のみ記載する

### 依存関係の追加

新しい依存関係を追加する前には、必ずユーザーに確認を取る。無人実行では確認相手がいないため、
追加が必要だと判断した場合は追加せずに作業を止め、`00.check-user` を付与したうえで
なぜ必要かをIssueコメントで相談する。

### シークレットの扱い

APIキー・トークン・パスワード等の実シークレットをコミットしない。コミットしてよいのは値を空にした
サンプル（`.env.example`）と、1Passwordの `op://vault/item/field` 形式の参照だけを書いたテンプレートに
限る。実値は `.gitignore` 済みの `.env*` と1Password側、およびGitHubのsecret/variableにのみ置く。

**実行時の1Password呼び出しは行わない**（issue-deck#1307）。GitHub Actions は GitHubの
secret/variable から値を取得する。
