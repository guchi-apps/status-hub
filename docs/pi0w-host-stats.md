# Pi Zero W の稼働・センサー取得状況（#581）

自宅LAN内の Raspberry Pi Zero W（`pi0w`）を、ほかのホストと同じホスト一覧・詳細に並べる。
Pi は SwitchBot の BLE 取得（リビング・屋外）を担っており、2026-10-10 の取得停止は Pi の電源断が原因だった。
Pi の停止と、Pi は動いているのにセンサーだけ取れていない状態を、画面で区別できるようにする。

## 構成

```text
Pi Zero W
  switchbot-co2.timer（5分ごと）
    └─ switchbot_to_myroom.py ──HTTPS──► MyRoom（値の保存先）
         └─ /var/lib/myroom-pi/sensor-status.tsv にセンサーごとの最終試行・最終成功を書く
  ops-dashboard-host-stats.timer（1分ごと）
    └─ agent.sh ──HTTPS──► StatusHub POST /api/host-stats
         （メトリクス・定期ジョブ・センサーの状態ファイルをそのまま運ぶ）
```

- **送信は既存のエージェント（`scripts/host-stats/agent.sh`）と `/api/host-stats` をそのまま使う。** Pi 専用の受け口は作っていない
- Pi は BLE 取得と1分ごとの状態送信だけを動かす。StatusHub の画面・ビルド・AI処理は載せない。Tailscale も前提にしない
- センサーの状態ファイルは取得スクリプト（guchi-apps/pi0w_260719 の `myroom-api/switchbot_to_myroom.py`）が書く。
  エージェントは読むだけで、BLE にもセンサーにも触れない

## 判定

| 対象 | 判定 | 既定値・環境変数 |
| --- | --- | --- |
| ホスト | 最終受信から閾値を超えたら「応答なし」。電源断・回線断・エージェント停止は区別できないので断定しない | `HOST_STATS_OFFLINE_AFTER_SECONDS`（既定300秒。全ホスト共通） |
| センサー | 最後の成功から閾値を超えたら「取得停止」。閾値内なら直近1回の失敗は「直近は失敗」（警告）どまり | `HOST_STATS_SENSOR_STALE_SECONDS`（既定900秒＝取得周期5分の3周期） |
| 定期ジョブ | 既存どおり（`switchbot-co2`・`aircon-myroom` の成功・失敗・タイマー停止） | `HOST_STATS_TIMER_*` |

- **ホストが応答していない間、センサーは「不明（ホスト応答なし）」にする。** 最後に受け取った状態ファイルは古く、
  正常とも停止とも言えないため。未解消エラー件数もホスト1件にまとめ、センサーを足さない
- **センサーの取得は部分成功でも終了コード0で終わる**（片方が見つからなくても、もう片方を送れれば成功）。
  定期ジョブの結果だけでは片方の停止に気づけないため、センサー単位の最終成功時刻で判定している
- 状態ファイルを読めない（取得側がまだ書いていない・権限）ときは `available: false` で届き、「取得状況を読めません」と
  出す。件数には入れず、取得できていない対象として扱う（0件＝正常と取り違えない）
- 判定はサーバー側の `toHostView`（`src/lib/host-stats/sensors.ts` の `evaluateSensors`）で1回だけ行い、画面と
  未解消エラー件数が同じ結果を使う。閾値の環境変数をクライアントへ配らずに済む

### 閾値の初期案との差

Issue の初期案は「1分ごと送信・3分超で応答なし」。ホストの閾値は全ホスト共通の `HOST_STATS_OFFLINE_AFTER_SECONDS`
（本番300秒）をそのまま使っている。Pi だけ短くする仕組みは入れていない。Wi-Fi 越しの Pi は一時的な送信失敗が
起きやすく、3分では誤検知が増える見込みのため、まず共通の5分で運用して実測を見る。

## 通知

