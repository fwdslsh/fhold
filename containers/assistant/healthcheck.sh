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
curl --max-time 5 -sf -u "${OPENCODE_SERVER_USERNAME:-user}:$password" \
  "http://127.0.0.1:${OPENCODE_PORT:-4096}/config" >/dev/null

# A usable authenticated agent is live even when optional work is degraded.
# Docker retains this output in its health log; CLI/Admin display the warnings.
warning() { printf 'fhold: degraded: %s\n' "$1"; }
for feature in configuration scheduler keepalive codex claude native-defaults knowledge memory activity; do
  if [ -s "$runtime/degraded-$feature" ]; then
    warning "$(cat "$runtime/degraded-$feature")"
  fi
done
if [ "${FH_SCHEDULER_ENABLED-1}" = 1 ] && [ ! -s "$runtime/degraded-scheduler" ]; then
  alive scheduler || warning 'Scheduled tasks are unavailable. Check scheduler logs and restart to resume them; the agent is still usable.'
  alive reconciliation || warning 'Task reconciliation is unavailable. Check AKM settings and logs, then restart.'
  synced=$(cat "$runtime/tasks-synced" 2>/dev/null || true)
  if ! [[ "$synced" =~ ^[0-9]+$ ]] || [ "$(( $(date +%s) - synced ))" -ge 180 ]; then
    warning 'Task reconciliation is overdue or failing. It will retry; review task definitions, AKM settings and recent logs.'
  fi
fi
if [ -n "${FH_KEEPALIVE_URL:-}" ] && [ ! -s "$runtime/degraded-keepalive" ]; then
  alive scheduler || warning 'Keep-alive is unavailable. Check scheduler logs and restart; the agent is still usable.'
  if ! fhold-keepalive status >/dev/null; then
    warning 'Keep-alive needs attention. Review its configuration and recent logs; failed requests retry automatically.'
  fi
fi
for tool in codex claude; do
  variable="FH_${tool^^}_REMOTE"
  if [ "${!variable-1}" = 1 ] && [ ! -s "$runtime/degraded-$tool" ]; then
    alive "$tool" || warning "$tool remote connection is unavailable. Check its status and recent logs, then restart; OpenCode remains available."
  fi
done
if [ -n "${FH_RECOVERY_URL:-}" ] && ! fhold-recovery status >/dev/null; then
  warning 'Recovery diagnostics are unavailable. Check private runtime permissions and logs; the live recovery owner remains required.'
fi
exit 0
