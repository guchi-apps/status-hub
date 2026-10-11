#!/usr/bin/env bash
#
# このホストのメトリクスを収集し、ops-dashboard の /api/host-stats へPOSTする。
#
# VPS・サブPCとも同じこのスクリプトを使う（push型に一本化）。サブPCは自宅LAN内（NAT配下）に
# いてダッシュボードからポーリングできないため、ホスト側から送る形にしている。
# VPS上ではダッシュボード自身が同じマシンで動いているため、送信先は localhost でよい。
#
# 設定は環境変数で渡す（systemd の EnvironmentFile を使う。README を参照）:
#   OPS_DASHBOARD_URL       必須。例: https://admin.gucchii.com（VPS上なら http://localhost:3110）
#   HOST_STATS_TOKEN        必須。ダッシュボード側の HOST_STATS_TOKEN と同じ値
#   HOST_STATS_ID           任意。保存先を分ける識別子。英小文字・数字・-・_（既定: ホスト名から生成）
#   HOST_STATS_LABEL        任意。画面の見出しに使う表示名（既定: ホスト名）
#   HOST_STATS_DISK_PATHS   任意。監視するマウントポイントをカンマ区切りで（既定: /）
#   HOST_STATS_SERVICES     任意。死活を見る systemd サービスをカンマ区切りで
#   HOST_STATS_TIMERS       任意。実行結果を見る systemd timer をカンマ区切りで。
#                           `aide-zaim-sync` のようにシステム単位のユニット名を書くか、
#                           `guchi@aide-zaim-sync` のように `<ユーザー>@` を前置してユーザー
#                           単位のユニットを指す（`.timer` は省略してよい）
#   HOST_STATS_TIMEOUT      任意。送信のタイムアウト秒（既定: 15）
#   HOST_STATS_TMUX_SOCKET_ROOT
#                           任意。tmuxのソケットを探すディレクトリ（既定: /tmp）
#   HOST_STATS_SESSION_STATE_SUBDIR
#                           任意。issue-deckがセッションの状態を置く、ホームからの相対パス
#                           （既定: .local/state/issue-deck/sessions）
#   HOST_STATS_APPS_ROOT    任意。アプリを並べて置いているディレクトリ（例: /home/github-user/apps）。
#                           直下のディレクトリを1アプリとして、メモリとディスクの使用量を集計する。
#                           未設定なら集計せず、項目ごと送らない（#226）
#   HOST_STATS_APP_DISK_INTERVAL
#                           任意。アプリ別のディスク使用量を測り直す間隔の秒数（既定: 3600）
#   HOST_STATS_SENSOR_STATUS_FILE
#                           任意。センサーごとの取得状況を取得スクリプトが書き残すファイル（#581）。
#                           1行1センサーの「名前<TAB>最終試行(epoch秒)<TAB>最終成功(epoch秒)<TAB>結果」。
#                           記録の無い時刻は 0、結果は - で埋める（タブ区切りの空欄は read で潰れるため）。
#                           未設定なら項目ごと送らない。設定したのに読めなければ available:false で送る
#
# `--print` を付けて実行すると、送信せずに組み立てたJSONを表示する（設置時の確認用）。

set -euo pipefail

# ヒアストリング（<<<）は使わない。bash 5.0 以前（Raspbian 10 など）は一時ファイルを /tmp に作るが、
# ユニットの ProtectSystem=strict で /tmp は読み取り専用になり「ヒアドキュメント用一時ファイルを
# 作成できません」で失敗する（#581）。プロセス置換（< <(...)）はパイプなので一時ファイルを作らない

PAYLOAD_VERSION=1

# CPU・ネットワーク・ディスクI/Oは「1秒あけて2回読んだ差分」から求める。
# 前回値をファイルに残さずに済ませるため、この1秒を3種類で共有する。
SAMPLE_SECONDS=1

# 上位プロセスの対象にする最低の経過時間（秒）。これ未満の短命プロセスは %CPU が当てにならない
MIN_PROCESS_AGE_SECONDS=10

# CPU順・メモリ順それぞれで送る上位プロセスの件数。ダッシュボード側の上限と合わせる
MAX_TOP_PROCESSES=5

# 送るtmuxセッションの上限。ダッシュボード側も同数で切るため、超えた分は表示されない。
# 切り捨てたことに気づけるよう、実際の総数は tmuxSessionTotal で別に送る
MAX_TMUX_SESSIONS=20

# 1セッションあたりに送る「実行中コマンド」の数の上限
MAX_TMUX_COMMANDS=3

# 稼働中とみなさないコマンド。プロンプトで止まっているだけのシェルはここに挙げる
TMUX_SHELL_COMMANDS="bash zsh sh fish dash ksh csh tcsh"

# アプリ別リソースで送るアプリ数の上限。ダッシュボード側の上限と合わせる
MAX_APPS=30

: "${OPS_DASHBOARD_URL:?OPS_DASHBOARD_URL が未設定です}"
: "${HOST_STATS_TOKEN:?HOST_STATS_TOKEN が未設定です}"
DISK_PATHS="${HOST_STATS_DISK_PATHS:-/}"
SERVICES="${HOST_STATS_SERVICES:-}"
TIMERS="${HOST_STATS_TIMERS:-}"
TIMEOUT="${HOST_STATS_TIMEOUT:-15}"
TMUX_SOCKET_ROOT="${HOST_STATS_TMUX_SOCKET_ROOT:-/tmp}"
SESSION_STATE_SUBDIR="${HOST_STATS_SESSION_STATE_SUBDIR:-.local/state/issue-deck/sessions}"
APPS_ROOT="${HOST_STATS_APPS_ROOT:-}"
APP_DISK_INTERVAL="${HOST_STATS_APP_DISK_INTERVAL:-3600}"
SENSOR_STATUS_FILE="${HOST_STATS_SENSOR_STATUS_FILE:-}"
# ディスク使用量のキャッシュの置き場。ユニットの StateDirectory= が STATE_DIRECTORY を渡してくる
APP_DISK_CACHE_DIR="${STATE_DIRECTORY:-/var/lib/ops-dashboard-host-stats}"

HOSTNAME_VALUE="$(hostname)"
HOST_ID="${HOST_STATS_ID:-$(printf '%s' "$HOSTNAME_VALUE" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | sed 's/-*$//')}"
HOST_LABEL="${HOST_STATS_LABEL:-$HOSTNAME_VALUE}"

# JSONの文字列に埋め込めない文字を潰す（ホスト名・ディストリ名程度なのでこれで足りる）
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/[[:cntrl:]]//g'
}

# 「使用量・全体量・使用率(%)」のオブジェクトを組み立てる
usage_json() {
    local used="$1" total="$2"
    awk -v used="$used" -v total="$total" 'BEGIN {
        percent = (total > 0) ? used / total * 100 : 0
        printf "{\"usedBytes\":%d,\"totalBytes\":%d,\"usedPercent\":%.1f}", used, total, percent
    }'
}

# /proc/stat の1行目から「アイドル時間の累積」と「全体の累積」を取り出す
read_cpu_sample() {
    awk '/^cpu / { idle = $5 + $6; total = 0; for (i = 2; i <= NF; i++) total += $i; print idle, total; exit }' /proc/stat
}

