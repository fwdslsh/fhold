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
readonly SCHEDULER_ENABLED="${FH_SCHEDULER_ENABLED:-1}"
export FH_RUNTIME_DIR="$RUNTIME_DIR"

# Reject malformed capability inputs before even creating bootstrap files.
for variable in FH_SCHEDULER_ENABLED FH_CODEX_REMOTE FH_CLAUDE_REMOTE; do
  case "${!variable-1}" in
    0|1) ;;
    *) echo "assistant: $variable must be 0 or 1" >&2; exit 1 ;;
  esac
done
case "${FH_CODEX_SANDBOX-workspace-write}" in
  workspace-write|read-only|danger-full-access) ;;
  *) echo 'assistant: FH_CODEX_SANDBOX must be workspace-write, read-only or danger-full-access' >&2; exit 1 ;;
esac
readonly SHUTDOWN_SECONDS="${FH_SHUTDOWN_SECONDS:-25}"
readonly RESTORE_SECONDS="${FH_RESTORE_TIMEOUT_SECONDS:-300}"
readonly RECOVERY_OPERATION_SECONDS="${FH_RECOVERY_OPERATION_TIMEOUT_SECONDS:-120}"
for value in "$SHUTDOWN_SECONDS" "$RESTORE_SECONDS" "$RECOVERY_OPERATION_SECONDS"; do
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]] || [ "$value" -gt 3600 ]; then
    echo 'assistant: runtime deadlines must be integer seconds from 1 to 3600' >&2; exit 1
  fi
done
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

signal_descendants() {
  local parent="$1" signal="$2" child children=""
  if [ -r "/proc/$parent/task/$parent/children" ]; then
    children=$(<"/proc/$parent/task/$parent/children")
  fi
  for child in $children; do signal_descendants "$child" "$signal"; done
  if [ "$signal" = TERM ]; then descendant_pids+=("$parent"); fi
  kill "-$signal" "$parent" 2>/dev/null || true
}

stop_children() {
  [ "$stopping" = 0 ] || return 0
  stopping=1
  trap '' TERM INT
  local pid deadline=$((SECONDS + SHUTDOWN_SECONDS)) alive
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
    kill -TERM "$recovery_pid" 2>/dev/null || true
    deadline=$((SECONDS + RECOVERY_SHUTDOWN_SECONDS))
    while kill -0 "$recovery_pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.1; done
    if kill -0 "$recovery_pid" 2>/dev/null; then
      echo 'assistant: final recovery checkpoint exceeded shutdown deadline' >&2
      signal_descendants "$recovery_pid" KILL
      kill -KILL -- "-$recovery_pid" 2>/dev/null || true
    fi
    wait "$recovery_pid" 2>/dev/null || true
  fi
}
trap 'stop_children; exit 0' TERM INT
trap stop_children EXIT

prepare_identity() {
  if getent passwd "$(id -u)" >/dev/null 2>&1; then return; fi
  local wrapper=""
  for candidate in /usr/lib/*/libnss_wrapper.so /lib/*/libnss_wrapper.so; do
    if [ -e "$candidate" ]; then wrapper="$candidate"; break; fi
  done
  if [ -z "$wrapper" ]; then
    echo "assistant: uid $(id -u) has no passwd entry and libnss-wrapper is unavailable" >&2
    exit 1
  fi
  printf 'opencode:x:%s:%s:fhold Assistant:/home/opencode:/bin/bash\n' "$(id -u)" "$(id -g)" >/tmp/fhold-passwd
  printf 'opencode:x:%s:\n' "$(id -g)" >/tmp/fhold-group
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
    /home/opencode/.cache/opencode \
    /home/opencode/.config/opencode \
    /home/opencode/.local/share/opencode \
    /home/opencode/.local/state/opencode \
    /opt/akm/cache /opt/akm/data/state /stash/tasks /stash/inbox /stash/disabled-tasks /work

  # Native generated SDK dependencies are baked, not installed at boot. Respect
  # mounted read-only configuration and every existing operator cache/package.
  for config in /home/opencode/.config/opencode "${OPENCODE_CONFIG_DIR:-/etc/opencode}"; do
    if [ -w "$config" ] && [ -d /native-defaults/opencode-sdk ]; then
      cp -R -n /native-defaults/opencode-sdk/. "$config/"
    fi
  done

  # Native installers ran during the image build. Seed their generated caches,
  # never account files, trust decisions, or existing operator configuration.
  mkdir -p /home/opencode/.codex/plugins/cache /home/opencode/.claude/plugins
  cp -R -n /native-defaults/codex/plugins/cache/. /home/opencode/.codex/plugins/cache/
  cp -R -n /native-defaults/claude/plugins/cache/. /home/opencode/.claude/plugins/cache/
  for file in claude/settings.json claude/plugins/installed_plugins.json claude/plugins/known_marketplaces.json codex/config.toml; do
    local source="/native-defaults/$file" target="/home/opencode/.$file" previous="/home/opencode/.fhold-native-defaults/$file"
    # Refresh only untouched generated defaults. Native user settings, installed
    # plugins, authentication and hook trust always take precedence.
    if [ ! -e "$target" ] || { [ -f "$previous" ] && cmp -s "$target" "$previous"; }; then
      cp "$source" "$target"
      mkdir -p "$(dirname "$previous")"
      cp "$source" "$previous"
    fi
  done

  for required in \
    opencode.jsonc \
    AGENTS.md \
    agents/remote.md \
    agents/remote-read.md \
    agents/remote-full.md \
    agents/scheduled.md \
    agents/memory.md \
    lib/memory.js \
    plugins/akm.js; do
    if [ ! -r "${OPENCODE_CONFIG_DIR:-/etc/opencode}/$required" ]; then
      echo "assistant: managed OpenCode config is missing $required" >&2
      exit 1
    fi
  done
  if [ ! -r /opt/fhold/tools/node_modules/akm-opencode/dist/index.js ]; then
    echo 'assistant: image-baked AKM OpenCode plugin is missing' >&2
    exit 1
  fi
  if [ "$SCHEDULER_ENABLED" = 1 ] && [ ! -x /usr/local/bin/fhold-task ]; then
    echo 'assistant: fhold task helper is missing' >&2
    exit 1
  fi
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
  mkdir -p "$TASK_SPOOL_DIR" "$TASK_BIN_DIR"
  local shim="$TASK_BIN_DIR/crontab"
  cat >"$shim" <<'SHIM'
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
  chmod 0755 "$shim"
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
  } >"$file"
}

