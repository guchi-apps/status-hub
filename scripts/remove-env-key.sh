#!/usr/bin/env bash
# Safely remove KEY from a dotenv file (no-op if the file or key is absent).
# Usage: bash scripts/remove-env-key.sh <env-file> <key>
set -euo pipefail

ENV_FILE="${1:?env file path required}"
KEY="${2:?key required}"

python3 - "$ENV_FILE" "$KEY" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]

if not path.exists():
    sys.exit(0)

pattern = re.compile(rf"^{re.escape(key)}=")
lines = path.read_text(encoding="utf-8").splitlines()
out = [line for line in lines if not pattern.match(line)]

if len(out) != len(lines):
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