# 物理NICの受信・送信バイト数の累積。lo と仮想NIC（docker・veth・br など）は除く。
# 行頭が空白で始まりインタフェース名の直後がコロンのため、区切りを自前で分解する
read_network_sample() {
    awk '
        NR > 2 {
            line = $0
            sub(/^[ \t]+/, "", line)
            split(line, field, /[: \t]+/)
            if (field[1] ~ /^(lo|docker|veth|br-|virbr|tun|tap|wg)/) next
            rx += field[2]
            tx += field[10]
        }
        END { printf "%d %d", rx, tx }
    ' /proc/net/dev
}

# 物理ブロックデバイスの読み書きセクタ数の累積。パーティションやループバックは除く
read_diskio_sample() {
    awk '
        $3 ~ /^(sd[a-z]+|nvme[0-9]+n[0-9]+|vd[a-z]+|mmcblk[0-9]+|xvd[a-z]+)$/ {
            read_sectors += $6
            write_sectors += $10
        }
        END { printf "%d %d", read_sectors * 512, write_sectors * 512 }
    ' /proc/diskstats
}

# 1秒あけて2回読んだ差分から「%」と「バイト/秒」を求める
collect_samples() {
    local cpu_first net_first io_first cpu_second net_second io_second
    cpu_first="$(read_cpu_sample)"
    net_first="$(read_network_sample)"
    io_first="$(read_diskio_sample)"

    sleep "$SAMPLE_SECONDS"

    cpu_second="$(read_cpu_sample)"
    net_second="$(read_network_sample)"
    io_second="$(read_diskio_sample)"

    CPU_PERCENT="$(awk -v first="$cpu_first" -v second="$cpu_second" 'BEGIN {
        split(first, a, " "); split(second, b, " ")
        idle_delta = b[1] - a[1]
        total_delta = b[2] - a[2]
        if (total_delta <= 0) { print "0.0"; exit }
        printf "%.1f", (total_delta - idle_delta) / total_delta * 100
    }')"

    NETWORK_JSON="$(rate_json "$net_first" "$net_second")"
    DISK_IO_JSON="$(rate_json "$io_first" "$io_second")"
}

# 累積値の差分を秒あたりに直す。カウンタが巻き戻った（再起動等）ときは0にする
rate_json() {
    awk -v first="$1" -v second="$2" -v seconds="$SAMPLE_SECONDS" 'BEGIN {
        split(first, a, " "); split(second, b, " ")
        in_rate = (b[1] - a[1]) / seconds
        out_rate = (b[2] - a[2]) / seconds
        if (in_rate < 0) in_rate = 0
        if (out_rate < 0) out_rate = 0
        printf "{\"inBytesPerSecond\":%d,\"outBytesPerSecond\":%d}", in_rate, out_rate
    }'
}

# CPUの機種名。/proc/cpuinfo の `model name`（ARMなど持たない機種は Hardware・Model の順に代用）。
# 読めなければ何も出さず、項目ごと送らない
collect_cpu_model() {
    awk -F': *' '/^model name|^Hardware|^Model[ \t]*:/ { print $2; exit }' /proc/cpuinfo 2>/dev/null || true
}

collect_memory() {
    local total available
    total=$(awk '/^MemTotal:/ { print $2 * 1024; exit }' /proc/meminfo)
    available=$(awk '/^MemAvailable:/ { print $2 * 1024; exit }' /proc/meminfo)
    usage_json "$((total - available))" "$total"
}

# Swapを積んでいないマシンでは何も出力しない（ダッシュボード側でカードごと省かれる）
collect_swap() {
    local total free
    total=$(awk '/^SwapTotal:/ { print $2 * 1024; exit }' /proc/meminfo)
    free=$(awk '/^SwapFree:/ { print $2 * 1024; exit }' /proc/meminfo)
    [ "$total" -gt 0 ] || return 0
    usage_json "$((total - free))" "$total"
}

collect_disks() {
    local first=1 path fields size used
    printf '['
    while IFS= read -r path; do
        [ -n "$path" ] || continue

        # df -P はロケールに依らない1行1レコードの形式。size/used はバイト単位で取る
        fields="$(df -B1 -P "$path" 2>/dev/null | awk 'NR == 2 { print $2, $3 }')" || fields=""
        [ -n "$fields" ] || continue
        size="${fields%% *}"
        used="${fields##* }"

        [ "$first" -eq 1 ] || printf ','
        first=0
        printf '{"path":"%s",' "$(json_escape "$path")"
        usage_json "$used" "$size" | sed 's/^{//'
    done < <(printf '%s\n' "$DISK_PATHS" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    printf ']'
}

# socket activation されたサービス（Ubuntu 24.04 の ssh など）は、接続が来るまで .service が
# inactive のままで、待ち受けは .socket が持つ。停止ではなく正常な状態のため、起動元
# （TriggeredBy の .socket・.path）が active なら listening として送り、稼働中として扱う。
#
# .timer 起動の oneshot は対象にしない。実行していない間の inactive を稼働中にすると、
# 前回の結果を見ずに緑になってしまうため。定期ジョブは timers として別に送っている（#75）。
# failed は待ち受けの有無に関わらず failed のまま送る（起動を試みて落ちているため）。
service_state() {
    local name="$1" state trigger

    # inactive・failed のときは終了ステータスが非0になるため、出力だけ拾う
    state="$(systemctl is-active "$name" 2>/dev/null || true)"
    [ -n "$state" ] || state="unknown"
    [ "$state" = "inactive" ] || { printf '%s' "$state"; return; }

    for trigger in $(systemctl show "$name" --property=TriggeredBy --value 2>/dev/null || true); do
        case "$trigger" in
            *.socket | *.path) ;;
            *) continue ;;
        esac
        if [ "$(systemctl is-active "$trigger" 2>/dev/null || true)" = "active" ]; then
            printf 'listening'
            return
        fi
    done
    printf '%s' "$state"
}

collect_services() {
    local first=1 name state
    printf '['
    while IFS= read -r name; do
        [ -n "$name" ] || continue

        state="$(service_state "$name")"

        [ "$first" -eq 1 ] || printf ','
        first=0
        printf '{"name":"%s","state":"%s"}' "$(json_escape "$name")" "$(json_escape "$state")"
    done < <(printf '%s\n' "$SERVICES" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    printf ']'
}

# systemctl show の出力から1つのプロパティを取り出す（値に = を含んでも壊れないようにする）
show_value() {
    printf '%s\n' "$2" | sed -n "s/^$1=//p" | head -1
}

# systemd の時刻表記（"Fri 2026-08-21 14:35:35 UTC" / "@1787322947"）をISO 8601へ直す。
# 未実行・予定なしは空か "n/a" で返るため、その場合は何も出さない
to_iso8601() {
    case "${1:-}" in
        "" | "n/a" | "0") return 0 ;;
    esac
    date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true
}

# `systemctl list-timers -o json` の結果をコンテキスト（システム / ユーザーごと）に1回だけ取る
declare -A TIMER_LIST_CACHE=()

