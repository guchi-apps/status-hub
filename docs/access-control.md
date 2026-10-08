# 共通アクセス設定（StatusHub）

自作アプリのログイン許可（誰が・どのアプリを・どの権限で使えるか）の**正本**をStatusHubに置く（#488・#489）。
管理画面は `/admin/access`（管理者のみ。ヘッダーのメニュー →「アクセス管理」）。各アプリへの導入は別Issue（#490）。

## 保存先

- SQLite（Node標準の `node:sqlite`）の `.data/access.sqlite`。`ACCESS_DB_PATH` で変更できる。`.gitignore` 済みで、デプロイでも消えない
- **秘密情報の値は持たない。** アプリ別トークンはSHA-256のハッシュだけ。許可メールは個人情報のため、GitHub・ログへ実値を書かない
- 本番と開発は `ACCESS_ENVIRONMENT`（`production` / `development`。未設定は `development`）で区別する。初期化時にDBへ記録され、
  環境変数と食い違うと**全拒否**になる。本番は `deploy.yml` が `update_env ACCESS_ENVIRONMENT production` で渡す
- 初めてDBを作るときだけ、`ALLOWED_EMAILS` のメールを**StatusHubの管理者として取り込む**（移行用。以後は変更しても反映されない）

## 権限の構造

- アプリ（`apps`）ごとに「対応する権限」を定義する。StatusHub自身は `member` / `admin` 固定（`admin` が管理画面を使える）
  - 管理画面の登録・編集ダイアログでは `viewer` / `member` / `editor` / `admin` をチェックで選び、これ以外は「その他の権限」から追加する（#512）
- ユーザー（メール）にアプリ別の権限を付ける。**付与の無いアプリは拒否。** ユーザーを取り消す（`revoked`）と全アプリで拒否
- 変更は1トランザクションで「更新 → 監査履歴 → 影響したアプリの版を進める」を行う。**版はアプリごと**に進む（無関係な変更でほかのアプリが反映待ちにならない）
- 最後の管理者を失う変更（取り消し・`admin` の削除）は409で拒否する

## アプリ向けの契約

`POST /api/access/v1/decision`（`Authorization: Bearer <アプリ別トークン>`）。トークンは管理画面の「アプリ」タブで発行する
（平文は発行直後の1回だけ表示。再発行で古いものは即失効）。トークンは**発行したアプリの判定だけ**を引け、管理APIや他アプリの設定には使えない。

```jsonc
// リクエスト（subject を省くと、判定なしの確認＝ハートビート）
{ "appliedVersion": 12, "subject": { "sub": "<検証済みID>", "email": "user@example.com", "emailVerified": true } }
// レスポンス
{ "environment": "production", "appVersion": 12, "ttlSeconds": 30, "maxStaleSeconds": 300,
  "decision": { "allowed": true, "permissions": ["viewer"] } }   // 拒否は allowed:false と reason
```

- **`subject` はアプリのサーバーが検証したものだけを送る。** ブラウザが申告したメールをそのまま送ってはならない。
  `sub` と `emailVerified: true` が揃わないものは `unverified_identity` で拒否される。メールはURLに載せないよう POST にしている
- `reason`: `unknown_user`（未登録）・`revoked`（取り消し済み）・`no_grant`（そのアプリの付与なし）・`unverified_identity`
- `appliedVersion` は**アプリが現在適用中の `appVersion`**（直前のレスポンスの値）。初回は省略する

### 失敗時の動作・キャッシュ・反映時間

| 項目 | 値 |
| --- | --- |
| アプリが判定を使い回してよい時間（`ttlSeconds`） | 30秒 |
| StatusHubへ確認できないとき、直前の判定を使い続けてよい上限（`maxStaleSeconds`） | 5分。**超えたら拒否する**（許可を広げない） |
| 利用者が一度も判定できていないとき | 拒否 |
| 5xx・タイムアウト・不正な応答 | 失敗として扱い、上の上限の範囲でだけ直前の判定を使う |
| 取り消しがログイン済み利用者に効くまで | 通常は最大30秒。StatusHubが落ちている間は最大5分 |
| ハートビート | 利用者の操作が無くても5分以内に1回は呼ぶ（反映状況の確認に使う） |

StatusHub自身も同じ基準で動く。取り消しは管理画面からの更新で**同じプロセスのキャッシュを即座に捨てる**ため次のリクエストから、
復旧CLIなど別経路の更新は最大30秒で効く。DBを読めないときは、直前に読めた判定を最大5分だけ使い、一度も読めていないメールは拒否する。

## 反映状況（管理画面「アプリ」タブ）

**StatusHub側だけの推定値**（アプリが申告する版を記録しているだけで、実際に効いているかまでは保証しない）。

| 表示 | 条件 |
| --- | --- |
| 未連携 | 判定APIの呼び出しが一度も無い |
| 反映待ち | 保存した版より、アプリが申告した版が古い |
| 反映済み | 申告した版が保存した版と一致し、直近の呼び出しが成功している |
| 取得失敗 | 直近の呼び出しがエラー（形式不正など）／最終確認から10分以上無応答（最終成功時刻を併記） |

