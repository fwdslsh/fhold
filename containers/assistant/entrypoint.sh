#!/usr/bin/env bash
set -euo pipefail

readonly OPENCODE_PORT="${OPENCODE_PORT:-4096}"
readonly TASK_SPOOL_DIR=/tmp/fhold-crontabs
readonly TASK_BIN_DIR=/tmp/fhold-bin
readonly TASK_CRONTAB="$TASK_SPOOL_DIR/fhold"
readonly RUNTIME_DIR="${FH_RUNTIME_DIR:-/tmp/fhold-runtime}"
if [[ "$RUNTIME_DIR" != /* ]] || [ "$RUNTIME_DIR" = / ] || [[ "$RUNTIME_DIR" =~ (^|/)\.{1,2}(/|$) ]] || [[ "$RUNTIME_DIR" == *//* ]]; then
  echo 'assistant: private runtime directory must be an absolute non-root path' >&2
  exit 1
fi
runtime_parent="$RUNTIME_DIR"
while [ "$runtime_parent" != / ]; do
  if [ -L "$runtime_parent" ]; then
    echo 'assistant: private runtime directory cannot contain symbolic links' >&2
    exit 1
  fi
  runtime_parent=$(dirname "$runtime_parent")
done
SCHEDULER_ENABLED="${FH_SCHEDULER_ENABLED:-1}"
configuration_degraded=0
export FH_RUNTIME_DIR="$RUNTIME_DIR"

# Invalid optional settings disable only that feature; never grant extra access.
case "$SCHEDULER_ENABLED" in
  0|1) ;;
  *) echo 'assistant: FH_SCHEDULER_ENABLED must be 0 or 1; scheduling is disabled' >&2
     SCHEDULER_ENABLED=0; configuration_degraded=1 ;;
esac
runtime_seconds() {
  local variable="$1" name="$2" fallback="$3" value="${!2:-$3}"
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]] || [ "$value" -gt 3600 ]; then
    echo "assistant: $name must be integer seconds from 1 to 3600; using $fallback" >&2
    value="$fallback"; configuration_degraded=1
  fi
  printf -v "$variable" '%s' "$value"
}
runtime_seconds SHUTDOWN_SECONDS FH_SHUTDOWN_SECONDS 25
runtime_seconds RESTORE_SECONDS FH_RESTORE_TIMEOUT_SECONDS 300
runtime_seconds RECOVERY_OPERATION_SECONDS FH_RECOVERY_OPERATION_TIMEOUT_SECONDS 120
readonly SHUTDOWN_SECONDS RESTORE_SECONDS RECOVERY_OPERATION_SECONDS
export FH_RECOVERY_OPERATION_TIMEOUT_SECONDS="$RECOVERY_OPERATION_SECONDS"
# TERM may arrive during a capture. Finish that bounded operation, then take a
# separate stopped-writer checkpoint and release ownership. The writer budget
# must not truncate these two operations. External hosts must allow the sum of
# both phases (plus the two-second killed-writer settling interval).
readonly RECOVERY_SHUTDOWN_SECONDS=$((2 * RECOVERY_OPERATION_SECONDS + 30))
writer_pids=()
descendant_pids=()
essential_pids=()
recovery_pid=""
stopping=0
writer_env=(-u FH_RECOVERY_PARENT_PID)
# Storage and managed-identity selectors belong only to the recovery worker.
# This is environment minimization, not isolation from same-UID private files.
while IFS= read -r variable; do
  case "$variable" in
    FH_RECOVERY_*|FH_INSTANCE_ID|AZURE_CLIENT_ID|IDENTITY_*|MSI_*|IMDS_*)
      writer_env+=(-u "$variable") ;;
  esac
done < <(compgen -e)

mark_degraded() {
  echo "assistant: $2" >&2
  printf '%s\n' "$2" >"$RUNTIME_DIR/degraded-$1" || true
}

signal_descendants() {
  local parent="$1" signal="$2" child children=""
  if [ -r "/proc/$parent/task/$parent/children" ]; then
    # A child may exit/reap after the check. A vanished /proc entry must not
    # make errexit abandon shutdown before the recovery owner is released.
    { children=$(<"/proc/$parent/task/$parent/children"); } 2>/dev/null || children=""
  fi
  for child in $children; do signal_descendants "$child" "$signal"; done
  if [ "$signal" = TERM ]; then descendant_pids+=("$parent"); fi
  kill "-$signal" "$parent" 2>/dev/null || true
}

stop_children() {
  [ "$stopping" = 0 ] || return 0
  stopping=1
  trap '' TERM INT
  local pid deadline=$((SECONDS + SHUTDOWN_SECONDS)) alive recovery_status=0
  echo 'assistant: shutdown: stopping native writers' >&2
  # Groups catch orphaned grandchildren; /proc traversal also catches native
  # workers that started their own session. Recovery stays alive until last.
  for pid in "${writer_pids[@]}"; do
    signal_descendants "$pid" TERM
    kill -TERM -- "-$pid" 2>/dev/null || true
  done
  while [ "$SECONDS" -lt "$deadline" ]; do
    alive=0
    for pid in "${writer_pids[@]}"; do
      if kill -0 -- "-$pid" 2>/dev/null; then alive=1; fi
    done
    for pid in "${descendant_pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    [ "$alive" = 1 ] || break
    sleep 0.1
  done
  for pid in "${writer_pids[@]}"; do
    signal_descendants "$pid" KILL
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  for pid in "${descendant_pids[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
  # SIGKILL is asynchronous. Do not checkpoint while a killed descendant is
  # still runnable; zombies are stopped and will be reaped by image PID 1.
  deadline=$((SECONDS + 2))
  while :; do
    alive=0
    for pid in "${descendant_pids[@]}"; do
      if [ -r "/proc/$pid/stat" ]; then
        local stat="$(<"/proc/$pid/stat")"
        stat="${stat##*) }"
        case "$stat" in Z\ *|X\ *) ;; *) alive=1 ;; esac
      fi
    done
    [ "$alive" = 1 ] || break
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo 'assistant: writer could not be stopped; refusing final recovery checkpoint' >&2
      if [ -n "$recovery_pid" ]; then signal_descendants "$recovery_pid" KILL; fi
      return 1
    fi
    sleep 0.1
  done
  if [ -n "$recovery_pid" ]; then
    echo 'assistant: shutdown: writers stopped; finishing recovery checkpoint and owner release' >&2
    kill -TERM "$recovery_pid" 2>/dev/null || true
    deadline=$((SECONDS + RECOVERY_SHUTDOWN_SECONDS))
    while kill -0 "$recovery_pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.1; done
    if kill -0 "$recovery_pid" 2>/dev/null; then
      echo 'assistant: final recovery checkpoint exceeded shutdown deadline' >&2
      signal_descendants "$recovery_pid" KILL
      kill -KILL -- "-$recovery_pid" 2>/dev/null || true
    fi
    wait "$recovery_pid" 2>/dev/null || recovery_status=$?
    if [ "$recovery_status" -ne 0 ]; then
      echo 'assistant: shutdown: recovery failed; retain logs and verify checkpoint and ownership before restarting' >&2
      return "$recovery_status"
    fi
    echo 'assistant: shutdown: recovery checkpoint completed and owner released' >&2
  fi
  echo 'assistant: shutdown complete' >&2
}
trap 'status=0; stop_children || status=$?; exit "$status"' TERM INT
trap stop_children EXIT

prepare_identity() {
  if [ "$(id -un 2>/dev/null)" = fhold ]; then return; fi
  local wrapper=""
  for candidate in /usr/lib/*/libnss_wrapper.so /lib/*/libnss_wrapper.so; do
    if [ -e "$candidate" ]; then wrapper="$candidate"; break; fi
  done
  if [ -z "$wrapper" ]; then
    echo "assistant: uid $(id -u) has no passwd entry and libnss-wrapper is unavailable" >&2
    exit 1
  fi
  printf 'fhold:x:%s:%s:fhold Assistant:/home/fhold:/bin/bash\n' "$(id -u)" "$(id -g)" >/tmp/fhold-passwd
  printf 'fhold:x:%s:\n' "$(id -g)" >/tmp/fhold-group
  export NSS_WRAPPER_PASSWD=/tmp/fhold-passwd
  export NSS_WRAPPER_GROUP=/tmp/fhold-group
  export LD_PRELOAD="$wrapper${LD_PRELOAD:+:$LD_PRELOAD}"
}

prepare_filesystem() {
  # Authoritative image assets supply standalone defaults; mounted/operator
  # files always win. The build manifest contains only reviewed fixed targets.
  if [ -r /assistant-defaults/manifest.tsv ]; then
    while IFS=$'\t' read -r source target; do
      [ -n "$source" ] || continue
      if [ ! -e "$target" ] && [ ! -L "$target" ]; then
        mkdir -p "$(dirname "$target")"
        cp "/assistant-defaults/$source" "$target"
      fi
    done </assistant-defaults/manifest.tsv
  fi
  mkdir -p \
    /home/fhold/.cache/opencode \
    /home/fhold/.config/opencode \
    /home/fhold/.local/share/opencode \
    /home/fhold/.local/state/opencode \
    /opt/akm/cache /opt/akm/data/state /stash/tasks /stash/inbox /stash/disabled-tasks /work

  # Native generated SDK dependencies are baked, not installed at boot. Respect
  # mounted read-only configuration and every existing operator cache/package.
  for config in /home/fhold/.config/opencode "${OPENCODE_CONFIG_DIR:-/etc/opencode}"; do
    if [ -w "$config" ] && [ -d /native-defaults/opencode-sdk ]; then
      cp -R -n /native-defaults/opencode-sdk/. "$config/"
    fi
  done

  if ! prepare_native_defaults; then
    mark_degraded native-defaults 'Native remote defaults could not be prepared. Check home permissions and recent logs, then restart; OpenCode remains available.'
  fi
}

prepare_native_defaults() {
  # These optional caches/settings must never hold the primary server hostage.
  # Native user files, authentication and trust decisions still take precedence.
  mkdir -p /home/fhold/.codex/plugins/cache /home/fhold/.claude/plugins || return
  cp -R -n /native-defaults/codex/plugins/cache/. /home/fhold/.codex/plugins/cache/ || return
  cp -R -n /native-defaults/claude/plugins/cache/. /home/fhold/.claude/plugins/cache/ || return
  for file in claude/settings.json claude/plugins/installed_plugins.json claude/plugins/known_marketplaces.json codex/config.toml; do
    local source="/native-defaults/$file" target="/home/fhold/.$file" previous="/home/fhold/.fhold-native-defaults/$file"
    # Refresh only untouched generated defaults. Native user settings, installed
    # plugins, authentication and hook trust always take precedence.
    if [ ! -e "$target" ] || { [ -f "$previous" ] && cmp -s "$target" "$previous"; }; then
      cp "$source" "$target" || return
      mkdir -p "$(dirname "$previous")" || return
      cp "$source" "$previous" || return
    fi
  done
}

load_opencode_password() {
  local file="${OPENCODE_SERVER_PASSWORD_FILE:-}"
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ] && [ -n "$file" ] && [ -s "$file" ]; then
    OPENCODE_SERVER_PASSWORD="$(tr -d '\r\n' <"$file")"
    export OPENCODE_SERVER_PASSWORD
  fi
  if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
    echo 'assistant: refusing to start without an OpenCode server password' >&2
    exit 1
  fi
}

install_crontab_shim() {
  mkdir -p "$TASK_SPOOL_DIR" "$TASK_BIN_DIR" || return
  local shim="$TASK_BIN_DIR/crontab"
  cat >"$shim" <<'SHIM' || return
#!/usr/bin/env sh
set -eu
file="/tmp/fhold-crontabs/fhold"
case "${1:--}" in
  -l) cat "$file" 2>/dev/null ;;
  -r) rm -f "$file" ;;
  -) cat >"$file" ;;
  -*) echo "crontab: unsupported option: $1" >&2; exit 1 ;;
  *) cat "$1" >"$file" ;;
esac
SHIM
  [ -f "$shim" ] && chmod 0755 "$shim" || return
  export PATH="$TASK_BIN_DIR:$PATH"
}

write_cron_environment() {
  local file="$TASK_CRONTAB"
  {
    echo '# fhold managed environment'
    echo 'SHELL=/bin/bash'
    echo "PATH=$PATH"
  for name in TZ HOME AKM_BUNDLE_DIR AKM_CONFIG_DIR AKM_CACHE_DIR AKM_DATA_DIR AKM_STATE_DIR OPENCODE_API_URL OPENCODE_CONFIG_DIR; do
      if [ -n "${!name:-}" ]; then printf '%s=%s\n' "$name" "${!name}"; fi
    done
  } >"$file" || return
  if [ "$KEEPALIVE_ENABLED" = 1 ]; then
    # Supercronic's seven-field format includes seconds. AKM preserves this
    # product-owned line while reconciling its own marked task blocks.
    printf '%s\n' '*/20 * * * * * * /usr/local/bin/fhold-keepalive tick' >>"$file" || return
  fi
}

sync_tasks() {
  if akm task sync --rebind >&2; then
    date +%s >"$RUNTIME_DIR/tasks-synced"
  else
    rm -f "$RUNTIME_DIR/tasks-synced"
    echo 'assistant: task sync failed; scheduling is degraded and will retry; OpenCode remains available' >&2
    return 1
  fi
}

start_scheduler() {
  install_crontab_shim || return
  write_cron_environment || return
  export -f sync_tasks
  export RUNTIME_DIR
  setsid env "${writer_env[@]}" supercronic -inotify "$TASK_CRONTAB" &
  scheduler_pid=$!
  writer_pids+=("$scheduler_pid")
  printf '%s\n' "$scheduler_pid" >"$RUNTIME_DIR/scheduler.pid"
  if [ "$SCHEDULER_ENABLED" = 1 ]; then
    setsid env "${writer_env[@]}" bash -c 'sync_tasks || true; while sleep 60; do sync_tasks || true; done' &
    reconciliation_pid=$!
    writer_pids+=("$reconciliation_pid")
    printf '%s\n' "$reconciliation_pid" >"$RUNTIME_DIR/reconciliation.pid"
  fi
}

required_binaries=(opencode setsid env)
if [ -n "${FH_RECOVERY_URL:-}" ]; then required_binaries+=(fhold-recovery); fi
for binary in "${required_binaries[@]}"; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "assistant: required binary not found: $binary" >&2
    exit 1
  fi
done

prepare_identity
umask 077
if [ -L "$RUNTIME_DIR" ]; then
  echo 'assistant: private runtime directory cannot be a symbolic link' >&2
  exit 1
fi
mkdir -p "$RUNTIME_DIR"
chmod 0700 "$RUNTIME_DIR"
# These are boot diagnostics, not restored instance state.
rm -f "$RUNTIME_DIR/recovery.pid" "$RUNTIME_DIR/reconciliation.pid" "$RUNTIME_DIR/tasks-synced" || true
for feature in configuration scheduler keepalive codex claude native-defaults; do
  rm -f "$RUNTIME_DIR/degraded-$feature" "$RUNTIME_DIR/$feature.pid" || true
done
if [ "$configuration_degraded" = 1 ]; then
  mark_degraded configuration 'Some runtime settings are invalid; conservative defaults are in use. Correct the logged setting names and restart.'
fi
if [ -n "${FH_RECOVERY_URL:-}" ]; then
  export FH_RECOVERY_PARENT_PID=$$
  # A stale gate from a previous worker must never admit native writers.
  rm -f "$RUNTIME_DIR/recovery-restored" "$RUNTIME_DIR/recovery-writers-started"
  # The worker retries diagnostic publication; inability to clear an old status
  # file is not a restoration or ownership failure.
  rm -f "$RUNTIME_DIR/recovery-status.json" 2>/dev/null || true
  setsid fhold-recovery run &
  recovery_pid=$!
  essential_pids+=("$recovery_pid")
  printf '%s\n' "$recovery_pid" >"$RUNTIME_DIR/recovery.pid"
  deadline=$((SECONDS + RESTORE_SECONDS))
  until [ -f "$RUNTIME_DIR/recovery-restored" ]; do
    if ! kill -0 "$recovery_pid" 2>/dev/null || [ "$SECONDS" -ge "$deadline" ]; then
      echo 'assistant: recovery did not complete; refusing native startup' >&2
      exit 1
    fi
    sleep 0.1
  done
fi
prepare_filesystem
load_opencode_password
KEEPALIVE_ENABLED=0
if fhold-keepalive init >/dev/null; then
  if [ -n "${FH_KEEPALIVE_URL:-}" ]; then KEEPALIVE_ENABLED=1; fi
else
  mark_degraded keepalive 'Keep-alive could not initialize. Correct its URL or authorization-file settings and restart; the agent remains available.'
fi
if [ "$SCHEDULER_ENABLED" = 1 ] && { ! command -v akm >/dev/null || ! command -v fhold-task >/dev/null; }; then
  SCHEDULER_ENABLED=0
  mark_degraded scheduler 'Scheduling is unavailable: AKM or the task helper is missing. Use a complete Assistant image and restart.'
fi

cd /work
setsid env "${writer_env[@]}" opencode serve \
  --hostname 0.0.0.0 \
  --port "$OPENCODE_PORT" \
  --print-logs \
  --log-level "${OPENCODE_LOG_LEVEL:-INFO}" &
assistant_pid=$!
writer_pids+=("$assistant_pid")
essential_pids+=("$assistant_pid")
printf '%s\n' "$assistant_pid" >"$RUNTIME_DIR/assistant.pid"

if [ "$SCHEDULER_ENABLED" = 1 ] || [ "$KEEPALIVE_ENABLED" = 1 ]; then
  if ! command -v supercronic >/dev/null || ! start_scheduler; then
    mark_degraded scheduler 'Scheduling and keep-alive could not start. Check scheduler files, permissions and recent logs, then restart; the agent remains available.'
  fi
fi

for tool in codex claude; do
  variable="FH_${tool^^}_REMOTE"
  case "${!variable-1}" in
    0) ;;
    1) setsid env "${writer_env[@]}" fhold-remote "$tool" & writer_pids+=("$!")
       printf '%s\n' "$!" >"$RUNTIME_DIR/$tool.pid" || mark_degraded "$tool" "$tool remote process diagnostics could not be written. Check runtime permissions; OpenCode remains available." ;;
    *) mark_degraded "$tool" "$variable must be 0 or 1; this optional remote worker is disabled. Correct the setting and restart." ;;
  esac
done

if [ -n "$recovery_pid" ]; then
  printf 'ready\n' >"$RUNTIME_DIR/recovery-writers-started"
fi

# Only the primary server or recovery owner may stop the container. Optional
# worker failures are reported by health diagnostics, not restart tripwires.
status=0
wait -n "${essential_pids[@]}" || status=$?
echo 'assistant: an essential process stopped; restarting the stack service' >&2
stop_children
if [ "$status" = 0 ]; then status=1; fi
exit "$status"