timer_list_json() {
    # 連想配列は空文字のキーを取れないため、システム単位も接頭辞付きのキーにする
    local user="$1" key="ctx:$1"
    if [ -z "${TIMER_LIST_CACHE[$key]+set}" ]; then
        local -a ctx=()
        [ -z "$user" ] || ctx=("--machine=${user}@.host" "--user")
        TIMER_LIST_CACHE[$key]="$(systemctl "${ctx[@]}" list-timers --all -o json 2>/dev/null || true)"
    fi
    printf '%s' "${TIMER_LIST_CACHE[$key]}"
}

# NextElapseUSecRealtime が入るのは OnCalendar のタイマーだけで、OnUnitActiveSec のような
# 単調時計のタイマーでは空になる。そこが空のままだと「予定を過ぎても実行されていない」を
# 判定できないため、list-timers の `next`（epochマイクロ秒）から補う
next_elapse_from_list() {
    local user="$1" unit="$2" usec
    usec="$(timer_list_json "$user" | tr '}' '\n' | grep -F "\"unit\":\"${unit}\"" |
        sed -n 's/.*"next":\([0-9]\{1,\}\).*/\1/p' | head -1)" || usec=""
    [ -n "$usec" ] && [ "$usec" != "0" ] || return 0
    to_iso8601 "@$((usec / 1000000))"
}

# 定期ジョブ1本分の状態。
#
# `systemctl is-active` では oneshot のジョブを扱えない（実行していない間はずっと inactive で、
# 成功したのか失敗したのかを区別できない）。タイマー側から「最後の発火と次回予定」を、
# .service 側から「どう終わったか」を取り、両方を送る（#75）。
#
# ユーザー単位のユニットは root の systemctl からは見えないため `--machine=<user>@.host --user`
# で当該ユーザーのマネージャに問い合わせる。問い合わせ自体に失敗したときは available:false とし、
# 「ジョブが壊れている」と区別できるようにする（取得できないものを異常として鳴らさない）。
timer_json() {
    local name="$1" user="$2" unit="$3"
    local service="${unit%.timer}.service"
    local -a ctx=()
    [ -z "$user" ] || ctx=("--machine=${user}@.host" "--user")

    local timer_show service_show
    timer_show="$(systemctl "${ctx[@]}" show "$unit" \
        -p LoadState,ActiveState,UnitFileState,LastTriggerUSec,NextElapseUSecRealtime 2>/dev/null)" || timer_show=""

    printf '{"name":"%s","unit":"%s"' "$(json_escape "$name")" "$(json_escape "$unit")"
    [ -z "$user" ] || printf ',"user":"%s"' "$(json_escape "$user")"

    # 問い合わせに失敗すると1行も返らない（存在しないユニットでも LoadState=not-found は返る）
    if [ -z "$timer_show" ]; then
        printf ',"available":false}'
        return 0
    fi
    printf ',"available":true'

    local load_state active_state unit_file_state last_trigger next_elapse
    load_state="$(show_value LoadState "$timer_show")"
    active_state="$(show_value ActiveState "$timer_show")"
    unit_file_state="$(show_value UnitFileState "$timer_show")"
    last_trigger="$(to_iso8601 "$(show_value LastTriggerUSec "$timer_show")")"
    next_elapse="$(to_iso8601 "$(show_value NextElapseUSecRealtime "$timer_show")")"
    [ -n "$next_elapse" ] || next_elapse="$(next_elapse_from_list "$user" "$unit")"

    if [ "$load_state" = "loaded" ]; then printf ',"loaded":true'; else printf ',"loaded":false'; fi
    if [ "$active_state" = "active" ]; then printf ',"active":true'; else printf ',"active":false'; fi
    [ -z "$unit_file_state" ] || printf ',"enabled":"%s"' "$(json_escape "$unit_file_state")"
    [ -z "$last_trigger" ] || printf ',"lastTriggerAt":"%s"' "$last_trigger"
    [ -z "$next_elapse" ] || printf ',"nextElapseAt":"%s"' "$next_elapse"

    service_show="$(systemctl "${ctx[@]}" show "$service" \
        -p LoadState,Result,ExecMainStatus,ExecMainExitTimestamp,InactiveEnterTimestamp,ActiveState 2>/dev/null)" || service_show=""

    # 存在しない .service でも systemd は Result=success / ExecMainStatus=0 を返す。
    # そのまま送ると「消えたユニットが成功している」ことになるため、実在するときだけ読む
    if [ -n "$service_show" ] && [ "$(show_value LoadState "$service_show")" = "loaded" ]; then
        local result exit_status finished service_active
        result="$(show_value Result "$service_show")"
        exit_status="$(show_value ExecMainStatus "$service_show")"
        # ExecMainExitTimestamp は主プロセスを持たないユニットで空になる。その場合は
        # ユニットが非アクティブへ落ちた時刻で代用する
        finished="$(to_iso8601 "$(show_value ExecMainExitTimestamp "$service_show")")"
        [ -n "$finished" ] || finished="$(to_iso8601 "$(show_value InactiveEnterTimestamp "$service_show")")"
        service_active="$(show_value ActiveState "$service_show")"

        [ -z "$result" ] || printf ',"result":"%s"' "$(json_escape "$result")"
        case "$exit_status" in
            "" | *[!0-9]*) ;;
            *) printf ',"exitStatus":%d' "$exit_status" ;;
        esac
        [ -z "$finished" ] || printf ',"lastFinishedAt":"%s"' "$finished"
        case "$service_active" in
            active | activating | reloading) printf ',"running":true' ;;
            *) printf ',"running":false' ;;
        esac
    fi

    printf '}'
}

# HOST_STATS_TIMERS に並べたユニットの状態。未設定なら何も返さず、項目ごと送らない
collect_timers() {
    local first=1 entry user unit
    [ -n "$TIMERS" ] || return 0

    printf '['
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue

        case "$entry" in
            *@*) user="${entry%%@*}"; unit="${entry#*@}" ;;
            *)   user=""; unit="$entry" ;;
        esac
        case "$unit" in
            *.timer) ;;
            *) unit="${unit}.timer" ;;
        esac

        [ "$first" -eq 1 ] || printf ','
        first=0
        timer_json "$entry" "$user" "$unit"
    done < <(printf '%s\n' "$TIMERS" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    printf ']'
}

