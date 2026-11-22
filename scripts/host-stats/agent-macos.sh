#!/usr/bin/env bash
#
# Mac mini（macOS）のメトリクスを収集し、ops-dashboard の /api/host-stats へPOSTする。
#
# scripts/host-stats/agent.sh のmacOS版。agent.sh は /proc・systemctl・/sys/class/* に強く
# 依存しており、いずれもmacOSには無いためそのままでは動かない。送信先のペイロード形式
# （HostStatsReport）は共通だが、macOSに対応する取得手段が無い項目（CPU温度・systemdサービス
# 相当・定期ジョブ・アプリ別リソース・tmuxセッション集計）は送らない。いずれもダッシュボード側では
# 任意項目として扱われ、送らなければその項目・カードが出ないだけで受信自体は失敗しない
# （README「ホスト（VPS・DeskMini）のステータス表示」の「macOS（Mac mini）への設置」を参照）。
#
# 設定は環境変数で渡す（launchd から `set -a; . <envファイル>; set +a` で読み込んでから
# 実行する。README を参照）:
#   OPS_DASHBOARD_URL       必須。例: https://admin.gucchii.com
#   HOST_STATS_TOKEN        必須。ダッシュボード側の HOST_STATS_TOKEN と同じ値
#   HOST_STATS_ID           任意。保存先を分ける識別子。英小文字・数字・-・_（既定: ホスト名から生成）
#   HOST_STATS_LABEL        任意。画面の見出しに使う表示名（既定: ホスト名）
#   HOST_STATS_DISK_PATHS   任意。監視するマウントポイントをカンマ区切りで（既定: /）
#   HOST_STATS_TIMEOUT      任意。送信のタイムアウト秒（既定: 15）
#
# `--print` を付けて実行すると、送信せずに組み立てたJSONを表示する（設置時の確認用）。

set -euo pipefail

PAYLOAD_VERSION=1

# top に2回サンプリングさせ、信頼できる2回目の値を使う（1回目は起動直後の平均で不正確なため）
SAMPLE_SECONDS=1

: "${OPS_DASHBOARD_URL:?OPS_DASHBOARD_URL が未設定です}"
: "${HOST_STATS_TOKEN:?HOST_STATS_TOKEN が未設定です}"
DISK_PATHS="${HOST_STATS_DISK_PATHS:-/}"
TIMEOUT="${HOST_STATS_TIMEOUT:-15}"

HOSTNAME_VALUE="$(hostname)"
HOST_ID="${HOST_STATS_ID:-$(printf '%s' "$HOSTNAME_VALUE" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | sed 's/-*$//')}"
HOST_LABEL="${HOST_STATS_LABEL:-$HOSTNAME_VALUE}"

# JSONの文字列に埋め込めない文字を潰す（agent.shと同じ）
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/[[:cntrl:]]//g'
}

# 「使用量・全体量・使用率(%)」のオブジェクトを組み立てる（agent.shと同じ）
usage_json() {
    local used="$1" total="$2"
    awk -v used="$used" -v total="$total" 'BEGIN {
        percent = (total > 0) ? used / total * 100 : 0
        printf "{\"usedBytes\":%d,\"totalBytes\":%d,\"usedPercent\":%.1f}", used, total, percent
    }'
}

# top -l 2 は2回サンプリングし、-s 秒あけて取った2回目の行が信頼できる値になる
# （1回目は起動からの平均で不正確）。-n 0 でプロセス一覧を省き、サマリー行だけ出す。
# "CPU usage: 11.11% user, 5.55% sys, 83.34% idle" の user・sysを合計する
collect_cpu_percent() {
    top -l 2 -n 0 -s "$SAMPLE_SECONDS" | awk -F'[ %]+' '/^CPU usage:/ { user = $3; sys = $5 } END { printf "%.1f", user + sys }'
}

# hw.memsize が物理メモリの総量（バイト）。vm_stat はページ数で返すため、ヘッダーの
# ページサイズ（Apple Siliconは16KiB、Intelは4KiBのことがある）を読んでから掛ける。
#
# 「使用中」はActivity Monitorの「使用中のメモリ」に合わせ、アクティブ+Wired+圧縮の合計とする。
# 非アクティブ（inactive）は再利用可能なキャッシュのため使用中に数えない。
collect_memory() {
    local total page_size vmstat active wired compressed used
    total="$(sysctl -n hw.memsize)"
    vmstat="$(vm_stat)"
    page_size="$(printf '%s\n' "$vmstat" | sed -n 's/.*page size of \([0-9]*\) bytes.*/\1/p')"
    [ -n "$page_size" ] || page_size=4096

    active="$(printf '%s\n' "$vmstat" | sed -n 's/^Pages active: *\([0-9]*\)\..*/\1/p')"
    wired="$(printf '%s\n' "$vmstat" | sed -n 's/^Pages wired down: *\([0-9]*\)\..*/\1/p')"
    compressed="$(printf '%s\n' "$vmstat" | sed -n 's/^Pages occupied by compressor: *\([0-9]*\)\..*/\1/p')"

    used=$(( (${active:-0} + ${wired:-0} + ${compressed:-0}) * page_size ))
    usage_json "$used" "$total"
}

