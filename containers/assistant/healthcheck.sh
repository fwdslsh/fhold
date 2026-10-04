#!/usr/bin/env bash
set -euo pipefail
runtime="${FH_RUNTIME_DIR:-/tmp/fhold-runtime}"
case "${FH_SCHEDULER_ENABLED-1}" in 0|1) ;; *) exit 1 ;; esac
children=(assistant)
if [ "${FH_SCHEDULER_ENABLED-1}" = 1 ] || [ -n "${FH_KEEPALIVE_URL:-}" ]; then children+=(scheduler); fi
if [ "${FH_SCHEDULER_ENABLED-1}" = 1 ]; then children+=(reconciliation); fi
if [ -n "${FH_RECOVERY_URL:-}" ]; then
  test -f "$runtime/recovery-restored"
  fhold-recovery status >/dev/null
  children+=(recovery)
fi
for child in "${children[@]}"; do
  test -s "$runtime/$child.pid"
  kill -0 "$(cat "$runtime/$child.pid")" 2>/dev/null
done
if [ "${FH_SCHEDULER_ENABLED-1}" = 1 ]; then
  test -s "$runtime/tasks-synced"
  now=$(date +%s)
  synced=$(cat "$runtime/tasks-synced")
  [[ "$synced" =~ ^[0-9]+$ ]]
  test "$((now - synced))" -ge 0
  test "$((now - synced))" -lt 180
fi
password_file="${OPENCODE_SERVER_PASSWORD_FILE:-/run/secrets/opencode_server_password}"
password="${OPENCODE_SERVER_PASSWORD:-}"
if [ -z "$password" ]; then
  test -s "$password_file"
  password="$(tr -d '\r\n' <"$password_file")"
fi
test -n "$password"
curl --max-time 5 -sf -u "${OPENCODE_SERVER_USERNAME:-user}:$password" \
  "http://127.0.0.1:${OPENCODE_PORT:-4096}/config" >/dev/null