# 資源を食っている上位プロセス。カーネルスレッドは見ても仕方ないので除く。
# comm はスレッド名（MainThread など）になることがあるため、コマンドラインの実行ファイル名を使う。
#
# ps の %CPU は「起動してからの平均」であり、起動直後のプロセスほど高く出る。
# そのままだとエージェント自身が動かした ps が毎回1位に居座るため、
# 起動から MIN_PROCESS_AGE_SECONDS 経っていないプロセスは対象外にする。
#
# 呼び出し側はCPU順とメモリ順の2本を送る。メモリ枯渇でホストが止まる事故では、犯人が
# CPU順の一覧に出てこない。1本あたりのCPUは軽くても本数でメモリを食い潰すためで、
# CPU順だけを見ていると停止の直前まで異常に見えない（#54）。
#
# $1: ps の --sort に渡す並び順  $2: 0より大きいことを求める列（2=%CPU・3=RSS）
top_processes_json() {
    ps -eo etimes=,pcpu=,rss=,args= --sort="$1" 2>/dev/null |
        awk -v min_age="$MIN_PROCESS_AGE_SECONDS" -v max="$MAX_TOP_PROCESSES" -v key="$2" 'NF >= 4 && $1 >= min_age && $key > 0 {
            command = $4
            if (command ~ /^\[/) next
            sub(/.*\//, "", command)
            gsub(/[\\"]/, "", command)
            # RSS は KiB で返るためバイトに直す
            printf "%s{\"name\":\"%s\",\"cpuPercent\":%.1f,\"memoryBytes\":%d}", (count++ ? "," : "["), command, $2, $3 * 1024
            if (count >= max) exit
        }
        END { printf "%s", (count ? "]" : "[]") }'
}

# 他のプロセスの邪魔をしないよう、優先度を下げて実行する（ionice が無い環境では nice だけ）
low_priority() {
    if command -v ionice >/dev/null 2>&1; then
        ionice -c 3 nice -n 19 "$@"
    else
        nice -n 19 "$@"
    fi
}

# アプリのディレクトリで動いているプロセスのメモリを、アプリごとに合計する。
# PM2・user systemd・uvicorn など起動の仕方を問わず拾えるよう、プロセス名ではなく
# 作業ディレクトリ（/proc/<pid>/cwd）で振り分ける。プロセス名は next-server や node になり、
# どのアプリのものか読めないため（#226）。
#
# 足し上げるのは RSS ではなく PSS（共有ページをプロセス数で割った値）。RSS は共有ライブラリなどを
# プロセスの数だけ重複して数え、Node のプロセスでは実測で約2倍に膨らむ。合計がホスト全体の使用量を
# 超え、「アプリ以外」が出せなくなるため。smaps_rollup を読めない（root 以外で実行した）ときだけ RSS で代用する。
# 出力は1行1アプリの「M<TAB>アプリ名<TAB>バイト数<TAB>プロセス数」
app_memory_tsv() {
    local root="$1" page_size dir cwd app rss pss
    page_size="$(getconf PAGESIZE)"

    for dir in /proc/[0-9]*; do
        # 読んでいる間に終了したプロセスや、カーネルスレッド（cwd が /）は飛ばす
        cwd="$(readlink "$dir/cwd" 2>/dev/null)" || continue
        case "$cwd" in
            "$root"/?*) ;;
            *) continue ;;
        esac
        app="${cwd#"$root"/}"
        app="${app%%/*}"
        case "$app" in .*) continue ;; esac

        pss="$(awk '/^Pss:/ { print $2 * 1024; exit }' "$dir/smaps_rollup" 2>/dev/null || true)"
        if [ -n "$pss" ]; then
            printf '%s\t%s\n' "$app" "$pss"
            continue
        fi

        # statm の2列目が常駐ページ数
        read -r _ rss _ 2>/dev/null <"$dir/statm" || continue
        printf '%s\t%d\n' "$app" "$((rss * page_size))"
    done | awk -F '\t' '
        { bytes[$1] += $2; count[$1]++ }
        END { for (app in bytes) printf "M\t%s\t%d\t%d\n", app, bytes[app], count[app] }
    '
}

# アプリのディレクトリごとのディスク使用量。du は node_modules まで辿るため重いうえ、値も1分で
# 変わるものではないので、APP_DISK_INTERVAL 秒ごとにだけ測ってキャッシュを返す。
# キャッシュを書けない（StateDirectory= の無い古いユニット）ときは測らない。毎分 du を走らせないため。
# 出力は「T<TAB>計測時刻（epoch秒）」の1行と、「D<TAB>アプリ名<TAB>バイト数」の行
app_disk_tsv() {
    local root="$1" cache="${APP_DISK_CACHE_DIR}/app-disk.tsv" now measured dir bytes
    now="$(date +%s)"
    measured="$(head -n 1 "$cache" 2>/dev/null || true)"

    if ! [[ "$measured" =~ ^[0-9]+$ ]] || [ $((now - measured)) -ge "$APP_DISK_INTERVAL" ]; then
        mkdir -p "$APP_DISK_CACHE_DIR" 2>/dev/null || true
        if [ -d "$APP_DISK_CACHE_DIR" ] && [ -w "$APP_DISK_CACHE_DIR" ]; then
            {
                printf '%s\n' "$now"
                for dir in "$root"/*/; do
                    [ -d "$dir" ] || continue
                    dir="${dir%/}"
                    # 読めないファイルがあると du は非0で終わるが、読めた分の合計は出る
                    bytes="$(low_priority du -s -B1 -x "$dir" 2>/dev/null | awk '{ total = $1 } END { print total + 0 }' || true)"
                    printf '%s\t%s\n' "${dir##*/}" "${bytes:-0}"
                done
            } >"$cache.tmp" && mv "$cache.tmp" "$cache"
        fi
    fi

    [ -f "$cache" ] || return 0
    awk -F '\t' 'NR == 1 { printf "T\t%s\n", $1; next } NF >= 2 { printf "D\t%s\t%s\n", $1, $2 }' "$cache"
}

