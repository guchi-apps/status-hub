#!/usr/bin/env bash
# CI / デプロイの失敗をDiscordの異常通知へ送る（GitHub Actions 用。#625。Signalyの代わり）
#
# Requires: DISCORD_ALERT_WEBHOOK_URL, NOTIFY_STATUS (success|failure|cancelled)
# Optional: NOTIFY_APP, NOTIFY_KIND (CI / デプロイ), NOTIFY_JOB
#
# **失敗のときだけ送る。** 成功・キャンセル・リリースは通知しない（異常時のみ通知する方針）。
# **どう転んでも終了コードは0で返す**。通知先が落ちていてもrunを赤くしない。
set -euo pipefail

if [[ "${NOTIFY_STATUS:-}" != "failure" ]]; then
  echo "失敗ではないため通知しません (${NOTIFY_STATUS:-unknown})"
  exit 0
fi

if [[ -z "${DISCORD_ALERT_WEBHOOK_URL:-}" ]]; then
  echo "DISCORD_ALERT_WEBHOOK_URL not set; skipping notification"
  exit 0
fi

run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"

payload=$(python3 - "$run_url" <<'PY'
import json
import os
import sys

env = os.environ.get
title = f"❌ [{env('NOTIFY_APP', '')}] {env('NOTIFY_KIND', env('GITHUB_WORKFLOW', ''))} 失敗"
fields = [
    {"name": "Repository", "value": f"`{env('GITHUB_REPOSITORY', '')}`", "inline": True},
    {"name": "Branch", "value": env("GITHUB_REF_NAME", ""), "inline": True},
    {"name": "Commit", "value": f"`{env('GITHUB_SHA', '')[:7]}`", "inline": True},
]
if env("NOTIFY_JOB"):
    fields.append({"name": "Job", "value": env("NOTIFY_JOB"), "inline": True})
fields.append({"name": "Run", "value": f"[Workflow Run]({sys.argv[1]})", "inline": False})
print(json.dumps({"embeds": [{"title": title, "color": 15548997, "fields": fields}]}))
PY
)

# curlのstderrは出さない（接続失敗時にwebhookのホスト名が公開ログへ載るため）。HTTPコードと終了コードで切り分ける
http_code=""
curl_status=0
http_code="$(curl -fsS -o /dev/null -w '%{http_code}' \
  --max-time 10 --retry 2 --retry-delay 2 \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "$DISCORD_ALERT_WEBHOOK_URL" 2>/dev/null)" || curl_status=$?

if [[ "$curl_status" -eq 0 ]]; then
  echo "Discordへ通知しました (HTTP ${http_code})"
else
  echo "::warning::Discordへの通知に失敗しました (HTTP ${http_code:-000} / curl exit ${curl_status})。このrunは成功として扱います"
fi
exit 0
