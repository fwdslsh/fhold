#!/bin/bash
set -euo pipefail

export PATH="/opt/fhold/node_modules/.bin:$PATH"
mkdir -p /opt/fhold/logs

require_strong_secret() {
  local name=$1 path=${!1:-} value
  if [ -z "$path" ] || [ ! -r "$path" ]; then
    echo "ERROR: $name must name a readable secret file" >&2
    exit 1
  fi
  value=$(tr -d '\r\n' <"$path")
  if [ "${#value}" -lt 32 ]; then
    echo "ERROR: $name must contain at least 32 characters" >&2
    exit 1
  fi
}
guardian_auth_dir=${GUARDIAN_AUTH_DIR:-}
if [ -z "$guardian_auth_dir" ] || [ ! -r "$guardian_auth_dir/registry.json" ]; then
  echo "ERROR: GUARDIAN_AUTH_DIR must contain a readable credential registry" >&2
  exit 1
fi
require_strong_secret GUARDIAN_HANDLE_KEY_FILE
require_strong_secret OPENCODE_SERVER_PASSWORD_FILE
exec bun run /opt/fhold/guardian-app/src/server.ts