# アプリ別のメモリ・ディスク使用量（#226）。HOST_STATS_APPS_ROOT 未設定なら何も返さず、項目ごと送らない
collect_apps() {
    local root tsv items measured disk_fields
    [ -n "$APPS_ROOT" ] || return 0
    root="$(realpath -e "$APPS_ROOT" 2>/dev/null)" || return 0
    [ -d "$root" ] || return 0

    tsv="$({ app_memory_tsv "$root"; app_disk_tsv "$root"; } 2>/dev/null || true)"

    # メモリの多い順（同じならディスクの多い順）に並べて上限で切る。mawk には asort が無いため自前で並べる
    items="$(printf '%s\n' "$tsv" | awk -F '\t' -v max="$MAX_APPS" '
        $1 == "M" { names[$2] = 1; memory[$2] = $3; processes[$2] = $4 }
        $1 == "D" { names[$2] = 1; disk[$2] = $3; measured_disk[$2] = 1 }
        END {
            n = 0
            for (name in names) {
                i = ++n
                while (i > 1 && (memory[order[i - 1]] + 0 < memory[name] + 0 ||
                        (memory[order[i - 1]] + 0 == memory[name] + 0 && disk[order[i - 1]] + 0 < disk[name] + 0))) {
                    order[i] = order[i - 1]
                    i--
                }
                order[i] = name
            }
            printf "["
            for (i = 1; i <= n && i <= max; i++) {
                name = order[i]
                label = name
                gsub(/[\\"]/, "", label)
                gsub(/[[:cntrl:]]/, "", label)
                printf "%s{\"name\":\"%s\",\"memoryBytes\":%d,\"processes\":%d", (i > 1 ? "," : ""), label, memory[name], processes[name]
                if (name in measured_disk) printf ",\"diskBytes\":%d", disk[name]
                printf "}"
            }
            printf "]"
        }
    ')"
    measured="$(printf '%s\n' "$tsv" | awk -F '\t' '$1 == "T" { print $2; exit }')"

    printf '{"root":"%s","items":%s' "$(json_escape "$root")" "$items"

    # 内訳バーの分母。アプリの置き場が / とは別のマウントにあってもずれないよう、置き場のファイルシステムで取る
    if [ -n "$measured" ]; then
        disk_fields="$(df -B1 -P "$root" 2>/dev/null | awk 'NR == 2 { print $2, $3 }')" || disk_fields=""
        if [ -n "$disk_fields" ]; then
            printf ',"disk":%s' "$(usage_json "${disk_fields##* }" "${disk_fields%% *}")"
            printf ',"diskMeasuredAt":"%s"' "$(date -u -d "@$measured" +%Y-%m-%dT%H:%M:%SZ)"
        fi
    fi
    printf '}'
}

# センサーの最大件数。ダッシュボード側の上限と合わせる
MAX_SENSORS=10

# epoch秒をISO 8601へ直す。空・0（記録なし）・数字以外は何も出さない
epoch_to_iso8601() {
    case "${1:-}" in
        "" | 0 | *[!0-9]*) return 0 ;;
    esac
    date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true
}

# センサーごとの取得状況（#581）。取得スクリプト（pi0w_260719 の switchbot_to_myroom.py）が書いた
# 状態ファイルを読むだけで、BLE にもセンサーにも触れない。
# Pi Zero W の SwitchBot 取得は、片方のセンサーだけ見つからなくても終了コード0で終わる（部分成功）。
# 定期ジョブの結果では片方の停止に気づけないため、センサー単位の最終成功時刻を別に送る。
# 判定（何分で停止とみなすか）はダッシュボード側で行い、ここでは時刻を運ぶだけにする。
collect_sensors() {
    local first=1 count=0 name attempt success result
    [ -n "$SENSOR_STATUS_FILE" ] || return 0

    # 取得スクリプトがまだ一度も書いていない・権限で読めない。0件（正常）と取り違えないよう区別して送る
    if [ ! -r "$SENSOR_STATUS_FILE" ]; then
        printf '{"available":false,"items":[]}'
        return 0
    fi

    printf '{"available":true,"items":['
    while IFS=$'\t' read -r name attempt success result; do
        [ -n "$name" ] || continue
        [ "$count" -lt "$MAX_SENSORS" ] || break
        count=$((count + 1))

        attempt="$(epoch_to_iso8601 "$attempt")"
        success="$(epoch_to_iso8601 "$success")"

        [ "$first" -eq 1 ] || printf ','
        first=0
        printf '{"name":"%s"' "$(json_escape "$name")"
        [ -z "$attempt" ] || printf ',"lastAttemptAt":"%s"' "$attempt"
        [ -z "$success" ] || printf ',"lastSuccessAt":"%s"' "$success"
        case "$result" in "" | -) ;; *) printf ',"lastResult":"%s"' "$(json_escape "$result")" ;; esac
        printf '}'
    done <"$SENSOR_STATUS_FILE"
    printf ']}'
}

