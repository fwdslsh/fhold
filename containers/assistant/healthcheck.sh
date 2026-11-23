#!/usr/bin/env bash
set -euo pipefail
runtime="${FH_RUNTIME_DIR:-/tmp/fhold-runtime}"
children=(assistant)
if [ -n "${FH_RECOVERY_URL:-}" ]; then
  test -f "$runtime/recovery-restored"
  children+=(recovery)
fi
alive() {
  test -s "$runtime/$1.pid" && kill -0 -- "$(cat "$runtime/$1.pid")" 2>/dev/null
}
for child in "${children[@]}"; do
  alive "$child"
done
password_file="${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}"
password="${OPENCODE_SERVER_PASSWORD:-}"
if [ -z "$password" ]; then
  test -s "$password_file"
  password="$(tr -d '\r\n' <"$password_file")"
fi
test -n "$password"
curl --max-time 5 -sf -u "opencode:$password" \
  "http://127.0.0.1:${OPENCODE_PORT:-4096}/api/info" >/dev/null

# A usable authenticated agent is live even when optional work is degraded.
# Docker retains this output in its health log; CLI/Admin display the warnings.
warning() { printf 'fhold: degraded: %s\n' "$1"; }
for file in "$runtime"/degraded-*; do
  if [ -s "$file" ]; then
    warning "$(cat "$file")"
  fi
done
if ! keyring_status=$(fhold-keyring status 2>/dev/null); then
  warning "$keyring_status"
fi
if [ "${FH_SCHEDULER_ENABLED-1}" = 1 ] && [ ! -s "$runtime/degraded-scheduler" ]; then
  alive scheduler || warning 'Scheduled tasks are unavailable. Check scheduler logs and restart to resume them; the agent is still usable.'
fi
if [ -n "${FH_KEEPALIVE_URL:-}" ] && [ ! -s "$runtime/degraded-keepalive" ]; then
  alive scheduler || warning 'Keep-alive is unavailable. Check scheduler logs and restart; the agent is still usable.'
  if ! fhold-keepalive status >/dev/null; then
    warning 'Keep-alive needs attention. Review its configuration and recent logs; failed requests retry automatically.'
  fi
fi
for tool in codex claude; do
  if [ -r /opt/fhold/tools/package.json ] && ! jq -e --arg tool "$tool" '.harnesses | index($tool) != null' /opt/fhold/tools/package.json >/dev/null; then continue; fi
  variable="FH_${tool^^}_REMOTE"
  if [ "${!variable-1}" = 1 ] && [ ! -s "$runtime/degraded-$tool" ]; then
    alive "$tool" || warning "$tool remote connection is unavailable. Check its status and recent logs, then restart; OpenCode remains available."
  fi
done
if [ -n "${FH_RECOVERY_URL:-}" ] && ! fhold-recovery status >/dev/null; then
  warning 'Recovery diagnostics are unavailable. Check private runtime permissions and logs; the live recovery owner remains required.'
fi
exit 0
