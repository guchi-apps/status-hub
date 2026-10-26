#!/usr/bin/env bash
# マニフェストから、ワークフローのジョブに書く env: ブロックを生成する（#51）。
#
# ワークフローのジョブに書く env: ブロックは、organizationの共通値が中立な名前に
# なっている（HOST → SERVER_HOST など）ため手で書くと間違えやすい。
# マニフェストのGH_NAME列から機械生成する。
#
# 使い方:
#   scripts/generate-workflow-env-block.sh              # 全件
#   scripts/generate-workflow-env-block.sh DISCORD_ALERT_WEBHOOK_URL,HOST
#
# インデントは既定6（ジョブ直下の env: の下）。第2引数で変更できる。
set -euo pipefail

MANIFEST="${MANIFEST:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/secrets-manifest.tsv}"
ONLY="${1:-}"
INDENT="${2:-6}"
pad="$(printf '%*s' "$INDENT" '')"

while IFS=$'\t' read -r key scope kind gh_name source; do
  [[ -z "${key:-}" || "$key" == \#* ]] && continue
  [[ -z "${source:-}" ]] && continue
  if [[ -n "$ONLY" && ",$ONLY," != *",$key,"* ]]; then
    continue
  fi
  if [[ "$kind" == "var" ]]; then
    printf '%s%s: ${{ vars.%s }}\n' "$pad" "$key" "$gh_name"
  else
    printf '%s%s: ${{ secrets.%s }}\n' "$pad" "$key" "$gh_name"
  fi
done < "$MANIFEST"