# 再起動待ちと未適用の更新。いずれもファイルを見るだけで、apt を毎分叩いたりはしない
collect_maintenance() {
    local reboot="false" updates="" security=""

    [ -f /var/run/reboot-required ] && reboot="true"

    # update-notifier-common が定期的に書き出すファイルを読むだけにする。
    # apt-check を毎分呼ぶとCPUを1.5秒ほど使うが、この値は1日に数回しか変わらないため割に合わない。
    # ESM（有償のサポート延長）の行は、契約していなければ適用できない件数なので数えない
    if [ -r /var/lib/update-notifier/updates-available ]; then
        read -r updates security < <(awk '
            /ESM/ { next }
            !updates && /^[0-9]+/ { updates = $1 }
            !security && /security|セキュリティ/ {
                match($0, /[0-9]+/)
                if (RSTART) security = substr($0, RSTART, RLENGTH)
            }
            END { printf "%d %d", updates, security }
        ' /var/lib/update-notifier/updates-available)
    fi

    printf '{"rebootRequired":%s' "$reboot"
    [ -z "$updates" ] || printf ',"updatesAvailable":%d' "$updates"
    [ -z "$security" ] || printf ',"securityUpdatesAvailable":%d' "$security"
    printf '}'
}

collect_sessions() {
    local count users first=1 user
    count="$(who 2>/dev/null | wc -l)"
    users="$(who 2>/dev/null | awk '{ print $1 }' | sort -u)"

    printf '{"count":%d,"users":[' "$count"
    while IFS= read -r user; do
        [ -n "$user" ] || continue
        [ "$first" -eq 1 ] || printf ','
        first=0
        printf '"%s"' "$(json_escape "$user")"
    done < <(printf '%s\n' "$users")
    printf ']}'
}

# tmuxのセッション一覧。
#
# サブPCはClaude Codeの作業セッションを常駐させるホストで、リポジトリをまたいだセッションが
# 同じ tmux ls に並ぶ。いま何が動いているかが見えないと、二重起動や放置セッションに気づけない。
#
# 動いているかどうかはアタッチの有無では判断できない。デタッチしたまま裏でclaudeが走っているのが
# 普通の使い方で、それを「待機中」と読んでしまうと一覧の意味がなくなる。
# そのため各ペインの実行コマンドを見て、シェル以外が動いていれば稼働中として送る。
#
# ソケットはユーザーごとに <ソケット置き場>/tmux-<UID>/ にあり、rootで `tmux ls` を叩いても
# root自身のサーバーしか見えない。そのためソケットを列挙して -S で個別に問い合わせる。
# ソケットのディレクトリは 0700 でユーザー所有だが、rootはDACを迂回できるため読める。
# （systemdユニットで PrivateTmp=no にしているのは、ここで実ホストの /tmp を見るため）

# 1ソケット分のセッションを「1行1セッション」のTSVにまとめる。
#
# ペイン側の情報（実行コマンド・作業ディレクトリ）はセッション単位に畳んでから返す。
# 一覧と畳み込みを2回の tmux 呼び出しで済ませるため、両方の出力を1つのawkに流し込み、
# 行頭の P / S で区別している。
#
# **最終活動には `#{window_activity}` を使う。`#{session_activity}` ではない**（#72）。
# `session_activity` が動くのはクライアントの操作（アタッチ・キー入力）で、ペインの出力では
# 更新されない。デタッチしたまま裏でclaudeが走っているのが常態のこのホストでは、
# 実測で `session_activity` が `session_created` のまま数時間止まり、画面が動き続けている
# セッションまで「60秒以上 画面が止まっている＝入力待ち」と読まれていた。
# ウィンドウ側の活動時刻はペインの出力で更新されるため、こちらを取る（両者の新しい方を採る）。
tmux_sessions_tsv() {
    local socket="$1" home="$2" tab
    tab="$(printf '\t')"

    {
        # window_activity をコマンド・パスより前に置く。パスに区切り文字が紛れても
        # 時刻の桁がずれないようにするため
        tmux -S "$socket" list-panes -a \
            -F "P${tab}#{session_name}${tab}#{window_active}#{pane_active}${tab}#{window_activity}${tab}#{pane_current_command}${tab}#{pane_current_path}" \
            2> /dev/null || true
        tmux -S "$socket" list-sessions \
            -F "S${tab}#{session_name}${tab}#{session_windows}${tab}#{session_created}${tab}#{session_attached}${tab}#{session_activity}" \
            2> /dev/null || true
    } | awk -F'\t' -v home="$home" -v shells="$TMUX_SHELL_COMMANDS" -v max_commands="$MAX_TMUX_COMMANDS" '
        BEGIN {
            split(shells, shell_list, " ")
            for (i in shell_list) is_shell[shell_list[i]] = 1
            # 区切りにタブを使うと、実行中コマンドが空のセッションで read が
            # 空フィールドを詰めてしまう（タブはIFSの空白文字扱い）。空白でない制御文字を使う
            separator = sprintf("%c", 31)
        }
        $1 == "P" {
            session = $2
            if (!is_shell[$5]) {
                busy[session] = 1
                if (!seen[session "\t" $5] && command_count[session] < max_commands) {
                    seen[session "\t" $5] = 1
                    commands[session] = (commands[session] == "" ? $5 : commands[session] "," $5)
                    command_count[session]++
                }
            }
            # セッションに窓が複数あれば、いちばん新しい活動を採る
            if ($4 + 0 > activity[session]) activity[session] = $4 + 0
            # 出すのはアクティブなウィンドウのアクティブなペイン（＝いま見えている場所）だけ
            if ($3 == "11") path[session] = $6
            next
        }
        $1 == "S" {
            session = $2
            directory = path[session]
            if (home != "" && index(directory, home) == 1) directory = "~" substr(directory, length(home) + 1)
            # 窓の活動（＝画面の動き）とセッションの活動（＝クライアントの操作）の新しい方を最終活動とする
            last_activity = activity[session]
            if ($6 + 0 > last_activity) last_activity = $6 + 0
            printf "%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s\n", \
                session, separator, $3, separator, $4, separator, $5, separator, last_activity, separator, \
                (busy[session] ? 1 : 0), separator, commands[session], separator, directory
        }
    '
}

# issue-deckが残したセッションの状態を読む（#59）。
#
# 「なぜこのセッションが畳まれずに残っているのか」はtmuxのメタデータからは分からず、
# これまでホストのjournaldを読むしか手が無かった。回収スクリプトは毎分すべてのセッションを
# 判定して理由を持っているが、同じ理由が続く間はログに出さない（同じ行でjournaldが埋まるため）。
#
# 書式は issue-deck の scripts/lib/session-state.sh が持つ1行テキストで、jqを要さずに読める。
# **issue-deck側が置き場を変えたら、この項目が出なくなるだけで送信そのものは壊れない。**
#
# 読んだ値は STATE_* に入れる。呼び出し元は collect_tmux のループの中で、同じシェルにいる。
STATE_HOLD_REASON=""
STATE_HOLD_AT=""
STATE_EVENT_NAME=""
STATE_EVENT_AT=""
STATE_REPOSITORY=""
STATE_ISSUE=""

read_session_state() {
    local session="$1" home="$2" dir file line value

    STATE_HOLD_REASON=""
    STATE_HOLD_AT=""
    STATE_EVENT_NAME=""
    STATE_EVENT_AT=""
    STATE_REPOSITORY=""
    STATE_ISSUE=""

    [ -n "$home" ] || return 0

    # **セッション名を検査してからパスに繋ぐ。** 名前はtmuxから読んだ値がそのまま来ており、
    # 人が手で立てたセッションも混ざる。`../` を含む名前を通すと状態ファイル以外を読みに行ける。
    # 規則は issue-deck の session_state_name_ok と同じ
    case "$session" in
        [A-Za-z0-9]*) ;;
        *) return 0 ;;
    esac
    case "$session" in
        *[!A-Za-z0-9_.-]*) return 0 ;;
    esac

    dir="$home/$SESSION_STATE_SUBDIR"

    # 畳まない理由。**mtimeは「最後に判定した時刻」ではなく「その理由になった時刻」。**
    # 回収スクリプトは理由が変わったときだけ書き直すため、同じ理由が続いた期間が読める
    file="$dir/$session.reason"
    if [ -f "$file" ]; then
        STATE_HOLD_REASON="$(head -1 "$file" 2> /dev/null || true)"
        value="$(stat -c %Y "$file" 2> /dev/null || true)"
        if [ "${value:-0}" -gt 0 ] 2> /dev/null; then
            STATE_HOLD_AT="$(date -u -d "@$value" +%Y-%m-%dT%H:%M:%SZ)"
        fi
    fi

    # Claude Codeのフックが記録した最後のイベント。`<epoch> <イベント名>` の1行
    file="$dir/$session.event"
    if [ -f "$file" ]; then
        line="$(head -1 "$file" 2> /dev/null || true)"
        case "$line" in
            *" "*)
                value="${line%% *}"
                if [ "${value:-0}" -gt 0 ] 2> /dev/null; then
                    STATE_EVENT_AT="$(date -u -d "@$value" +%Y-%m-%dT%H:%M:%SZ)"
                    STATE_EVENT_NAME="${line#* }"
                fi
                ;;
        esac
    fi

    # 対応するIssue。画面からIssueへ飛べるようにする
    file="$dir/$session.session"
    if [ -f "$file" ]; then
        STATE_REPOSITORY="$(sed -n 's/^repository=//p' "$file" 2> /dev/null | head -1)"
        value="$(sed -n 's/^issue=//p' "$file" 2> /dev/null | head -1)"
        case "${value:-}" in
            "" | *[!0-9]*) ;;
            *) STATE_ISSUE="$value" ;;
        esac
    fi
}