sync_tasks() {
  if akm task sync --rebind >&2; then
    date +%s >"$RUNTIME_DIR/tasks-synced"
  else
    rm -f "$RUNTIME_DIR/tasks-synced"
    echo 'assistant: task sync failed; health is degraded until schedules reconcile' >&2
    return 1
  fi
}

start_scheduler() {
  install_crontab_shim
  write_cron_environment
  export -f sync_tasks
  export RUNTIME_DIR
  # Initial reconciliation can spawn AKM/native descendants too. Keep it in a
  # tracked group so a signal during boot cannot leave a state writer behind.
  setsid env "${writer_env[@]}" bash -c 'sync_tasks' &
  local initial_sync_pid=$!
  writer_pids+=("$initial_sync_pid")
  wait "$initial_sync_pid" || true
  unset 'writer_pids[-1]'
  setsid env "${writer_env[@]}" supercronic -inotify "$TASK_CRONTAB" &
  scheduler_pid=$!
  writer_pids+=("$scheduler_pid")
  essential_pids+=("$scheduler_pid")
  printf '%s\n' "$scheduler_pid" >"$RUNTIME_DIR/scheduler.pid"
  setsid env "${writer_env[@]}" bash -c 'while sleep 60; do sync_tasks || true; done' &
  reconciliation_pid=$!
  writer_pids+=("$reconciliation_pid")
  essential_pids+=("$reconciliation_pid")
  printf '%s\n' "$reconciliation_pid" >"$RUNTIME_DIR/reconciliation.pid"
}

required_binaries=(opencode akm setsid env)
if [ "$SCHEDULER_ENABLED" = 1 ]; then required_binaries+=(supercronic); fi
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
if [ -n "${FH_RECOVERY_URL:-}" ]; then
  export FH_RECOVERY_PARENT_PID=$$
  # A stale gate from a previous worker must never admit native writers.
  rm -f "$RUNTIME_DIR/recovery-restored" "$RUNTIME_DIR/recovery-writers-started" "$RUNTIME_DIR/recovery-status.json"
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
if [ "$SCHEDULER_ENABLED" = 1 ]; then start_scheduler; fi

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

remote_pids=()
for tool in codex claude; do
  variable="FH_${tool^^}_REMOTE"
  case "${!variable-1}" in
    0) ;;
    1) setsid env "${writer_env[@]}" fhold-remote "$tool" & remote_pids+=("$!"); writer_pids+=("$!") ;;
    *) echo "assistant: $variable must be 0 or 1" >&2; exit 1 ;;
  esac
done

if [ -n "$recovery_pid" ]; then
  printf 'ready\n' >"$RUNTIME_DIR/recovery-writers-started"
fi

# Any essential child exiting stops the container. Compose restart policy
# recovers all three together; cron resumes at future slots, never replays.
status=0
wait -n "${essential_pids[@]}" || status=$?
echo 'assistant: an essential process stopped; restarting the stack service' >&2
stop_children
if [ "$status" = 0 ]; then status=1; fi
exit "$status"
