# status-hub（旧 ops-dashboard）

VPS稼働状況・UptimeRobot・Uptime Kuma監視ダッシュボード。Next.js App Router + Supabase Auth（Google認証）で構成。
経緯は [portfolio issue #65](https://github.com/m-guchi/portfolio/issues/65) を参照。

ログインには Supabase プロジェクト（`db-console`と共通、Google Provider を有効化したもの）が必要。
`.env.local` に `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `ALLOWED_EMAILS` を設定し、
Supabaseダッシュボードの Authentication → URL Configuration の Redirect URLs に
`http://localhost:3000/auth/callback`（本番は `https://<ドメイン>/auth/callback`）を登録すること。

`db-console`と異なり、破壊的操作を持たない読み取り専用の監視表示のみのため、独自DBでのセッション管理（監査ログ・8時間絶対タイムアウト・reauth）は実装せず、Supabase自身が管理するセッション + 共通アクセス設定（許可メール・権限。管理画面 `/admin/access`）の判定のみで認証を完結させている。許可の追加・取り消しは再デプロイ無しで効く。契約・反映時間・復旧手順は [docs/access-control.md](./docs/access-control.md)。各アプリへの導入状況と移行手順は [docs/access-rollout.md](./docs/access-rollout.md)。

## 画面の構成

画面はタブで切り替える。

| タブ | 内容 |
| --- | --- |
| 概要 | 全項目を畳んで1画面に収めたもの。ホストごとの主要4指標、tmuxの稼働・待機、AI/GitHubの残枠、監視の状態タイル |
| ホスト | ホストごとの全指標と推移（Swap・温度・ネットワーク・ディスクI/O・上位プロセス・ディスク内訳） |
| tmux | セッションの一覧。稼働中・待機中・放置の別、実行中コマンド、作業ディレクトリ、最終活動 |
| 利用枠 | 提供元ごとの制限枠と課金、アプリ別のAI利用（使用モデル・呼出回数・トークン・概算金額）、Actionsのリポジトリ別内訳、1Passwordのレート制限 |
| 監視 | Uptime Kuma / UptimeRobot のheartbeatと応答時間 |

選んだタブは端末ごとに `localStorage` へ保存する。
データの取得は共通のプロバイダに一本化している（ホスト30秒・監視60秒・AI/GitHub/1Password 5分）。
狭い画面ではタブが横スクロールになり、tmuxの一覧は表からカードに切り替わる。

ヘッダーの更新ボタンを押すと、この自動取得を待たずにホスト・AI・GitHub・1Password・監視をまとめて取り直す（[issue #29](https://github.com/guchi-apps/status-hub/issues/29)）。
AI・GitHub・1Passwordはサーバー側にもキャッシュ（既定5分）があるため、このボタンからの取得だけ `?force=1` を付けてキャッシュを飛ばし、提供元へ取りにいく。
連打で提供元を叩き続けないよう、押した直後30秒はボタンを押せず、サーバー側も同じ30秒のあいだは `force` でもキャッシュを返す（`src/lib/usage-cache.ts`）。
**AIだけは180秒**（Anthropicの推奨間隔）で、これを下回る `force` にはキャッシュを返す。下回ると429が返り、使用状況のカードがエラー表示に置き換わるため。

**ホストの値はこのボタンでは新しくならない。** ホストのメトリクスは push 型（各ホストのエージェントが1分ごとにPOSTする）で、
ダッシュボード側から取りにいく経路が無く、ボタンで再取得できるのは*エージェントが最後に送ってきた値*までである。
即時に送らせるにはホスト側へ送信を促す経路が別途必要になるため、この画面の範囲では扱わない。

## セットアップ

```bash
npm install
npm run env:init   # .env.local を作成（値を編集）
npm run dev
```

[http://localhost:3000](http://localhost:3000) で確認できる。

### スマホなど同一LAN上の別端末から確認する

Next.js 16 では `next dev` のデフォルトホストが `0.0.0.0` のため、`npm run dev` を実行するだけでLAN内の他端末からアクセスできる状態になる（追加のCLIオプションは不要）。

WSL2はNAT構成のため、Windowsホスト側でWSLへのポートフォワーディングとファイアウォール許可が必要（このマシンでは他プロジェクト用に設定済みのため、通常は以下の確認だけで動く）。

1. WSL側でIPを確認する: `ip addr show eth0 | grep inet`
2. Windows側（PowerShell、管理者権限）でポートフォワーディングを設定・更新する（WSLは再起動のたびにIPが変わるため、変わった場合はここを再実行する）
   ```powershell
   netsh interface portproxy delete v4tov4 listenport=3000 listenaddress=0.0.0.0
   netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=<WSLのIP>
   ```
3. Windowsファイアウォールで TCP 3000 の受信を許可する（他プロジェクトで許可済みなら不要）
   ```powershell
   New-NetFirewallRule -DisplayName "WSL ops-dashboard Dev 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
   ```
4. スマホなど同一Wi-FiにいるほかのデバイスからWindowsのLAN IP（`ipconfig`の「IPv4 アドレス」）にアクセスする: `http://<WindowsのLAN IP>:3000`

**Googleログインを試す場合の注意**: `http://<WindowsのLAN IP>:3000` のように生のIPアドレスのままでは**Googleログインが必ず失敗する**。SupabaseのAuth（GoTrue）は `redirect_to` のホスト名が生のIPアドレスの場合、ループバック（`127.0.0.1`）以外は許可リストの設定に関わらず無条件で拒否する実装になっているため（[internal/utilities/request.go](https://github.com/supabase/auth/blob/master/internal/utilities/request.go)）。

回避策として、[sslip.io](https://sslip.io) のようなワイルドカードDNS（`<IP>.sslip.io` がそのIPに解決される）でIPアドレスをホスト名に変換してアクセスする。

1. Supabaseダッシュボードの Authentication → URL Configuration → Redirect URLs に `http://<WindowsのLAN IP>.sslip.io:3000/auth/callback` を追加登録する（**完全一致のURLのみ登録すること**。`http://<WindowsのLAN IP>.sslip.io:*/**` のようなポート部分をワイルドカードにしたパターンを混ぜると、Redirect URLs許可リスト全体の反映が壊れ、完全一致の行も含めて効かなくなる現象を確認済み）
2. スマホからは `http://<WindowsのLAN IP>:3000` ではなく `http://<WindowsのLAN IP>.sslip.io:3000` でアクセスする

## ホスト（VPS・サブPC）のステータス表示

VPSと自宅LAN内のホスト（サブPC・Mac mini等）について、CPU・メモリ・ディスク等の現在値と直近24時間の推移をホストごとに表示する（[issue #34](https://github.com/guchi-apps/status-hub/issues/34)）。

収集は**すべて push 型に一本化**している。自宅LAN内のホストはNAT配下にいてVPSからポーリングできないため、ホスト側から定期的にPOSTしてもらう必要があり、VPSだけ別方式にすると同じ表示を二重に実装することになるためである。
VPS上ではダッシュボード自身が同じマシンで動いているので、送信先は `http://localhost:3110`（外部を経由しない）。

```
各ホスト（VPS・サブPC・Mac mini等）             ダッシュボード（admin.gucchii.com）
  systemd timer（Linux）/ launchd（macOS）
    └─ scripts/host-stats/agent.sh（Linux）
       scripts/host-stats/agent-macos.sh（macOS）
         /proc・df・systemctl・tmux（Linux） / sysctl・vm_stat・df（macOS）から収集
         → POST /api/host-stats（Bearer HOST_STATS_TOKEN）
                                                 └─ .data/host-stats/<識別子>/latest.json
                                                    .data/host-stats/<識別子>/history.jsonl
                                                    → ダッシュボードがGETしてホストごとに描画
```

ホストは `HOST_STATS_ID` で識別し、保存先はその単位で分かれる。台数が増えてもダッシュボード側の変更は不要で、
エージェントを設置してPOSTが届いた時点でセクションが増える（一度も受信していないホストは表示されない）。

Prometheus + Grafana は、VPSがメモリ2GBでNext.jsを10本抱えている（[deploy/ecosystem.config.js](deploy/ecosystem.config.js) 参照）現状では常駐分だけで数百MBを要して載せられないため採用していない。
履歴はJSONL 1行=1サンプル（1分間隔・24時間で約1,400行）で持ち、グラフはインラインSVGのスパークラインとして描いている（チャートライブラリは追加していない）。

**トレードオフ**: 表示値は最大で送信間隔（既定1分）ぶん古い。またエージェントが止まると値の更新も止まるが、これは OFFLINE 表示で判別できる。

### 表示する項目

| 項目 | 取得元 | 備考 |
| --- | --- | --- |
| CPU使用率 | `/proc/stat` を1秒あけて2回読む | |
| メモリ使用率 | `/proc/meminfo`（MemTotal - MemAvailable） | |
| Swap使用率 | `/proc/meminfo` | SwapTotal が0なら送らず、カードも出ない |
| ディスク使用率 | `df -B1 -P <パス>` | 複数パス指定可。カードとグラフは最も使用率が高い1件、残りは下に一覧で出す |
| Load Average | `/proc/loadavg` | |
| ネットワーク転送量 | `/proc/net/dev` の差分 | `lo` と仮想NIC（docker・veth 等）は除いた合計 |
| ディスクI/O | `/proc/diskstats` の差分 | パーティション・ループバックを除く物理デバイスの合計 |
| 稼働時間 | `/proc/uptime` | |
| CPU温度 | `/sys/class/thermal/thermal_zone*` → 無ければ `/sys/class/hwmon/hwmon*` | 取れないマシンではカードごと省かれる。詳細は下記 |
| CPU上位プロセス | `ps -eo pcpu=,rss=,args= --sort=-pcpu` | 上位5件。カーネルスレッドは除く |
| メモリ上位プロセス | `ps -eo pcpu=,rss=,args= --sort=-rss` | 上位5件。CPU順の一覧には犯人が出てこないメモリ枯渇を捕まえるために別で送る（[issue #54](https://github.com/guchi-apps/status-hub/issues/54)） |
| サービス死活 | `systemctl is-active <名前>` | 指定したサービスをバッジで表示。socket activation されたものは下記の扱い |
| 再起動待ち | `/var/run/reboot-required` の有無 | Debian系のみ |
| 未適用の更新 | `/var/lib/update-notifier/updates-available` | `update-notifier-common` が入っていれば表示される。ESM（有償の延長サポート）分は数えない |
| ログイン中のセッション | `who` | セッション数とユーザー名 |
| アプリ別メモリ | `/proc/<pid>/cwd` と `/proc/<pid>/smaps_rollup` | `HOST_STATS_APPS_ROOT` 配下のディレクトリ単位でPSSを合計。詳細は下記「アプリ別リソース」 |
| アプリ別ディスク | `du -s -B1 -x <アプリのディレクトリ>` | 1時間ごとに測ってキャッシュする。詳細は下記「アプリ別リソース」 |
| tmuxセッション | `tmux -S <ソケット> list-sessions` | セッション名・ウィンドウ数・作成からの経過時間・アタッチ有無をバッジで表示。送るのは20件までだが、切り捨てた分を含む総数も一緒に送る。tmuxが無いホストでは行ごと出ない |
| オフライン判定 | 最終受信からの経過時間 | 既定5分で OFFLINE 表示（値は最後に受信したものを残す） |

差分から求める3項目（CPU・ネットワーク・ディスクI/O）は、前回値をファイルに残さずに済ませるため、1回の実行内で1秒あけて2回読んだ差を使っている。

更新件数は `/usr/lib/update-notifier/apt-check` でも取れるが、1回あたり1.5秒ほどCPUを使う一方で値は1日に数回しか変わらないため、update-notifier が書き出したファイルを読むだけにしている。

**CPU温度は `/sys/class/thermal` だけでは取れないマシンがある**（[issue #101](https://github.com/guchi-apps/status-hub/issues/101)）。
サブPC（AMD Athlon 200GE）では `k10temp` が hwmon にしか登録せず、`/sys/class/thermal` に `thermal_zone*` が1つも無い。
そのため thermal_zone で見つからなければ `/sys/class/hwmon/hwmon*` を見に行く。選び方は次のとおり。

- **`hwmon<番号>` の番号は検出順で、センサーの種類を表さない。** サブPCでは `hwmon1` が内蔵GPU（`amdgpu`）のため、
  必ず `name` を読んでから選ぶ。CPU温度のドライバ（`k10temp`・`zenpower`・`coretemp` → `cpu_thermal` 系 → `acpitz`）の
  優先順で1つだけ拾い、該当が無ければ温度を送らない（GPUやNVMeの温度で代用しない）
- 選んだディレクトリの中では `temp*_label` が `Tctl` / `Tdie` / `Package id 0` の入力を優先する。
  `coretemp` はコアごとの入力も持つため、ラベルを見ないとパッケージ温度を選べない

センサーの構成はマシンごとに違うため、`for d in /sys/class/hwmon/hwmon*; do echo "$d $(cat "$d/name")"; done` で確認できる。

グラフに残す履歴はCPU・メモリ・ディスク・Load・Swap・温度・ネットワーク・ディスクI/Oで、24時間を超えた行は送信のたびに掃除する。
1,440点をそのまま返すとレスポンスが太るため、APIは最大180点へ間引いてから返す。

### アプリ別リソース

ホストタブの指標カードの下に、アプリごとのメモリ・ディスク使用量を横棒で出す（[issue #226](https://github.com/guchi-apps/status-hub/issues/226)）。
エージェントの `HOST_STATS_APPS_ROOT`（VPSは `/home/github-user/apps`）を設定したホストだけが送り、未設定のホストや古いエージェントからは項目ごと届かないためパネルも出ない。
現在値だけを持ち、履歴には残さない。

- **メモリはプロセス名ではなく作業ディレクトリで振り分ける。** 「メモリ上位」の一覧は `next-server` や `node` が並ぶだけでどのアプリか読めず、PM2 に聞く方法では user systemd で動く signaly・vps-status-api が漏れるため。`/proc/<pid>/cwd` が `HOST_STATS_APPS_ROOT/<アプリ>/…` にあるプロセスのメモリを合計する。cwd を別の場所にして起動しているプロセスは「アプリ以外」に入る
- **足し上げるのは RSS ではなく PSS（`smaps_rollup` の `Pss`）。** RSS は共有ライブラリなどのページをプロセスの数だけ重複して数え、Node のプロセスでは実測で RSS 211MB に対し PSS 108MB と約2倍に膨らむ。RSS の合計ではホスト全体の使用量（MemTotal − MemAvailable）を超え、「使用量 − アプリ合計」で出す「アプリ以外」が負になる。`smaps_rollup` は root でないと他ユーザーのプロセス分を読めないため、読めないときだけ RSS で代用する（内訳バーは使用量で頭打ちにしている）
- **ディスクは1時間ごとにしか測らない。** `du` は node_modules まで辿るため毎分は重く、値もそう変わらない。測った結果はユニットの `StateDirectory=` が用意する `/var/lib/ops-dashboard-host-stats/app-disk.tsv` にキャッシュし、間隔は `HOST_STATS_APP_DISK_INTERVAL`（既定3600秒）で変えられる。**キャッシュを書けない古いユニットのままだと、ディスクは測らずメモリだけを送る**（毎分 `du` を走らせないため）
- 横棒の長さは最大のアプリを基準にしている。1アプリはホスト全体の数%にしかならず、全体を分母にすると差が読めないため。全体に対する割合は右端の％で出す

既に設置済みのホストで有効にするには、`agent.sh` とユニットファイルを配り直し、`/etc/ops-dashboard-host-stats.env` に `HOST_STATS_APPS_ROOT` を追記する（手順は下記「tmuxセッション一覧」末尾の配り直しと同じ）。

### tmuxセッション一覧

サブPCはClaude Codeの作業セッションを常駐させるホストで、リポジトリをまたいだセッションが同じ `tmux ls` に並ぶ（セッション名は issue-deck 側で `<リポジトリ名>-issue-<番号>` に統一している）。
いま何が動いているかが見えないと二重起動や放置セッションに気づけないため、ホストのメトリクスと一緒に送っている（[issue #38](https://github.com/guchi-apps/status-hub/issues/38)）。

送信は20件で打ち切るが、**総数は切り捨てる前の実数を別に送る**（[issue #54](https://github.com/guchi-apps/status-hub/issues/54)）。
一覧の長さで総数を数えると、上限に張り付いた時点で「セッションが積み上がっている」という兆候そのものが画面から消えるため。
2026-08-14にサブPCが34セッションまで積み上がってメモリ枯渇で停止した際、画面には20件しか出ておらず、直前まで異常を読み取れなかった。

状態は各ペインの実行コマンドから判定する（[issue #40](https://github.com/guchi-apps/status-hub/issues/40)）。
デタッチしたまま裏でclaudeが走っているのが普通の使い方で、アタッチの有無では「いま作業が動いているか」を判断できないため。

| 状態 | 判定 |
| --- | --- |
| 稼働中 | シェル（bash・zsh等）以外のコマンドが動いていて、画面も動いている |
| 入力待ち | フックの最後のイベントが `permission_prompt`（承認・質問で人を待っている）、または画面が60秒以上 止まっている |
| 待機中 | シェルだけで止まっている |
| 放置 | デタッチのまま24時間以上 活動がない |

**入力待ちはフックの記録を第一の根拠にする**（[issue #45](https://github.com/guchi-apps/status-hub/issues/45)）。`permission_prompt` が最後なら、承認プロンプトや質問を出したまま人を待っていることが**確定している**ので、画面の動きから推し量る必要がない。

issue-deck の `session-notify.sh` が記録するイベントは3種類だけで、意味はそれぞれ違う（[issue #72](https://github.com/guchi-apps/status-hub/issues/72)）。

| イベント | 意味 | 入力待ちか |
| --- | --- | --- |
| `permission_prompt` | 承認プロンプト・質問を出して人を待っている | 確定でそう |
| `working` | **人が答えて作業へ戻った** | 違う（＝動いている） |
| `Stop` | 応答の終了。直後に次の作業へ入っていることもある | 断定しない |

**`permission_prompt` 以外は入力待ちに数えず、画面の動きで判断する。** 知らない名前を「人を待っている」と読むと、issue-deck 側がイベントを増やしたときに動いているセッションまで入力待ちへ倒れる（`working` の追加で実際にそうなった）。

画面が止まっているかどうかは、フックが届かないセッション（手で立てたもの）と、`working` / `Stop` で止まっているセッションのための代替手段。出力の無いビルドを「入力待ち」と誤判定する、スピナーが回っているだけのセッションを「稼働中」と読み続ける、といった外し方をするため、あくまで補助として使う。

**「画面が動いているか」に使うのは `#{window_activity}` で、`#{session_activity}` ではない**（[issue #72](https://github.com/guchi-apps/status-hub/issues/72)）。`session_activity` が更新されるのはクライアントの操作（アタッチ・キー入力）で、**ペインの出力では動かない**。デタッチしたまま裏で claude が走っているのが常態のこのホストでは、`session_activity` が `session_created` のまま何時間も止まり、スピナーが回り続けているセッションまで「60秒以上 画面が止まっている」と読まれていた（結果、ほぼ全セッションが入力待ちになる）。窓側の活動時刻はペインの出力で更新されるため、そちらとの新しい方を最終活動として送っている。

窓の活動時刻でも取りこぼす場合が1つある。**ペインを上へスクロールしたままのセッションは、claude が動いていても画面が描き変わらない**（新しい行が見えていないため）。この状態では出力が止まって見えるので、フックのイベントが無ければ60秒後に入力待ちへ倒れる。

`commands` / `busy` / `path` / `lastActivityAt` はいずれも任意の項目のため、エージェントを更新していないホストからのレポートもそのまま受け取れる（その場合はアタッチの有無で稼働中を判定する）。

#### 残す理由（[issue #59](https://github.com/guchi-apps/status-hub/issues/59)）

issue-deck の回収スクリプトは毎分すべてのセッションを判定して「畳まない理由」を持っているが、届くのは journald だけで、しかも**同じ理由が続く間は出力されない**（同じ行でjournaldが埋まるのを防ぐため）。放置なのか正当に待っているのかが画面から区別できなかった。

そこでエージェントが issue-deck の状態ファイル（`~/.local/state/issue-deck/sessions/`）を読み、一緒に送っている。

| 項目 | 出どころ |
| --- | --- |
| `holdReason` | `<セッション名>.reason` |
| `holdReasonAt` | 同ファイルの mtime |
| `lastEventName` / `lastEventAt` | `<セッション名>.event` |
| `issueRepository` / `issueNumber` | `<セッション名>.session` |

`holdReasonAt` は**「その理由になった時刻」であって「最後に判定した時刻」ではない**。回収は理由が変わったときだけ記録を書き直すため、同じ理由が10時間続いていれば mtime も10時間前になる。回収そのものが動いているかの判定には使えない。

理由が付くのは回収の判定に乗ったセッションだけ（記述子があり `reapable=1`）で、手で立てたセッションには何も出ない。置き場は `HOST_STATS_SESSION_STATE_SUBDIR` で変えられる。

**セッション名は検査してからパスに繋いでいる。** 名前はtmuxから読んだ値がそのまま来ており、`../` を含む名前を通すと状態ファイル以外を読みに行けるため（規則は issue-deck の `session_state_name_ok` と同じ）。

収集にあたっては次の3点に制約がある。

- tmuxのソケットはユーザーごとに `/tmp/tmux-<UID>/` にあり、root で `tmux ls` を叩いても root 自身のサーバーしか見えない。そのためソケットを列挙して `tmux -S <ソケット>` で個別に問い合わせている（ディレクトリは 0700 だが root は読める）
- そのため `ops-dashboard-host-stats.service` は `PrivateTmp=no` にしてある。`PrivateTmp=yes` だとサービス専用の空の `/tmp` が見えるだけで、セッションを1件も拾えない。`ProtectSystem=strict` により `/tmp` は読み取り専用のままなので、書き込みはできない
- 後述の「残す理由」はユーザーのホーム配下を読むため、`ProtectHome=read-only` にしてある（[issue #65](https://github.com/guchi-apps/status-hub/issues/65)）。`yes` だと `/home` が空に見え、理由を1件も拾えない。**設置手順の `--print` はサンドボックスの外で走るため手では読めてしまい、timer 経由だけ空になる**という気づきにくい壊れ方をする

**既にエージェントを設置済みのホストでは、`agent.sh` と一緒にユニットファイルも配り直すこと**（`PrivateTmp` や `ProtectHome` の変更が効かないと、tmux の行や残す理由が出ない）。

```bash
sudo cp "$SRC/agent.sh" /opt/ops-dashboard-host-stats/
sudo cp "$SRC"/ops-dashboard-host-stats.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start ops-dashboard-host-stats.service
```

拾えるのは既定のソケット（`/tmp/tmux-<UID>/*`）にあるセッションだけで、`tmux -S <別のパス>` で作った独自ソケットのセッションは対象外。
ソケットの置き場所を変えているホストでは `HOST_STATS_TMUX_SOCKET_ROOT` で探索先を指定する。

### tmuxセッションを閉じる（[issue #409](https://github.com/guchi-apps/status-hub/issues/409)）

tmuxタブの各行の「閉じる」から、そのセッションを終了できる。確認を挟んだうえで `tmux kill-session` を実行する。

ダッシュボードはホストから受け取るだけで、ホストへ指示を送る経路が無い（サブPCはNAT配下）。そのため依頼をキューに積み、
エージェントが毎分のPOSTの応答（`closeSessions`）で受け取って実行する。**押してから消えるまで最大1分ほどかかる。**

- `POST /api/tmux-close`（`{ hostId, user, name }`）はログインセッションでだけ受け付ける。`OPS_API_TOKEN` では通さない
- 受け付けるのは、直近の受信に載っているセッションと完全に一致するものだけ。依頼は `.data/host-stats/<識別子>/close-requests.json` に3分間だけ残る
- 完了の報告は受けない。次の受信でそのセッションが一覧から消えていれば完了とみなす。3分たっても残っていれば、画面に「閉じられませんでした」と出る
- **エージェントはrootで動く。** 受け取った名前は、名前として許す文字（英数字・`.`・`_`・`-`。先頭は英数字か`_`）に合うものだけを拾い、そのユーザーのソケットに実在するセッションだけを `=名前` の完全一致で閉じる
- 持ち主（`user`）を送ってこない古いエージェントのセッションには、ボタンを出さない
- **既にエージェントを設置済みのホストは `agent.sh` を配り直すこと。** 配り直すまで、押しても閉じない（依頼は期限で捨てられる）

### ダッシュボード側の設定

`HOST_STATS_TOKEN` を設定するだけでよい（未設定の場合、受信は常に401になる）。
本番では1Passwordの `apps/ops-dashboard` アイテムに `host-stats-token` フィールドを追加しておく（未作成のままだとデプロイのシークレット読み込みが失敗する）。

並び順は `HOST_STATS_ORDER`（識別子をカンマ区切り。既定・デプロイ時の指定とも `vps,subpc,macmini,pi0w`。概要とホスト一覧で共通）、オフライン判定のしきい値と履歴の長さは `HOST_STATS_OFFLINE_AFTER_SECONDS` / `HOST_STATS_HISTORY_HOURS` で変えられる。

定期ジョブの通知を出すには `SIGNALY_ALERT_WEBHOOK_URL` を設定する（未設定なら画面表示だけが動き、通知は出ない）。1Passwordの `apps/ops-dashboard` アイテムの `alert-webhook-url` フィールドが正。判定のしきい値は `HOST_STATS_TIMER_GRACE_SECONDS`（既定3600）と `HOST_STATS_TIMER_FAILURE_THRESHOLD`（既定1）で変えられる。

### 各ホストへのエージェント設置

`scripts/host-stats/` の3ファイルを配置する。エージェントはbashとcurlだけで動き、常駐しない（1分ごとに起動して終了する短命プロセス）。VPS・サブPCとも手順は同じで、設定ファイルの中身だけが違う。

**VPSでは管理者アカウントで作業すること。** デプロイ先（`~/apps/admin`）の所有者である `github-user` は
sudo が `apply.sh` のみに制限されており、`/opt` や `/etc` への配置ができない。
ファイルの読み取りは root で行われるため、配置元にデプロイ先のパスをそのまま指定してよい。

```bash
# VPSの場合。デプロイ先から配る（サブPCではリポジトリをcloneした場所を指す）
SRC=/home/github-user/apps/admin/scripts/host-stats

# 1. エージェントを配置する
sudo mkdir -p /opt/ops-dashboard-host-stats
sudo cp "$SRC/agent.sh" /opt/ops-dashboard-host-stats/
sudo chmod 755 /opt/ops-dashboard-host-stats/agent.sh

# 2. 設定ファイルを新規に作る（トークンを含むため 600 / root 所有にする）
#    VPS なら host-stats.vps.env.example、サブPC なら host-stats.subpc.env.example を使う
sudo cp "$SRC/host-stats.vps.env.example" /etc/ops-dashboard-host-stats.env
sudo chmod 600 /etc/ops-dashboard-host-stats.env
# エディタを開く行なので、ここまでをまとめて貼り付けないこと
# （後続の行が vi への入力として流し込まれ、設定ファイルが壊れる）
sudo vi /etc/ops-dashboard-host-stats.env   # HOST_STATS_TOKEN を記入（他の項目は雛形のままでよい）

# 3. 送信されるJSONを確認する（送信はしない）
#    設定ファイルは600/root所有のため、読み込みごとrootで行う
sudo bash -c 'set -a; . /etc/ops-dashboard-host-stats.env; set +a; /opt/ops-dashboard-host-stats/agent.sh --print'

# 4. systemd timer を有効化する
sudo cp "$SRC"/ops-dashboard-host-stats.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ops-dashboard-host-stats.timer

# 5. 1回手動で走らせて結果を見る
sudo systemctl start ops-dashboard-host-stats.service
systemctl status ops-dashboard-host-stats.service
```

Pi Zero W（自宅LANのSwitchBot取得機）は `host-stats.pi0w.env.example` を使い、センサーごとの取得状況も送る。
Piはこのリポジトリを持たないため、サブPCからSSHで配る。手順と判定は [docs/pi0w-host-stats.md](docs/pi0w-host-stats.md)。

`/etc/ops-dashboard-host-stats.env` は各ホストで新規に作るファイルで、Gitでもデプロイでも管理していない。
アプリ本体の `.env`（デプロイのたびに書き換わり、全シークレットを含む）とは意図的に分けている。

### macOS（Mac mini）への設置

macOSには `/proc`・`systemctl`・`/sys/class/*` が無く、`agent.sh` はそのままでは動かない。macOS向けには
`scripts/host-stats/agent-macos.sh` を使う。送信先のペイロード形式（`HostStatsReport`）は共通のため、
ダッシュボード側の実装・カードの表示は変更していない。

| 項目 | agent.sh（Linux） | agent-macos.sh（macOS） |
| --- | --- | --- |
| CPU使用率 | `/proc/stat` | `top -l 2 -n 0`（2回サンプリングし、信頼できる2回目の値を使う） |
| CPU機種名・スレッド数 | `/proc/cpuinfo` の `model name` と `nproc` | `sysctl machdep.cpu.brand_string` と `hw.ncpu`。ホストタブのCPUカードの補足行に出る（#419）。送らない世代のエージェントでは何も出ない |
| メモリ使用率 | `/proc/meminfo` | `vm_stat` + `sysctl hw.memsize`（Activity Monitorの「使用中のメモリ」に合わせ、アクティブ+Wired+圧縮の合計） |
| Swap使用率 | `/proc/meminfo` | `sysctl vm.swapusage`。使っていなければ送らない |
| ディスク使用率 | `df -B1 -P` | `df -k` |
| Load Average | `/proc/loadavg` | `sysctl vm.loadavg` |
| 稼働時間 | `/proc/uptime` | `sysctl kern.boottime` と現在時刻の差 |
| ログイン中のセッション | `who` | `who`（共通） |

**温度・サービス死活・定期ジョブ・アプリ別リソース・tmuxセッションはmacOS版では送らない。** いずれもペイロード上は
任意項目で、送らなければそのホストにはその項目・カードが出ないだけで受信自体は失敗しない（「表示する項目」参照）。
必要になれば別途対応する。

設置はVPS・サブPCと同じ3ファイル構成だが、systemd の代わりに launchd を使う。

```bash
SRC=<agent-macos.sh・host-stats.macmini.env.example・plistを置いた場所>

# 1. エージェントを配置する
sudo mkdir -p /opt/ops-dashboard-host-stats
sudo cp "$SRC/agent-macos.sh" /opt/ops-dashboard-host-stats/
sudo chmod 755 /opt/ops-dashboard-host-stats/agent-macos.sh

# 2. 設定ファイルを新規に作る（トークンを含むため 600 / root 所有にする）
sudo cp "$SRC/host-stats.macmini.env.example" /etc/ops-dashboard-host-stats.env
sudo chmod 600 /etc/ops-dashboard-host-stats.env
# エディタを開く行なので、ここまでをまとめて貼り付けないこと
sudo vi /etc/ops-dashboard-host-stats.env   # HOST_STATS_TOKEN を記入（他の項目は雛形のままでよい）

# 3. 送信されるJSONを確認する（送信はしない）
sudo bash -c 'set -a; . /etc/ops-dashboard-host-stats.env; set +a; /opt/ops-dashboard-host-stats/agent-macos.sh --print'

# 4. launchdへ登録する（起動直後に1回、以降は60秒ごと）
sudo cp "$SRC/com.gucchii.ops-dashboard-host-stats.plist" /Library/LaunchDaemons/
sudo launchctl load -w /Library/LaunchDaemons/com.gucchii.ops-dashboard-host-stats.plist

# 5. ログを確認する（エラーはここに出る。journalctlに相当するものが無いためファイルへ出している）
tail -f /var/log/ops-dashboard-host-stats.log
```

`HOST_STATS_TOKEN` はVPS・サブPCと共通の値（1Passwordの `apps/ops-dashboard/host-stats-token`）を使う。
ホストが増えてもトークンは共通で、`HOST_STATS_ID` によって保存先だけが分かれる。

設定を配り直すときは、`launchctl unload` してから1〜4をやり直す
（`launchctl load` は多重登録を防がないため、登録済みのまま重ねて `load` しない）。

### 監視するサービスの選び方

`HOST_STATS_SERVICES` に書くのは表示用の名前ではなく、そのホストに実在する systemd ユニット名で、
`systemctl is-active <名前>` にそのまま渡る（存在しない名前を書くと、常に `inactive` の赤バッジが出るだけ）。
候補は `systemctl list-units --type=service --state=running` で確認する。

**socket activation されたサービス（Ubuntu 24.04 の `ssh` など）は `.service` のままでよい。**
この種のサービスは接続が来るまで `.service` が inactive で、待ち受けは `.socket` が持つ。エージェントは
`inactive` のとき起動元（`TriggeredBy`）の `.socket`・`.path` を見にいき、それが active なら
`listening` として送るため、稼働中（緑バッジ）になる。`.socket` の側を書く必要はない
（[issue #187](https://github.com/guchi-apps/status-hub/issues/187)）。なお `failed` は待ち受けの
有無に関わらず `failed` のまま送る。

タイマー起動の oneshot はこの対象外で、`inactive` のまま送る。実行していない間を稼働中にすると
前回の実行結果を見ずに緑になってしまうためで、定期ジョブは下記の「定期ジョブ」として別に送っている。

**Uptime Kuma の HTTP 監視と重複しないものだけを選ぶ**方針にしている。Uptime Kuma は「外から応答があるか」、
systemd は「そのホストでプロセスが動いているか」を見るもので、HTTPの口を持たないもの（cron・fail2ban・DB）は
後者でしか分からない。逆に、各Next.jsアプリや signaly のようにUptime Kumaが直接見ているものを入れても重複にしかならない。
選定結果は `scripts/host-stats/host-stats.*.env.example` に理由つきで書いてある。

なお次の2つは user systemd（`github-user`）で動いており、rootの `systemctl` からは見えないため、
エージェントではなく Uptime Kuma 側にHTTPモニターとして追加する。トークン認証で401が返る場合は、
Kumaの Accepted Status Codes に `401` を足せば「起動していればup・落ちていれば接続不能でdown」を判定できる。

| サービス | エンドポイント |
| --- | --- |
| `vps-status-api` | `https://gucchii.com/internal/vps-status` |
| `uptime-kuma-backup-receiver` | `https://gucchii.com/internal/uptime-kuma-backup` |

送信間隔を変えるときは `ops-dashboard-host-stats.timer` の `OnUnitActiveSec` を変更する。
間隔を `HOST_STATS_OFFLINE_AFTER_SECONDS`（既定300秒）より長くすると常時OFFLINE表示になるため、合わせて調整すること。

### 定期ジョブ（systemd timer）の監視と通知

[issue #75](https://github.com/guchi-apps/status-hub/issues/75)。`HOST_STATS_SERVICES` とは別枠で、
`HOST_STATS_TIMERS` に監視したいタイマーをカンマ区切りで書く。`.timer` は省略してよい。

```
HOST_STATS_TIMERS=guchi@aide-zaim-sync,guchi@aide-zaim-keep-alive
```

**`systemctl is-active` では定期ジョブを見られないため、別の仕組みにしてある。** `Type=oneshot` の
ジョブは実行していない間ずっと `inactive` で、それが正常な状態でもある。成功して終わったのか
失敗して終わったのかを区別できない。そこでタイマー側から「最後の発火と次回予定」を、
`.service` 側から `Result` / `ExecMainStatus` / `ExecMainExitTimestamp` を読み、両方を送っている。

**`<ユーザー>@` を前置すると、ユーザー単位のユニット**（`~/.config/systemd/user/`）を指す。
エージェントは root で動くため `systemctl --user` をそのまま呼べず、
`systemctl --machine=<ユーザー>@.host --user` で当該ユーザーのマネージャに問い合わせる。
`machinectl` / `systemd-container` は入っていなくてよい（同一ホストの `<ユーザー>@.host` は
`/run/user/<UID>/bus` へ直接繋ぐだけ）。`ProtectHome=read-only` のままでも繋がる
（読み取り専用マウントが弾くのは通常ファイル・ディレクトリ・シンボリックリンクへの書き込みで、
ソケットへの `connect` は妨げられない）。**`Linger=yes`**（`loginctl show-user <ユーザー>`）で
ユーザーマネージャが常駐していることが前提。

収集にあたっては `systemctl` の癖が2つある。

- **存在しないユニットでも `systemctl show` は `Result=success` / `ExecMainStatus=0` を返す。**
  終了ステータスも0なので、コマンドの成否では区別できない。`LoadState` を併せて取り、
  `loaded` のときだけ実行結果を読む（1行も返らないのは、問い合わせ自体に失敗したとき）
- **`NextElapseUSecRealtime` が入るのは `OnCalendar` のタイマーだけ。** `OnUnitActiveSec` などの
  単調時計のタイマーでは空になり、`NextElapseUSecMonotonic` は `5d 20h 47min` のような
  人間向けの経過時間でそのままでは使えない。`systemctl list-timers --all -o json` の `next` は
  どちらのタイマーでも epoch マイクロ秒で返るため、空のときはそこから補っている
  （`--timestamp=unix` は `ExecMainExitTimestamp` には効くが、この2つには効かない）

問い合わせ自体に失敗したユニットは `available: false` として送り、画面では「取得できず」（黄）に
なる。**このとき通知は出さない。** 取得できていないものを異常として鳴らすと誤検知になるため、
「ジョブが壊れている」と「状態が分からない」を分けている。

**設置後の確認に `--print` を使わないこと。** `--print` はサンドボックスの外で走るため、
timer 経由では読めないユニットでも手では読めてしまう（tmux で同じ壊れ方をした前例が
[issue #65](https://github.com/guchi-apps/status-hub/issues/65)）。
`sudo systemctl start ops-dashboard-host-stats.service` で1回走らせ、画面に「取得できず」が
出ていないかで確かめる。

ダッシュボード側は受信のたびに判定し、次のいずれかを異常として扱う。

| 状態 | 条件 |
| --- | --- |
| 失敗 | 直近の実行の `Result` が `success` 以外 |
| 未実行 | 次回予定を `HOST_STATS_TIMER_GRACE_SECONDS`（既定3600秒）過ぎても発火していない |
| タイマー停止 | タイマーが `inactive`、または `masked` |
| ユニットが無い | `LoadState` が `loaded` でない |

**「失敗していない壊れ方」を拾うのが目的の半分**なので、失敗だけでなく未実行・停止・消失も見る。
タイマーを止めた場合は失敗ログが1行も出ないまま静かに止まるため、失敗より気づきにくい。

**通知は状態が変わったときだけ送る。** 毎時のジョブが1日壊れれば24回失敗し、エージェントは毎分
同じ状態を送ってくる。そのまま流すと通知が無視されるようになるため、最後に通知した状態を
`.data/host-stats/<識別子>/timer-alerts.json` に持ち、異常になったときに1回・復旧したときに1回だけ
鳴らす。この置き場はデプロイの削除対象に入らないので、再デプロイで鳴り直すことはない。

`HOST_STATS_TIMER_FAILURE_THRESHOLD` を上げると、その回数だけ続けて失敗するまで通知を待つ。
**数えるのは受信回数ではなく実行回数**（`ExecMainExitTimestamp` が変わった回数）で、
同じ失敗を毎分受け取ってもしきい値は進まない。

### ホスト停止・再起動のPush通知と未解消エラー件数（[issue #495](https://github.com/guchi-apps/status-hub/issues/495)）

受信が既定5分途絶えたホスト（停止疑い）・再開・再起動を、画面を閉じていてもPWAへPush通知する。ホーム画面アイコンには
未解消エラー件数（ホスト停止・サービス停止・定期ジョブ異常・サイトDOWN）をバッジで出す。判定はVPSのプロセス内で30秒ごと。
仕組み・対象・制約・本番反映と実機確認の手順は [docs/host-incident-alerts.md](./docs/host-incident-alerts.md)。

### 受信APIの仕様

```
POST /api/host-stats
Authorization: Bearer <HOST_STATS_TOKEN>
Content-Type: application/json
```

| コード | 条件 |
| --- | --- |
| 200 | 受信・保存に成功（`{"ok":true,"receivedAt":"..."}` を返す） |
| 400 | JSONとして読めない、必須項目が欠けている、`version` が非対応、`id` が使えない文字を含む |
| 401 | `Authorization` が一致しない、または `HOST_STATS_TOKEN` 未設定 |
| 413 | ペイロードが32KBを超えている |

ペイロードの形式は `src/types/host-stats.ts` の `HostStatsReport`。`version` で世代を管理しており、
エージェント側を非互換に変える場合は `HOST_STATS_PAYLOAD_VERSION`（`src/lib/host-stats/report.ts`）を上げる。
`id` は保存先のディレクトリ名になるため、英小文字・数字・ハイフン・アンダースコアのみ受け付ける。
ダッシュボードからの取得（GET）は通常どおりログインセッションで認証する。

## AI使用状況の表示

Claude / ChatGPT のトークン使用状況と課金プランをダッシュボードに表示する。

いずれの提供元も「サブスクリプション（Max / Plus 等）の残枠」を返す公開APIを用意していないため、
各CLIが内部的に使っている非公開のエンドポイントを、VPS側に保管したOAuthトークンで叩いている。
**公式に文書化されたAPIではないため、提供元の仕様変更で取得できなくなる可能性がある**点に注意する。

| 提供元 | 取得元 | 表示できるもの |
| --- | --- | --- |
| TypeSafe AI | TYPESAFE_USAGE_URL で指定した呼出元の集計API | 直近24時間・7日間の入力トークン数、呼出回数、入力単価ベースの概算金額 |
| Claude | `GET https://api.anthropic.com/api/oauth/usage` と `/api/oauth/profile`（Claude Code の `/usage` と同じ） | 5時間・週間の使用率とリセット時刻、追加利用クレジットの課金額、プラン名（`rate_limit_tier` から判定） |
| ChatGPT | `GET https://chatgpt.com/backend-api/wham/usage`（Codex CLI の `/status` と同じ） | 5時間・週間の使用率とリセット時刻、プラン名（APIが返す `plan_type`） |

プラン名はどちらもAPIから自動取得するため設定不要。`CLAUDE_PLAN_NAME` / `CHATGPT_PLAN_NAME` を設定した場合のみ、表示名の上書きとして使われる。

TypeSafeの公開APIはアカウントの残高・無料枠を返さず、POST /v1/systemone の応答にその呼び出しのトークン数だけを返す。そのため、TypeSafeを呼ぶアプリが集計したAPIを `TYPESAFE_USAGE_URL` に、同APIのBearerには issue-deck の共有トークン `OPS_API_TOKEN` を使う（環境変数では持たない。#610）。`TYPESAFE_USAGE_URL` が未設定、またはトークンを取得できなければカードは表示しない。表示する金額は入力単価 `$0.042 / 100万トークン` を使った概算で、請求額そのものではない。

**Jevのクレジット枠**（[#426](https://github.com/guchi-apps/status-hub/issues/426)）: 購入したクレジットを消費する形をClaudeのクレジット枠と同じ見た目で出す。TypeSafeにも連携先の集計APIにも残高・購入額を返す項目は無いため、Claudeと同じく画面の「購入・残高を記録」から購入と補正残高を登録し（`.data/typesafe-credit-ledger.json`。`TYPESAFE_CREDIT_LEDGER_PATH` で変更可）、そこから消費を差し引いて残高を推定する。消費額は連携先の応答に**任意の `totalInputTokens`（集計開始からの累計入力トークン）** が含まれるときだけ積む（直近24時間・7日間のローリング値からは累計を作れないため）。含まれない間は「使用額は累計待ち」と表示し、残高は補正値＋その後の購入のままになる。

### アプリ別のAI利用

「どのアプリが、どのモデルで、どれくらいAIを使っているか」を、上の提供元別の利用枠とは別の軸で出す
（[issue #325](https://github.com/guchi-apps/status-hub/issues/325)）。利用枠タブの、AI Usageの下の区画で、
24時間・7日間を切り替え、アプリの行を開くと機能ごと×モデルごとの内訳が出る。

**各アプリが使用量APIを持ち、ダッシュボードのサーバーがそれを読みにいく**（TypeSafe・AIDEと同じ向き）。
アプリ側から送りつける形にはしていないため、ダッシュボードは使用量を保存せず、見えるのは各アプリが
いま持っている直近24時間・7日間の集計だけになる。連携先は「アプリ別のAI利用」の
**連携先を管理**から追加・編集・削除し、`.data/ai-app-usage-sources.json` に保存する。各アプリへは
`Authorization: Bearer <OPS_API_TOKEN>` を付けてGETする（連携先は同じ値で検証する）。
`url` は `gucchii.com` 配下（と環境変数 `AI_APP_USAGE_ALLOWED_HOSTS` で足したホスト。カンマ区切りで、`example.com` は完全一致・`*.example.com` はサブドメイン）の https か、同じホスト内のループバックの http だけを受け付ける。トークンを平文で・無関係なホストへ送らないため（#465）。保存時と読み込み時の両方で検証する。
以前の `AI_APP_USAGE_SOURCES` は初回起動時の移行元としてだけ読み、移行後は使わない。
旧値が不正で読み取れない場合はサーバーログに理由を残し、空の一覧で初期化するため、画面から連携先を登録し直す。

連携先の応答の形（`src/lib/ai-app-usage/parse.ts` が検証する）:

```json
{ "features": [
  { "label": "チャット", "model": "claude-opus-5",
    "last24h": { "calls": 96, "inputTokens": 1420000, "outputTokens": 61000,
                 "cacheReadTokens": 0, "cacheWriteTokens": 0 },
    "last7d": { "calls": 612, "inputTokens": 9100000, "outputTokens": 402000 } } ] }
```

- 機能×モデルごとに1行。同じ機能でモデルを切り替えていれば2行に分ける
- `inputTokens` `outputTokens` `cacheReadTokens` `cacheWriteTokens` は省略できる。省略した入力・出力トークンは「数えていない」（画面では「—」）。**省略したキャッシュは「不明」として扱い、金額は0として計算し、画面に「キャッシュ未集計の可能性」と注記する**。**入力を省略した行は金額も「—」**（トークンを持たないCodex CLI経由のアプリ向け。research-deskはこの形で `calls` だけを返す想定。`calls` は必須）
- `inputTokens` は**キャッシュに載らなかった分**。画面の入力トークンはキャッシュの書き込み・読み出しを足した合計で出す
- `features` が空なのは「取得できたが呼び出しが無かった」で、エラーではない
- **1行でも形が違えば応答全体を採用せず**、そのアプリは「取得不可」（`応答の形式が想定と異なります`）になる。
  一部の行だけを捨てると、合計が黙って少なく出るため

金額はダッシュボード側の単価表（`src/lib/ai-app-usage/models.ts`）で換算した概算で、請求額そのものではない。
**単価表に無いモデルは名前だけを出して金額は「不明」にする**（近いモデルの単価で推測しない）。
モデルを増やしたら、単価表にも足す。日付付きのID（`claude-haiku-4-5-20251001`）は一覧のIDへ寄せて数える。
**使わなくなったモデルの行は消さない**（期間の途中でモデルを切り替えたアプリは、行ごとに自分のモデルの単価で換算するため。#418）。
GPT-5.6系（aide-botがCodex CLI経由で使う）はChatGPTの定額枠で請求が発生しないが、公開API単価での「換算の目安」として金額を出す。
その単価は第三者サイトの値で、キャッシュの単価は仮定（`models.ts` のコメント参照）。公式の値が分かったら直す。

- 取得できなかったアプリは「取得不可」と理由（`HTTP 500`・`接続できません`など。URLやトークンは含めない）を出し、
  合計には含めない。0件と区別するため
- 連携先が未設定でも管理画面を出し、そこから追加できる。設定ファイルが壊れているときは、使用量を出さずサーバーのログに理由が出る
- **issue-deckだけは使用量APIを待たずに出る。** 既存のTypeSafe連携（`TYPESAFE_USAGE_URL`）の取得結果を
  issue-deckの行（モデル `Jev`）として使う。連携先に `issue-deck` を入れた時点で、
  そちらが正になり、TypeSafeからの補完は止まる（Jevの分が二重に数えられないため）
- キャッシュは5分（失敗したアプリがあるときは30秒）。ヘッダーの更新ボタンからの取得（`?force=1`）は30秒の間隔を守る

#### AIの用途一覧（[issue #415](https://github.com/guchi-apps/status-hub/issues/415)）

アプリ別の表は使用量APIを持つアプリしか出ないため、その下に「AIを使っている用途」の一覧を出し、数えられていないものを見つけられるようにする。
用途は `src/lib/ai-app-usage/purposes.ts` の `AI_PURPOSES` に**手で登録する**（他リポジトリのソースは実行時に読めない）。
**AIを呼ぶ機能をどのアプリに足しても、ここへ足す。**

- 計測中 — 取得結果（スナップショット）にアプリがあり、取得できている（issue-deckのTypeSafe補完も含む）
- 取得不可 — 連携先に載っているが取得できていない
- 未連携 — AI APIを呼ぶが、使用量を読む連携先に載っていない（asset-manager・dayspan・portfolio・stockly・research-deskなど）。アプリ側に使用量APIを足して管理画面へ載せると「計測中」になる
- 枠のみ — サブスクの利用枠を使う用途（Claude Code・5時間枠の先開け・Codex）。アプリ別には数えられず、提供元別の利用枠カードで見る
- Claude.ai・ChatGPTの手動利用は取得手段が無いため載せない

Gemini（Antigravity）は使用状況の確認手段がインタラクティブなTUI（`/usage`）だけで、
非対話の出力もHTTP APIも公開されておらず取得できないため、表示対象に含めていない。

### 認証情報の取得方法

OAuthのリフレッシュトークンは使うたびにローテーションするため、**日常的に使っているCLIのログイン情報を
そのまま流用してはいけない**。ダッシュボードが更新するたびにCLI側の値が古くなり、ログアウトさせられる。
どちらもダッシュボード専用のログインを別途作り、そのトークンだけを渡す。

同じ理由で、**ローカル開発（`.env.local`）と本番（1Password）で同じトークンを共有してもいけない**。
先にローカルで動かすとその時点でトークンがローテーションし、1Passwordに登録した値は失効する。
ローカルで確認したい場合は、本番用とは別にもう一度ログインして別のトークンを使うこと。

- **Claude**: 設定ディレクトリを分けてログインすると、普段のログインに影響しない独立したトークンが得られる。

  ```bash
  CLAUDE_CONFIG_DIR=~/.claude-ops-dashboard claude auth login
  python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude-ops-dashboard/.credentials.json')))['claudeAiOauth']['refreshToken'])"
  ```

  出力を `ANTHROPIC_OAUTH_REFRESH_TOKEN` に設定する。以降このディレクトリで `claude` を**実行しない**こと
  （トークンがローテーションし、ダッシュボード側の値が古くなるため）。

  なお `claude setup-token` で発行した長期トークン（`sk-ant-oat01-...`）は**使えない**。発行時に `user:inference`
  スコープしか要求されず、このエンドポイントが必要とする `user:profile` が付かないため 403 になる
  （[claude-code#22450](https://github.com/anthropics/claude-code/issues/22450)）。

- **ChatGPT**: 同様に `CODEX_HOME` で設定ディレクトリを分けてログインする（`CODEX_HOME` は
  **存在するディレクトリを指していないとエラーになる**ため、先に作成しておくこと）。

  ```bash
  mkdir -p ~/.codex-ops-dashboard
  CODEX_HOME=~/.codex-ops-dashboard codex login --device-auth
  python3 -c "import json,os;t=json.load(open(os.path.expanduser('~/.codex-ops-dashboard/auth.json')))['tokens'];print(t['refresh_token']);print(t['account_id'])"
  ```

  1行目を `OPENAI_CHATGPT_REFRESH_TOKEN`、2行目を `OPENAI_CHATGPT_ACCOUNT_ID` に設定する。
  Claude と同様、以降このディレクトリで `codex` を実行しないこと。

  ただし **snap 版の codex は `CODEX_HOME` を無視し**、常に `~/snap/codex/<リビジョン>/auth.json` を使う
  （`snap run` が環境変数を落とすため）。この開発マシンでは普段使いの Codex が `~/.codex` を使っているので、
  snap 版でログインしたものをそのままダッシュボード専用の認証情報として使っている。

リフレッシュトークンは使うたびにローテーションするため、更新後の値を `.data/ai-usage-tokens.json`
（`AI_USAGE_STATE_PATH` で変更可）に保存して引き継ぐ。このディレクトリはデプロイ時の削除対象外のため、
デプロイをまたいでも失効しない。環境変数側のトークンを差し替えた場合は、保存済みの値を破棄して再取得する。

**アクセストークンは有効期限が残っていても失効することがある**（別端末での再ログイン・ログアウトなど）。
期限だけを見て保存済みのトークンを使い回すと、失効した時点から 401 が返り続け、更新のきっかけが
二度と来なくなる（#189）。ChatGPT側は 401 を受けたら保存済みのトークンを捨てて更新し、1回だけ
取得をやり直す（Codex CLI の unauthorized recovery と同じ手順）。**やり直しても 401 なら
リフレッシュトークン自体が死んでいる**ので、画面には「ChatGPTへ再ログインして
`OPENAI_CHATGPT_REFRESH_TOKEN` を更新してください」と出す。Claude側は `expires_in` が短く
毎回更新が走るため、この経路は設けていない。

**リフレッシュトークン自体が死ぬこともある**（別のログインでローテーションが進んだ、提供元側で
取り消された、など）。その場合トークンエンドポイントは `invalid_grant` を返し、何度やり直しても
復旧しない。画面には上流のJSONではなく「リフレッシュトークンが失効しています。◯◯へ再ログインして
`＜環境変数名＞` を更新してください」と出すので、[認証情報の取得方法](#認証情報の取得方法)の手順で
ログインし直し、新しいリフレッシュトークンを1Password（本番）または `.env.local`（ローカル）へ
設定する（#213）。

保存済みのトークンでの更新が失敗したとき、環境変数の値でもう一度試すのは**`invalid_grant` が
返ったときだけ**にしている。通信エラーや 5xx では保存済みの値がまだ生きている公算が大きく、
そこで使用済みの古いトークンを送ると、提供元のトークン再利用検知
（[RFC 9700 §4.14.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2)）で
有効なトークンまで巻き添えに失効させられかねないため。

各提供元のエンドポイントはレート制限が厳しい（Anthropic側は180秒以上の間隔が推奨）ため、
取得結果はサーバー側で既定5分間キャッシュする（`AI_USAGE_CACHE_SECONDS` で変更可）。
キャッシュは提供元ごとに分かれていて、片方がエラーでももう片方の取得間隔は変わらない（#273）。
429・通信エラーなどの一時的な失敗は短く持って取り直すが、Claudeは失敗時・設定値によらず
180秒より短くは取り直さない。リフレッシュトークンの失効と未設定は、再ログイン・設定まで
変わらないため通常と同じ長さで持つ。

## iPhoneウィジェット向けのClaude利用枠API

iPhoneのロック画面ウィジェット（Scriptable）からClaudeの利用枠の残量を参照するための中継API。
ダッシュボードには表示せず、このエンドポイントだけを提供する。

```
GET /api/claude-usage
Authorization: Bearer <WIDGET_TOKEN>
```

上流（`https://api.anthropic.com/api/oauth/usage`）のJSONに `collected_at`（取得時刻）と
`stale`（古いキャッシュを返しているか）を足して返す。キー構成は提供元の都合で変わりうるため、
サーバー側では解釈し直さずそのまま素通しし、ウィジェット側が知っているキーだけを読む。

```json
{
  "five_hour": { "utilization": 0.42, "resets_at": "2026-08-12T17:00:00Z" },
  "seven_day": { "utilization": 0.61, "resets_at": "2026-08-14T03:00:00Z" },
  "collected_at": "2026-08-12T14:05:00Z",
  "stale": false
}
```

| コード | 条件 |
| --- | --- |
| 200 | 取得成功、またはキャッシュあり（失敗時は `stale: true` と `error` が付く） |
| 401 | `Authorization` が一致しない、または `WIDGET_TOKEN` 未設定 |
| 503 | 上流の取得に失敗し、キャッシュも無い |

- **認証**: Scriptableはログイン画面を通れないため、Supabase Authではなく `WIDGET_TOKEN` との完全一致で認証する。
  このパスは `src/proxy.ts` の認証対象から除外している。`WIDGET_TOKEN` が未設定なら常に401を返す
- **認証情報**: AI使用状況の表示と同じ `ANTHROPIC_OAUTH_REFRESH_TOKEN` を使う。
  issueの当初案は同一VPS上の `~/.claude/.credentials.json` を直接読む方式だったが、
  このファイルは 600 でpm2の実行ユーザーを揃える必要があるうえ、アクセストークンの更新を
  そのマシンのClaude Codeの実行に依存してしまうため、既存の仕組み（リフレッシュトークン + トークンストア）に寄せている
- **キャッシュ**: ダッシュボードのAI使用状況と同じClaudeのキャッシュを読む（#273。別々に持つと、
  取得が重なったときに同じエンドポイントへの間隔が180秒を割るため）。上流の取得に失敗しても、
  前に取れた値があれば `stale: true` を付けて200で返し、ウィジェットが空になることを避ける
- **タイムアウト**: ウィジェット側のタイムアウトが8秒のため、7秒で待つのをやめて前の値を返す
  （取得そのものは続け、終われば次の要求からキャッシュが使われる）

`anthropic-beta` ヘッダーのバージョン文字列が変わると**無言で401になる**。値は
`src/lib/ai-usage/claude.ts` の `OAUTH_BETA_VERSION` にまとめてあるので、そこを書き換えれば復旧できる。

## サーバー間参照向けの読み取りAPI

ダッシュボードの読み取りAPIを、ログインセッションを持たないサーバープロセスからも参照できるようにしている（[issue #85](https://github.com/guchi-apps/status-hub/issues/85)）。

**呼び出し元は同じVPS上で動くAIDEのMCPサーバー**（[guchi-apps/aide#31](https://github.com/guchi-apps/aide/issues/31)）。ClaudeアプリはVPS上のAPIへ直接届かないため、AIDEがここを `http://127.0.0.1:3110` から叩いて「いま異常があるか」の粒度に畳み、1本のMCPツールとして返す。指標の収集はこのダッシュボードが既に行っているので、AIDE側では作り直さない。

**外部公開は増えていない。** Apacheが公開しているのは従来どおりで、この口はVPS内のlocalhost経由でのみ使う。

```
GET /api/host-stats          ホスト（VPS・サブPC）のステータス
GET /api/monitors            UptimeRobot
GET /api/uptime-kuma         Uptime Kuma
GET /api/ai-usage            AI利用枠（Claude / ChatGPT）
GET /api/ai-app-usage        アプリ別のAI利用（使用モデル・呼出回数・トークン・概算金額）
GET /api/github-usage        GitHubの制限
GET /api/onepassword-usage   1Passwordのレート制限

Authorization: Bearer <OPS_API_TOKEN>
```

- **認証**: `src/lib/session.ts` の `requireSessionOrApiToken()` で、ログインセッションか
  `OPS_API_TOKEN` のどちらかを求める。画面からの利用はこれまでどおりセッションで通り、挙動は変わらない。
  `OPS_API_TOKEN` が未設定ならトークン経路は無効になり、セッション必須だった従来の状態に戻る

### アプリ別AI利用の連携先設定API

`/api/ai-app-usage/sources` は、ログイン済み画面とAIエージェントが同じ連携先一覧を操作するためのAPIである。
画面では「連携先を管理」を使う。エージェントは、取得した一覧を編集してから `PUT` で丸ごと置き換える。

```text
GET /api/ai-app-usage/sources
PUT /api/ai-app-usage/sources
Authorization: Bearer <AI_APP_USAGE_SOURCES_WRITE_TOKEN>
Content-Type: application/json

{ "sources": [{ "app": "issue-deck", "url": "https://example.com/api/ai-usage" }] }
```

- 認証はログインセッションまたは `AI_APP_USAGE_SOURCES_WRITE_TOKEN`。**読み取り用の `OPS_API_TOKEN` では通さない**
- `PUT` は連携先を丸ごと置き換える。`app` の重複と、https・ループバック以外のhttp URLは拒否する
- 保存後はアプリ別AI利用のキャッシュを無効化するため、次の取得から新しい一覧で読む
- **トークンの照合**: 両方をSHA-256で固定長へ畳んでから `timingSafeEqual` で比較する。
  `timingSafeEqual` は長さが違うと例外を投げるため、素で渡すと期待値の長さを推測されうる
- **トークンを分けている理由**: 用途（読み取り全般 / ウィジェット中継 / メトリクス受信）が違うため、
  `WIDGET_TOKEN`・`HOST_STATS_TOKEN` とは別トークンにしている。1本を使い回すと、
  片方を失効させたときにもう片方が巻き添えで止まる
- **書き込みAPIは対象外**。`POST /api/host-stats` は従来どおり `HOST_STATS_TOKEN`、
  `POST /api/uptime-kuma/monitors` は `UPTIMEKUMA_ADMIN_TOKEN` で認証する。
  読み取り用として配ったトークンで本番の設定を書き換えられないよう、書き込みには相乗りさせない
- **監視系（`/api/uptime-kuma`・`/api/monitors`）は `{ monitors, error }` を返す**。
  取得に失敗した系統は `monitors: []` に加えて `error` に理由（文字列）が入る。成功時・未設定時は
  `error: null`。`monitors` だけを読む呼び出し元はそのまま動くが、`monitors` が空でも
  「監視が無い」とは限らないため、`error` も見ること（[issue #276](https://github.com/guchi-apps/status-hub/issues/276)）
- **レスポンスの形は画面向けと同一**。AIDE側は既存の型（`src/types/host-stats.ts` ほか）を契約として
  実装しているため、**形を変える場合は aide#31 側の追随が要る**

| コード | 条件 |
| --- | --- |
| 200 | 取得成功（本文は画面が使っているものと同じ） |
| 401 | ログインセッションが無く、`Authorization` も一致しない（`OPS_API_TOKEN` 未設定を含む） |

上記のパスは `src/lib/public-paths.ts` の `PUBLIC_PATH_PREFIXES`（`src/proxy.ts` が参照）で認証対象から除外している。**除外したパスの保護はルート側だけが担う**ため、これらのディレクトリへルート（特にGET以外のメソッド）を足すときは必ずルート側で認証すること。付け忘れるとそのまま無認証で公開される。

### 設定

`OPS_API_TOKEN` は環境変数では持たず、issue-deck の共有トークンAPIから実行時に取得する（`ISSUE_DECK_URL`・`SHARED_TOKEN_API_SECRET` が要る。#448・#610）。取得できなければトークン経路は無効になり、セッション必須の状態に戻る。

### 本番で401になったときの確認

`OPS_API_TOKEN` は `.env` に無いため、VPS上の `.env` から取り出して試すことはできない。issue-deck の設定画面で
`OPS_API_TOKEN` の利用元に `ops-dashboard` が出ているか（＝取得できているか）と、呼び出し元
（AIDEのMCPサーバー）が同じ共有トークンを使っているかを確かめる。ローテーション直後は最大10分、
キャッシュした古い値が残る。

## GitHubの制限の表示

`guchi-apps` organization のGitHub Actions無料枠の消費量と、REST APIのレート制限をダッシュボードに表示する。

| 表示 | 取得元 |
| --- | --- |
| Actions無料枠の消費量・今月の総実行時間・リポジトリ別の内訳・課金額 | `GET /organizations/{org}/settings/billing/usage` |
| APIレート制限（5,000 req/時）の残量とリセット時刻 | `GET /rate_limit` |
| 無料枠を消費するリポジトリの判定 | `GET /orgs/{org}/repos?type=private` |
| 無料枠の上限（プラン） | `GET /orgs/{org}` の `plan.name` |

**publicリポジトリのActionsは無制限に無料**のため、無料枠（Freeプランは2,000分/月、
Teamプランは3,000分/月）を消費するのはprivateリポジトリの分だけである。課金レポートはpublicリポジトリの実行時間も含めて返すので、
合計をそのまま無料枠と比べると実際よりはるかに消費しているように見えてしまう。
このため無料枠のゲージはprivateリポジトリ分のみで計算し、総実行時間は別項目として表示している
（無料枠の消費は実行環境ごとの倍率も加味する。Windowsは2倍、macOSは10倍）。

Actionsのストレージ消費は課金レポートがGB時間で返す一方、無料枠は容量（500MB）で決まっているため
割合を出せない。実績値のみを表示している。

### 実装上の注意

- **課金レポートは `year` / `month` を必ず指定する**。省略すると全リポジトリの合計が単一のリポジトリ名に
  束ねられた状態で返るため、リポジトリ別の内訳が出せない
- 旧エンドポイント `GET /orgs/{org}/settings/billing/actions`（`included_minutes` などを返していた）は
  410で廃止済み。現在は無料枠の残量を直接返すAPIが存在しないため、上記の方法で自前に算出している
- **無料枠の上限（ゲージの分母）は `GET /orgs/{org}` の `plan.name` から引く**。上限を返すAPIも無いため、
  プラン名 → 分数の対応表（Free 2,000 / Team 3,000 / Enterprise 50,000）を実装側に持っている。
  `plan` は組織のオーナー権限を持つトークンでしか返らず、取得できない場合は2,000分へ落ちる
  （その旨をサーバーログへ警告として出す）
- `GET /repos/{owner}/{repo}/actions/runs/{run_id}/timing` は、public・privateいずれのリポジトリでも
  `billable` が常に0を返す状態で、実行時間の取得には使えない

### 認証情報の取得方法

課金レポートのエンドポイントはfine-grained PATに非対応のため、**classic PAT**を使う。
必要なスコープは `read:org` と、privateリポジトリの一覧取得に使う `repo`。
発行した値を `GH_USAGE_TOKEN`、対象の組織名を `GH_USAGE_ORG` に設定する。
どちらか未設定の場合はGitHubセクションを表示しない。

取得結果はサーバー側で既定5分間キャッシュする（`GH_USAGE_CACHE_SECONDS` で変更可）。
無料枠の上限は組織のプランから自動で決まる（`guchi-apps` はTeamプランのため3,000分）。
`GH_ACTIONS_MINUTES_LIMIT` を設定した場合はそちらが優先されるので、**プランどおりの分母でよければ
設定しない**（古い値を設定したままだとプラン変更に追従しなくなる）。

### Notionを表示対象に含めていない理由

Notionは使用量・プラン枠を返すAPIを公開しておらず、レート制限（平均3 req/秒）も残量ヘッダを返さず
429と `Retry-After` のみで通知される仕様のため、「残り何%」に相当する値が取得できない。
1クエリ10,000件のページング上限やペイロード上限（1,000ブロック / 500KB）も時間でリセットされる枠ではなく、
ダッシュボードの残量表示には載らないため対象外としている（Geminiと同じ扱い）。

## 1Passwordのレート制限の表示

全アプリのデプロイ・CIが同じサービスアカウントで1Passwordからシークレットを読んでいるため、
枠を使い切ると**どのアプリのデプロイも通らなくなる**。逼迫に事前に気づけるよう、残量をダッシュボードに表示する。

| 表示 | 枠の単位 |
| --- | --- |
| 読み取り・書き込みの残量（1時間あたり） | サービスアカウントのトークン単位 |
| 読み書きの残量（24時間あたり） | 1Passwordアカウント全体（全サービスアカウントの合計） |

上限はプランで決まり、個人・ファミリーでは 1時間あたり読み取り1,000回・書き込み100回、
アカウント全体で24時間あたり1,000回（[Rate limits](https://www.1password.dev/service-accounts/rate-limits/)）。

### 取得方法

**HTTPで取得する手段が無い**ため、ここだけは1Password CLI（`op service-account ratelimit --format=json`）を
サーバー上で実行して取得している。CLIが内部で叩くエンドポイントはSRPでセッションを張る前提で、
サービスアカウントトークンだけを持って直接呼ぶことはできない。

そのため**VPSに `op` が入っていないと表示されない**（入っていない場合はエラーとして扱い、他のセクションには影響しない）。

```bash
# VPS上で1回だけ実行する（管理者アカウントで作業する）
curl -fsSL -o /tmp/1password-cli.deb https://downloads.1password.com/linux/debian/amd64/stable/1password-cli-amd64-latest.deb
sudo dpkg -i /tmp/1password-cli.deb && rm /tmp/1password-cli.deb
op --version
```

出力の `reset` は**リセット時刻ではなくリセットまでの残り秒数**で、まだ1回も使っていない枠では 0 が入る
（その場合はリセット時刻が定まらないため、画面には「まだ使っていません」と出す）。

手で確認するときは `OP_SERVICE_ACCOUNT_TOKEN` を渡して叩く。渡さないと、`op` はトークン無しのアカウント認証に
フォールバックしてサービスアカウント名の指定を求めてくる（`.env` にトークンが入る前は必ずこうなる）。
`couldn't start daemon` の行が出ることがあるが、これはキャッシュ用デーモンの起動に失敗しただけの警告で、
取得そのものは成功する（他人が所有する `XDG_RUNTIME_DIR` を引き継いだまま実行した場合に出る）。

**この照会自体は枠を消費しない**（連続して2回叩いても `token` / `read` の `used` が 0 のままであることを確認済み）。
消費するなら5分ごとの取得だけで1日288回、24時間枠1,000回の3割近くを残量表示のために使うことになるため、ここは確認しておく必要がある。

`op` をPATHの通っていない場所に置いた場合は `OP_CLI_PATH` に実行パスを設定する。
取得結果はサーバー側で既定5分間キャッシュする（`OP_USAGE_CACHE_SECONDS` で変更可）。

### 認証情報

`OP_SERVICE_ACCOUNT_TOKEN` にサービスアカウントトークンを設定する（未設定なら1Passwordセクションを表示しない）。
デプロイで使っているものと同じトークンをそのまま渡している。1時間枠の消費はトークン単位で数えられるため、
別のトークンを渡すと「実際にデプロイが消費している量」が見えなくなるからである。

**トレードオフ**: このトークンは `apps` ボールト全体を読めるため、アプリのランタイムに渡す権限としては広い。
1時間枠の表示を諦めてよければ、ボールトへのアクセスを持たない専用のサービスアカウントを作って
そのトークンを渡すこともできる（アカウント全体の24時間枠は、どのトークンからでも同じ値が読める）。

## アプリアイコン

ブラウザのタブ・PWA（ホーム画面へ追加したときのアイコン）で使う画像は`public/icons/`にある。
**正はSVGで、配信するPNGはそこから書き出す。**

| ファイル | 用途 |
| --- | --- |
| `icon.svg` | 通常用アイコンの正。全面を濃紺で塗り、ファビコンとしてもそのまま配信する |
| `icon-maskable.svg` | 端末側がマスクを掛ける用途の正。外周の角丸は画像に焼き込まない |
| `icon-192.png` / `icon-512.png` | PWAの`purpose: "any"`。`icon.svg`から書き出す |
| `icon-maskable-192.png` / `icon-maskable-512.png` | Androidのアダプティブアイコン（`purpose: "maskable"`）。`icon-maskable.svg`から書き出す |
| `apple-touch-icon.png` | iOSのホーム画面。`icon-maskable.svg`から180pxで書き出す |

デザインを変えるときは**SVGを2つとも直してから**書き出し、PNGもあわせてコミットする。

```bash
./scripts/generate-icons.sh   # 要 rsvg-convert（Ubuntu: librsvg2-bin）
```

端末側が独自にマスクを掛けるため、アイコン画像自体には外周の角丸を焼き込まない。既にホーム画面へ
追加済みのPWAは、OSのアイコン・名称のキャッシュが残る場合があるため、StatusHubへの更新後も古い
表示が残るときは一度削除してから再追加する。

**未ログイン状態では `/icons/*` と `/manifest.webmanifest` が `/login` へリダイレクト（307）される。**
`public/`配下の静的ファイルも`src/proxy.ts`を通り、matcherが除外しているのは`_next/static`・
`_next/image`・`favicon.ico`だけのため。ログイン画面でタブアイコンが出ないのはこれが理由で、
`curl`でアイコンを取得する検証もそのままでは通らない（[#165](https://github.com/guchi-apps/status-hub/issues/165)）。

## テスト

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm test` はNode標準の `node:test` で `src/**/*.test.ts` を実行する（依存パッケージの追加は無い。
TypeScriptはNodeの型除去でそのまま読み込み、`@/` の解決だけ `scripts/test-register.mjs` が担う）。
対象は、境界の判定が集中しているAI利用枠まわりの純粋な処理
（`src/lib/ai-usage/` の `alerts`・`history`・`claude-credit-ledger`・`day-marks`）。CIの `verify` でも実行する。

## Uptime Kuma へのモニター登録

監視タブの「モニター追加」と `POST /api/uptime-kuma/monitors` から、Uptime Kuma へモニターを登録できる（[issue #214](https://github.com/guchi-apps/status-hub/issues/214)）。新規アプリを作ったときの監視登録を手作業にしないための口である。

**Uptime Kuma にはモニターを作るREST APIが無い。** 公開されている `/api/status-page/*` は読み取り専用で、作成できるのは管理者としてログインした socket.io セッションから `add` イベントを送る経路だけである。`src/lib/uptime-kuma-admin.ts` がこの経路を実装しているが、公式に約束された仕様ではないため、Kumaを更新すると壊れうる。詳細な注意点は `AGENTS.md` の同名の節にまとめてある。

```
POST /api/uptime-kuma/monitors
Authorization: Bearer <UPTIMEKUMA_ADMIN_TOKEN>
Content-Type: application/json

{ "name": "My App", "url": "https://my-app.example.com/", "interval": 60, "retries": 0 }
```

- **認証**: ログインセッション、または `UPTIMEKUMA_ADMIN_TOKEN`。**読み取り用の `OPS_API_TOKEN` では通らない**（用途で分ける方針。上記「サーバー間参照向けの読み取りAPI」を参照）
- **何度呼んでも重複しない**。同じURLのモニターが既にあれば作らずにそれを返す（`created: false`）。末尾スラッシュの有無は同じものとして扱う
- **ステータスページへの反映まで行う**。この画面はモニターを公開ステータスページから読んでいるため、作成しただけでは一覧に出ない
- `UPTIMEKUMA_USERNAME` / `UPTIMEKUMA_PASSWORD` が未設定なら登録機能は無効になり、監視タブの「モニター追加」はKumaの `/add` を開くリンクへ戻る。**管理者アカウントに2要素認証が有効な場合も使えない**（Kumaの `login` がワンタイムコードを要求するため、理由付きのエラーを返す）

| コード | 条件 |
| --- | --- |
| 201 | 新しく作成した |
| 200 | 同じURLのモニターが既にあり、作成しなかった |
| 400 | `name` / `url` が無い、または形式が不正 |
| 401 | ログインセッションが無く、`Authorization` も一致しない |
| 503 | 管理者認証情報が未設定 |
| 502 | Kumaへ接続できない・ログインできない・Kumaが登録を拒否した |

## デプロイ

`admin.gucchii.com`（VPS上、PM2プロセス名 `ops-dashboard`、ポート3110）で公開する。

- **CI**: `.github/workflows/ci.yml`。`develop`へのpushと`main`/`develop`へのPRでlint・型チェック・buildを実行
- **デプロイ**: `.github/workflows/deploy.yml`。`main`へのpushで、`package.json`のversionからGitタグ・GitHub Releaseを作成し、ビルド成果物をVPSのgate（`app-deploy-gate`。アプリ名 `ops-dashboard`）へ渡し、gateが展開・`.env`更新・PM2の再起動（`deploy/ecosystem.config.js`）・稼働版の照合を行う（#607。詳細は AGENTS.md「本番デプロイ」）
- **シークレット**: ワークフローは実行時に**GitHubのsecret / variable**から値を取る（`op://`の実行時参照は行わない。#51）。どの値をGitHub側のどこへ置くかの対応表が`.github/secrets-manifest.tsv`で、VPSへの接続先（`SERVER_HOST`・`SERVER_USERNAME`・`SERVER_SSH_PORT`）とSupabase（`SUPABASE_*`）はorganizationの共通値を継承し、それ以外はこのリポジトリのsecret / variableに置く（デプロイ鍵 `SSH_PRIVATE_KEY` もこのアプリ専用のrepo secret。#607）。`deploy.yml`のenvブロックは`scripts/generate-workflow-env-block.sh`で生成できる
- **シークレットの更新**: 1Password（`apps`ボールトの`ops-dashboard`アイテム）は「人が管理する唯一の正」として残す。値を変えたときだけ`op signin`のうえ`scripts/sync-github-secrets.sh`（`--dry-run`で差分だけ確認できる）を実行してGitHub側へ同期する。ここで使う`op`は個人アカウントのセッションのため、サービスアカウントの日次レート制限を消費しない。AI使用状況の表示には`anthropic-oauth-refresh-token` / `openai-chatgpt-refresh-token` / `openai-chatgpt-account-id` / `typesafe-usage-url` / `typesafe-usage-token`、GitHubの制限の表示には`github-usage-token` / `github-usage-org`、iPhoneウィジェット向けAPIには`widget-token`（32文字以上のランダム文字列）、サーバー間参照向けの読み取りAPIには`ops-api-token`（同じく32文字以上のランダム文字列）、アプリ別AI利用をAIエージェントから変更するには`ai-app-usage-sources-write-token`（同じく32文字以上のランダム文字列）のフィールドをアイテムへ追加してから同期する（GitHub側が未設定のままだと、デプロイでその値が空のままVPSの`.env`へ書かれる）。1Passwordのレート制限の表示には、GitHub Secretsの`OP_SERVICE_ACCOUNT_TOKEN`がそのままVPSの`.env`へ渡る（1Password側のフィールド追加は不要）
- **ログイン通知**（#516）: Signalyへは送らない。ログイン成功は `src/lib/login-notify.ts` がアクセスDBの `login_events` へ残し（直近200件・アクセス管理の「ログイン履歴」タブ）、管理者の端末へWeb Pushで知らせる。端末ごとの設定（毎回／新しい接続元のみ／オフ。購読の `loginAlerts`）は通知メニューにある。`SIGNALY_LOGIN_WEBHOOK_URL` はコードから読まれなくなったが、`deploy.yml`・マニフェストからの削除は別Issue（#518）で行う。アラート通知（`SIGNALY_ALERT_WEBHOOK_URL`）はこのリポジトリのsecretのまま
- **環境変数の渡り方**: VPS上の`.env`は`next start`（Next.js）自身が起動時に読み込む。`deploy/ecosystem.config.js`がPM2から渡しているのは`NODE_ENV`と`PORT`だけだが、それで足りている（`dotenv`は不要）。**そのため`pm2 show ops-dashboard`の環境変数一覧には`.env`の値は出てこない**（PM2が注入した分しか表示されないため）。出ていないことは値が渡っていない証拠にはならない。切り分けは`.env`の中身と、実際にAPIを叩いた結果で行う（[issue #102](https://github.com/guchi-apps/status-hub/issues/102)）
- **Apache**: リバースプロキシ設定は`vps`リポジトリ（`apache/sites-available/admin.gucchii.com.conf`）が一次情報源。`deploy/apache-vhost.example.conf`は参考用の雛形
- **Supabase**: Authentication → URL Configuration の Redirect URLs に `https://admin.gucchii.com/auth/callback` を追加登録すること