# 出力は2行。1行目がセッションのJSON配列、2行目が上限で切る前の総数。
# コマンド置換は subshell で走りグローバル変数を持ち帰れないため、総数も標準出力に載せる。
collect_tmux() {
    local dir socket uid user home count=0 total=0
    local name windows created attached activity busy commands directory
    local attached_json busy_json first_command pane_command
    local command_list

    # tmuxが入っていないホストでは項目ごと送らない（0件との区別をダッシュボード側で付けるため）
    command -v tmux > /dev/null 2>&1 || return 0

    printf '['
    for dir in "$TMUX_SOCKET_ROOT"/tmux-*; do
        [ -d "$dir" ] || continue

        uid="${dir##*/tmux-}"
        case "$uid" in "" | *[!0-9]*) continue ;; esac
        user="$(getent passwd "$uid" 2> /dev/null | cut -d: -f1)"
        home="$(getent passwd "$uid" 2> /dev/null | cut -d: -f6)"
        [ -n "$user" ] || user="uid:$uid"

        for socket in "$dir"/*; do
            [ -S "$socket" ] || continue

            # サーバーが落ちた後のソケットが残っていることがあるため、失敗は無視して次へ
            while IFS=$'\x1f' read -r name windows created attached activity busy commands directory; do
                [ -n "$name" ] || continue

                # 上限を超えた分は送らないが、総数には数える。
                # 「20件しか出ていないのは上限のせいなのか、本当に20件なのか」が
                # 画面から分からないと、セッションが積み上がっていることに気づけない
                total=$((total + 1))
                [ "$count" -lt "$MAX_TMUX_SESSIONS" ] || continue

                read_session_state "$name" "$home"

                [ "$count" -eq 0 ] || printf ','
                count=$((count + 1))

                if [ "${attached:-0}" -gt 0 ] 2> /dev/null; then
                    attached_json=true
                else
                    attached_json=false
                fi

                if [ "${busy:-0}" = "1" ]; then
                    busy_json=true
                else
                    busy_json=false
                fi

                printf '{"name":"%s","windows":%d,"attached":%s,"busy":%s,"user":"%s"' \
                    "$(json_escape "$name")" "${windows:-0}" "$attached_json" "$busy_json" \
                    "$(json_escape "$user")"

                if [ -n "$commands" ]; then
                    IFS=',' read -r -a command_list < <(printf '%s\n' "$commands")
                    printf ',"commands":['
                    first_command=1
                    for pane_command in "${command_list[@]}"; do
                        [ -n "$pane_command" ] || continue
                        [ "$first_command" -eq 1 ] || printf ','
                        first_command=0
                        printf '"%s"' "$(json_escape "$pane_command")"
                    done
                    printf ']'
                fi

                if [ -n "$directory" ]; then
                    printf ',"path":"%s"' "$(json_escape "$directory")"
                fi

                if [ "${created:-0}" -gt 0 ] 2> /dev/null; then
                    printf ',"createdAt":"%s"' "$(date -u -d "@$created" +%Y-%m-%dT%H:%M:%SZ)"
                fi

                # 放置セッションの判定に使う。世代の古いtmuxでは数値で返らないことがあり、その場合は送らない
                if [ "${activity:-0}" -gt 0 ] 2> /dev/null; then
                    printf ',"lastActivityAt":"%s"' "$(date -u -d "@$activity" +%Y-%m-%dT%H:%M:%SZ)"
                fi

                # issue-deckの回収が残した判断（#59）。手で立てたセッションには何も無い
                if [ -n "$STATE_HOLD_REASON" ]; then
                    printf ',"holdReason":"%s"' "$(json_escape "$STATE_HOLD_REASON")"
                    [ -z "$STATE_HOLD_AT" ] || printf ',"holdReasonAt":"%s"' "$STATE_HOLD_AT"
                fi
                if [ -n "$STATE_EVENT_NAME" ]; then
                    printf ',"lastEventName":"%s","lastEventAt":"%s"' \
                        "$(json_escape "$STATE_EVENT_NAME")" "$STATE_EVENT_AT"
                fi
                if [ -n "$STATE_REPOSITORY" ] && [ -n "$STATE_ISSUE" ]; then
                    printf ',"issueRepository":"%s","issueNumber":%d' \
                        "$(json_escape "$STATE_REPOSITORY")" "$STATE_ISSUE"
                fi

                printf '}'
            done < <(tmux_sessions_tsv "$socket" "$home")
        done
    done
    printf ']\n%d' "$total"
}

# CPU温度は thermal_zone → hwmon の順に探す。
#
# **`/sys/class/thermal` を持たないマシンがある**（#101）。サブPC（AMD Athlon 200GE）では
# `k10temp` が hwmon にしか登録せず、`/sys/class/thermal` には `cooling_device*` しか無い。
# thermal_zone だけを見ていたため、サブPCのカードにだけ温度が出ていなかった。
#
# thermal_zone を持つVPS側は先に当たるため、従来と同じ経路のまま。

# パッケージ温度らしいゾーンを優先して1つだけ拾う（ミリ℃）
thermal_zone_temp_milli() {
    local zone type preferred=""
    for zone in /sys/class/thermal/thermal_zone*; do
        [ -r "$zone/temp" ] || continue
        type="$(cat "$zone/type" 2>/dev/null || true)"
        case "$type" in
            x86_pkg_temp | coretemp | k10temp | cpu-thermal | acpitz)
                preferred="$zone"
                break
                ;;
        esac
        [ -n "$preferred" ] || preferred="$zone"
    done

    [ -n "$preferred" ] || return 0
    cat "$preferred/temp" 2>/dev/null || true
}

# hwmon の `name` から見たCPU温度センサーの優先順位。小さいほど優先し、0は対象外。
#
# **番号（hwmon0・hwmon1…）は検出順であってセンサーの種類を表さない。** サブPCでは hwmon1 が
# 内蔵GPU（amdgpu）で、番号だけで選ぶとGPU温度をCPU温度として送ってしまう。必ず name を見る。
hwmon_rank() {
    case "$1" in
        k10temp | zenpower | coretemp) printf '1' ;;             # CPUダイの温度（AMD / Intel）
        cpu_thermal | cpu-thermal | soc_thermal) printf '2' ;;    # ARM系SoC
        acpitz) printf '3' ;;                                     # 筐体温度。CPUそのものではないが無いよりまし
        *) printf '0' ;;                                          # amdgpu・nvme・iwlwifi 等。CPU温度ではない
    esac
}

# 1つの hwmon ディレクトリからCPU温度の入力を選んで読む（ミリ℃）。
#
# `temp*_label` が Tctl / Tdie / Package id 0 のものを優先する。coretemp はコアごとの
# `temp2_input` 以降も持っており、ラベルを見ないとパッケージ温度を選べない。
# ラベルが無いドライバ（k10temp も世代によっては持たない）では最初に読める入力を使う。
hwmon_dir_temp_milli() {
    local dir="$1" input label
    for input in "$dir"/temp*_input; do
        [ -r "$input" ] || continue
        label="$(cat "${input%_input}_label" 2>/dev/null || true)"
        case "$label" in
            Tctl | Tdie | "Package id 0")
                cat "$input" 2>/dev/null || true
                return 0
                ;;
        esac
    done

    for input in "$dir"/temp*_input; do
        [ -r "$input" ] || continue
        cat "$input" 2>/dev/null || true
        return 0
    done
}

# hwmon 全体から、いちばん確からしいCPU温度センサーを1つ選んで読む（ミリ℃）
hwmon_temp_milli() {
    local dir name rank best="" best_rank=0
    for dir in /sys/class/hwmon/hwmon*; do
        [ -d "$dir" ] || continue
        name="$(cat "$dir/name" 2>/dev/null || true)"
        [ -n "$name" ] || continue
        rank="$(hwmon_rank "$name")"
        [ "$rank" -gt 0 ] || continue
        if [ "$best_rank" -eq 0 ] || [ "$rank" -lt "$best_rank" ]; then
            best="$dir"
            best_rank="$rank"
        fi
    done

    [ -n "$best" ] || return 0
    hwmon_dir_temp_milli "$best"
}

collect_temperature() {
    local milli
    milli="$(thermal_zone_temp_milli)"
    [ -n "$milli" ] || milli="$(hwmon_temp_milli)"

    # 読めた値が整数のミリ℃であることだけ確かめる。空の入力やエラー文字列をそのまま
    # JSONへ載せると、ペイロード全体が壊れて受信側で400になる
    case "$milli" in
        "" | *[!0-9]*) return 0 ;;
    esac

    awk -v milli="$milli" 'BEGIN { printf "%.1f", milli / 1000 }'
}

os_name() {
    if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        printf '%s' "${PRETTY_NAME:-${NAME:-Linux}}"
    else
        printf 'Linux'
    fi
}

build_payload() {
    local swap temperature tmux_output tmux_sessions tmux_total timers apps sensors cpu_model cpu_threads
    collect_samples
    swap="$(collect_swap)"
    temperature="$(collect_temperature)"

    # collect_tmux は「1行目がJSON配列・2行目が総数」を返す。JSONに改行は入らないため行で切れる。
    # tmuxが入っていないホストでは何も返らず、両方とも空になる
    tmux_output="$(collect_tmux)"
    tmux_sessions="${tmux_output%%$'\n'*}"
    tmux_total="${tmux_output#*$'\n'}"

    # HOST_STATS_TIMERS 未設定のホストでは空になり、項目ごと送らない
    timers="$(collect_timers)"

    # HOST_STATS_APPS_ROOT 未設定のホストでは空になり、項目ごと送らない
    apps="$(collect_apps)"

    sensors="$(collect_sensors)"

    printf '{'
    printf '"version":%d,' "$PAYLOAD_VERSION"
    printf '"id":"%s",' "$(json_escape "$HOST_ID")"
    printf '"label":"%s",' "$(json_escape "$HOST_LABEL")"
    printf '"hostname":"%s",' "$(json_escape "$HOSTNAME_VALUE")"
    printf '"os":"%s",' "$(json_escape "$(os_name)")"
    printf '"kernel":"%s",' "$(json_escape "$(uname -r)")"
    printf '"collectedAt":"%s",' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '"cpuPercent":%s,' "$CPU_PERCENT"
    cpu_model="$(collect_cpu_model)"
    [ -z "$cpu_model" ] || printf '"cpuModel":"%s",' "$(json_escape "$cpu_model")"
    cpu_threads="$(nproc 2>/dev/null || true)"
    case "$cpu_threads" in "" | *[!0-9]*) ;; *) printf '"cpuThreads":%d,' "$cpu_threads" ;; esac
    printf '"memory":%s,' "$(collect_memory)"
    [ -z "$swap" ] || printf '"swap":%s,' "$swap"
    printf '"disks":%s,' "$(collect_disks)"
    printf '"loadAverage":[%s],' "$(awk '{ printf "%s,%s,%s", $1, $2, $3 }' /proc/loadavg)"
    printf '"uptimeSeconds":%d,' "$(awk '{ printf "%d", $1 }' /proc/uptime)"
    [ -z "$temperature" ] || printf '"temperatureCelsius":%s,' "$temperature"
    printf '"network":%s,' "$NETWORK_JSON"
    printf '"diskIo":%s,' "$DISK_IO_JSON"
    printf '"topProcesses":%s,' "$(top_processes_json -pcpu 2)"
    printf '"topMemoryProcesses":%s,' "$(top_processes_json -rss 3)"
    printf '"maintenance":%s,' "$(collect_maintenance)"
    printf '"sessions":%s,' "$(collect_sessions)"
    [ -z "$tmux_sessions" ] || printf '"tmuxSessions":%s,' "$tmux_sessions"
    [ -z "$tmux_sessions" ] || printf '"tmuxSessionTotal":%d,' "$tmux_total"
    [ -z "$apps" ] || printf '"apps":%s,' "$apps"
    printf '"services":%s' "$(collect_services)"
    [ -z "$timers" ] || printf ',"timers":%s' "$timers"
    [ -z "$sensors" ] || printf ',"sensors":%s' "$sensors"
    printf '}'
}

# ダッシュボードから頼まれた tmux セッションを閉じる（#409）。
#
# ダッシュボードへは送るだけで、こちらへ指示を出す経路が無いため、POSTの応答に載った
# "closeSessions":["<ユーザー>|<セッション名>", ...] を読む。閉じたかどうかは報告せず、
# 次回の送信でセッションが一覧から消えていれば、ダッシュボードが完了とみなす。
#
# **このエージェントは root で動くため、受け取った文字列をそのまま使わない。**
# jq を要さず grep で取り出す代わりに、名前として許す文字だけに合うものしか拾わない
# （ダッシュボード側の検査と同じ規則。先頭が - や . の名前は tmux のオプション・特殊指定に読まれうる）。
# さらに、いま実際にそのユーザーのソケットに存在するセッションだけを、`=` 付きの完全一致で閉じる。
close_requested_sessions() {
    local body="$1" list entry user name dir uid socket_user socket
    local user_re='[A-Za-z0-9_][A-Za-z0-9._:-]{0,63}'
    local name_re='[A-Za-z0-9_][A-Za-z0-9._-]{0,127}'

    command -v tmux > /dev/null 2>&1 || return 0

    list="$(printf '%s' "$body" | grep -oE '"closeSessions":\[[^]]*\]' | head -n 1 || true)"
    [ -n "$list" ] || return 0

    while IFS= read -r entry; do
        entry="${entry//\"/}"
        user="${entry%%|*}"
        name="${entry#*|}"

        for dir in "$TMUX_SOCKET_ROOT"/tmux-*; do
            [ -d "$dir" ] || continue
            uid="${dir##*/tmux-}"
            case "$uid" in "" | *[!0-9]*) continue ;; esac
            socket_user="$(getent passwd "$uid" 2> /dev/null | cut -d: -f1)"
            [ -n "$socket_user" ] || socket_user="uid:$uid"
            [ "$socket_user" = "$user" ] || continue

            for socket in "$dir"/*; do
                [ -S "$socket" ] || continue
                tmux -S "$socket" has-session -t "=$name" 2> /dev/null || continue
                if tmux -S "$socket" kill-session -t "=$name" 2> /dev/null; then
                    echo "tmux セッションを閉じました: ${user}/${name}" >&2
                fi
            done
        done
    done < <(printf '%s' "$list" | grep -oE "\"${user_re}\|${name_re}\"")
}

main() {
    local payload response status body
    payload="$(build_payload)"

    # 設置時の確認用。送信はせずJSONだけ出す
    if [ "${1:-}" = "--print" ]; then
        printf '%s\n' "$payload"
        return 0
    fi

    response="$(
        printf '%s' "$payload" | curl -sS \
            --max-time "$TIMEOUT" \
            -X POST \
            -H "Authorization: Bearer ${HOST_STATS_TOKEN}" \
            -H "Content-Type: application/json" \
            --data-binary @- \
            -w '\n%{http_code}' \
            "${OPS_DASHBOARD_URL%/}/api/host-stats"
    )"

    status="${response##*$'\n'}"
    body="${response%$'\n'*}"

    if [ "$status" != "200" ]; then
        echo "host-stats の送信に失敗しました (HTTP ${status}): ${body}" >&2
        exit 1
    fi

    close_requested_sessions "$body"
}

main "$@"