# Swapを使っていない（ページアウトが無い）マシンでは何も出力しない（ダッシュボード側でカードごと省かれる）
collect_swap() {
    local line total used
    line="$(sysctl -n vm.swapusage 2>/dev/null || true)"
    [ -n "$line" ] || return 0

    # 例: "total = 2048.00M  used = 645.00M  free = 1403.00M  (encrypted)"
    total="$(printf '%s' "$line" | sed -n 's/.*total *= *\([0-9.]*\)M.*/\1/p')"
    used="$(printf '%s' "$line" | sed -n 's/.*used *= *\([0-9.]*\)M.*/\1/p')"
    [ -n "$total" ] && [ -n "$used" ] || return 0

    usage_json \
        "$(awk -v u="$used" 'BEGIN { printf "%.0f", u * 1024 * 1024 }')" \
        "$(awk -v t="$total" 'BEGIN { printf "%.0f", t * 1024 * 1024 }')"
}

collect_disks() {
    local first=1 path fields size used
    printf '['
    while IFS= read -r path; do
        [ -n "$path" ] || continue

        # df -k は1024バイト単位の1行1レコード。size/usedをバイトへ直す
        fields="$(df -k "$path" 2>/dev/null | awk 'NR == 2 { print $2, $3 }')" || fields=""
        [ -n "$fields" ] || continue
        size=$(( ${fields%% *} * 1024 ))
        used=$(( ${fields##* } * 1024 ))

        [ "$first" -eq 1 ] || printf ','
        first=0
        printf '{"path":"%s",' "$(json_escape "$path")"
        usage_json "$used" "$size" | sed 's/^{//'
    done < <(printf '%s\n' "$DISK_PATHS" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    printf ']'
}

# sysctl vm.loadavg は "{ 1.23 1.10 0.95 }" の形で返る
collect_load_average() {
    sysctl -n vm.loadavg | sed -e 's/^{ *//' -e 's/ *}$//' | awk '{ printf "%s,%s,%s", $1, $2, $3 }'
}

# sysctl kern.boottime は "{ sec = 1690000000, usec = 123456 } ..." の形で返る
collect_uptime_seconds() {
    local boot now
    boot="$(sysctl -n kern.boottime | sed -n 's/^{ sec = \([0-9]*\).*/\1/p')"
    now="$(date +%s)"
    awk -v b="${boot:-0}" -v n="$now" 'BEGIN { d = n - b; if (d < 0) d = 0; printf "%d", d }'
}

collect_sessions() {
    local count users first=1 user
    count="$(who 2>/dev/null | wc -l | tr -d '[:space:]')"
    users="$(who 2>/dev/null | awk '{ print $1 }' | sort -u)"

    printf '{"count":%d,"users":[' "${count:-0}"
    while IFS= read -r user; do
        [ -n "$user" ] || continue
        [ "$first" -eq 1 ] || printf ','
        first=0
        printf '"%s"' "$(json_escape "$user")"
    done <<< "$users"
    printf ']}'
}

os_name() {
    local name version
    name="$(sw_vers -productName 2>/dev/null || true)"
    [ -n "$name" ] || name="macOS"
    version="$(sw_vers -productVersion 2>/dev/null || true)"
    if [ -n "$version" ]; then printf '%s %s' "$name" "$version"; else printf '%s' "$name"; fi
}

build_payload() {
    local swap cpu_model cpu_threads
    swap="$(collect_swap)"

    printf '{'
    printf '"version":%d,' "$PAYLOAD_VERSION"
    printf '"id":"%s",' "$(json_escape "$HOST_ID")"
    printf '"label":"%s",' "$(json_escape "$HOST_LABEL")"
    printf '"hostname":"%s",' "$(json_escape "$HOSTNAME_VALUE")"
    printf '"os":"%s",' "$(json_escape "$(os_name)")"
    printf '"kernel":"%s",' "$(json_escape "$(uname -r)")"
    printf '"collectedAt":"%s",' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '"cpuPercent":%s,' "$(collect_cpu_percent)"
    cpu_model="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"
    [ -z "$cpu_model" ] || printf '"cpuModel":"%s",' "$(json_escape "$cpu_model")"
    cpu_threads="$(sysctl -n hw.ncpu 2>/dev/null || true)"
    case "$cpu_threads" in "" | *[!0-9]*) ;; *) printf '"cpuThreads":%d,' "$cpu_threads" ;; esac
    printf '"memory":%s,' "$(collect_memory)"
    [ -z "$swap" ] || printf '"swap":%s,' "$swap"
    printf '"disks":%s,' "$(collect_disks)"
    printf '"loadAverage":[%s],' "$(collect_load_average)"
    printf '"uptimeSeconds":%d,' "$(collect_uptime_seconds)"
    printf '"sessions":%s' "$(collect_sessions)"
    printf '}'
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
}

main "$@"