- **Pushはホストの停止・復旧・再起動だけ**（[host-incident-alerts.md](./host-incident-alerts.md)）。Pi も
  `pi0w` として初回受信から自動で対象になり、電源断・回線断で約5〜6分後に届く。Pi 専用の設定は無い
- センサーの取得停止は**未解消エラー件数（PWAバッジ）に数えるが、Pushはしない**（サービス停止・定期ジョブの異常と同じ扱い）
- Uptime Kuma の Push Monitor（pi0w_260719 #20）は未実装のため、重複する監視は無い。#20 を実装すると Pi の停止が
  Kuma と StatusHub の両方から届くので、そのときはどちらかに寄せる

## 設置（人手）

Pi はこのリポジトリを持たないので、サブPCのチェックアウトから SSH で配る（サブPC→Pi の SSH は subpc#126 で
確認済み。管理ユーザー `guchi` は `sudo -n` が通る）。**先に pi0w_260719 側の状態ファイル書き出しを入れる**
（入っていないと「取得状況を読めません」が出続ける。壊れはしない）。

```bash
# サブPCで。status-hub のチェックアウトから Pi へ送る
cd ~/apps/status-hub && git pull && scp scripts/host-stats/{agent.sh,ops-dashboard-host-stats.service,ops-dashboard-host-stats.timer,host-stats.pi0w.env.example} guchi@pi0w:/tmp/
```

```bash
# Pi で（サブPCから ssh guchi@pi0w で入る）
cd /tmp && sudo install -d /opt/ops-dashboard-host-stats && sudo install -m 755 agent.sh /opt/ops-dashboard-host-stats/ && sudo install -m 600 -o root -g root host-stats.pi0w.env.example /etc/ops-dashboard-host-stats.env
sudo vi /etc/ops-dashboard-host-stats.env   # HOST_STATS_TOKEN を記入する
cd / && sudo bash -c 'set -a; . /etc/ops-dashboard-host-stats.env; set +a; time /opt/ops-dashboard-host-stats/agent.sh --print' >/dev/null
cd /tmp && sudo cp ops-dashboard-host-stats.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now ops-dashboard-host-stats.timer
```

ユニットは VPS・サブPCと同じもの。`ProtectSystem=strict`・`ProtectHome=read-only`・`StateDirectory=` は
Raspbian 10（systemd 241）でも使える。状態ファイル（`/var/lib/myroom-pi/`）は読むだけなので `strict` のままでよい。

## 実機で確かめること（人手）

Pi で:

```bash
# 1回あたりの負荷。real は sleep 1 秒を含む。user+sys が1回あたりのCPU時間（1分ごとなので、0.6秒なら約1%）
cd / && sudo bash -c 'set -a; . /etc/ops-dashboard-host-stats.env; set +a; time /opt/ops-dashboard-host-stats/agent.sh --print' >/dev/null
# BLE 取得が続いていること（送信の前後で switchbot-co2 の結果が success のまま）
cd / && systemctl list-timers switchbot-co2.timer ops-dashboard-host-stats.timer --all && journalctl -u switchbot-co2.service --since "-30min" --no-pager | tail -20
# 再起動後に送信が再開すること
cd / && sudo reboot
```

StatusHub で:

1. ホスト一覧に「Pi Zero W」が並び、CPU・メモリ・ディスク・稼働時間・温度、定期ジョブ2本、センサー（リビング・屋外）が出る
2. 屋外センサーだけを電池を抜くなどで止める → 15分を超えると屋外だけ「取得停止」、ホストとリビングは正常のまま
3. Pi の電源を抜く → 約5分で「応答なし」、センサーは「不明（ホスト応答なし）」。ホスト停止の Push が届く
4. 電源を戻す → 復旧（再起動後）の Push が届き、送信が再開する
5. `journalctl -u ops-dashboard-host-stats.service` にトークンが出ていないこと（エージェントは送信失敗時に応答本文だけを出す）