トークンが不正な呼び出しはアプリを特定できないため記録されない（そのアプリは無応答として取得失敗になる）。保存に成功しただけでは反映済みにならない。

## 導入手順（アプリ側）

1. 管理画面「アプリ」→「アプリを登録」でIDと対応する権限を登録し、「トークン発行」を押す。トークンは発行の瞬間に **issue-deckの共有トークン `<アプリID大文字>_ACCESS_APP_TOKEN`**（記号は `_`。例: `YOTEIFLOW_ACCESS_APP_TOKEN`）へ自動で書き込まれる（#504。`ISSUE_DECK_URL`・`SHARED_TOKEN_API_SECRET` を使い、`PUT /api/shared-tokens` で再発行時も上書き）。1Password・`sync-github-secrets.sh`・デプロイは不要。アプリは `GET /api/shared-tokens?name=…`（利用元ヘッダー付き）で読み、`shared-token.ts` と同じく10分キャッシュする
   - 書き込みに失敗したときも発行は成功し、画面に失敗の旨と平文が出る。平文は1回しか出ないので、そのときだけ issue-deck の設定画面から同名で手で登録する
   - **再発行すると古いトークンは即座に失効する**ため、アプリ側のキャッシュが切れるまで（最大10分）判定APIが401になりうる。アプリは判定APIの401で共有トークンのキャッシュを捨てて読み直し、1回だけ再試行する。直前の判定結果の保持は最大5分なので、401のあいだは保持が切れた後に拒否になる点を許容する
   - 失効しても共有トークン側の値は消えない（削除APIが無い）。失効済みの値では判定に通らない。不要なら issue-deck の設定画面で消す
2. アプリのサーバーが認証済み利用者の `sub`・メール・`emailVerified` を検証し、判定APIへ送る。結果を `ttlSeconds` だけキャッシュする
3. 5分以内ごとにハートビートを送り、`appVersion` を `appliedVersion` として申告する
4. 管理画面でそのアプリが「反映済み」になることを確かめてから、旧設定（1Passwordの許可リスト等）を整理する

## 監査履歴

変更者・日時・対象・変更前後を `audit` に残す（管理画面「監査履歴」）。トークンは発行・再発行・失効・共有トークンへの書き込み（`token.shared_write`）の事実だけを残し、値は残さない。

## 復旧

管理者が全員いなくなった・環境名の食い違いで全拒否になった場合は、**ログイン・API・アプリを経由せず**サーバー上でDBを直す
（`scripts/access-recover.mjs`。DBへの書き込み権限を持つアプリ実行ユーザーで実行する）。

```bash
cd <アプリのディレクトリ>
node scripts/access-recover.mjs show                          # DBの環境と管理者の一覧
node scripts/access-recover.mjs add-admin <email>             # 管理者として有効にする（取り消し済みも復活）
node scripts/access-recover.mjs set-environment production    # 環境名の食い違いを直す
```

変更は監査履歴へ `system:recovery` として残り、StatusHubへ最大30秒で効く。DBファイルの退避（バックアップ）は `.data/` の運用に含める。

## 本番反映後の確認

- 管理画面の環境表示が「本番」になっていること（`ACCESS_ENVIRONMENT` が届いている）
- 既存の `ALLOWED_EMAILS` の全員が、管理画面のユーザーに載っていること（欠落・意図しない追加が無いこと）
- 確認済み（2026-10-06・#531）: status-hub・yoteiflow が「反映済み」で最終確認が5分以内／許可した利用者のログイン／復旧CLIの `show` が通常経路と独立して動く
- 確認済み（2026-10-06・#541）: ログイン済み利用者の取り消しが最大反映時間内に status-hub・yoteiflow で効くこと、取り消しが他アプリ（kurashio）のセッションを失効させないこと

## ログイン履歴とログイン通知（#516）

ログイン成功は `login_events`（アクセスDB。直近200件）へ残り、アクセス管理の「ログイン履歴」タブで見られる。同じメールで初めて見る接続元IPは `new_ip`（「新しい接続元」）。
管理者の端末へはWeb Pushで知らせる（`src/lib/login-notify.ts`）。端末ごとに「毎回／新しい接続元のみ／オフ」を通知メニューで選ぶ（既定は毎回）。記録・送信の失敗でログインは止めない。接続元IPは `X-Forwarded-For` の末尾から読む。

### IssueDeck自身のトークン更新（#551）

`ISSUE_DECK_ACCESS_APP_TOKEN`の更新は、通常のBearerに加え、`X-Shared-Token-Write-Authorization: Bearer <SHARED_TOKEN_WRITE_SECRET>`で認証する。専用キーは`op://apps/issue-deck/shared-token-write-secret`を正とし、StatusHubとIssueDeckだけに配備する。共有トークンDB・GET APIには置かず、読み取りキーと共用しない。

未設定・読み取りキーと同じ値のときは、発行前に拒否して旧トークンを保つ。両サーバーとGitHub Secretへ同一の専用キーを配備し、StatusHub送信側→IssueDeck受信側の順で反映する。受信側の専用認証対応が未反映・未設定の間は再発行しない。環境変数の存在検査だけでは相手側の値一致や疎通は保証できないため、配備完了後に正規更新と認証拒否を確認する。
