#!/usr/bin/env bash
set -euo pipefail

readonly OPENCODE_PORT="${OPENCODE_PORT:-4096}"
readonly TASK_SPOOL_DIR=/tmp/fhold-crontabs
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
# Extra browser origins for OpenCode's own origin check (`serve --cors`). Each
# must be an exact origin as browsers send it; one invalid entry discards the
# list and OpenCode keeps its default origins.
cors_args=()
if [ -n "${FH_OPENCODE_CORS:-}" ]; then
  IFS=',' read -r -a cors_origins <<<"$FH_OPENCODE_CORS"
  for origin in "${cors_origins[@]}"; do
    origin="${origin#"${origin%%[![:space:]]*}"}"
    origin="${origin%"${origin##*[![:space:]]}"}"
    if [[ "$origin" =~ ^(https?)://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:([1-9][0-9]{0,4}))?$ ]] &&
       { [ -z "${BASH_REMATCH[6]}" ] || { [ "${BASH_REMATCH[6]}" -le 65535 ] &&
         [ "${BASH_REMATCH[1]}:${BASH_REMATCH[6]}" != http:80 ] && [ "${BASH_REMATCH[1]}:${BASH_REMATCH[6]}" != https:443 ]; }; }; then
      cors_args+=(--cors "$origin")
    else
      echo 'assistant: FH_OPENCODE_CORS must be comma-separated exact http(s) origins without paths, such as https://ui.example.com; no additional origins are allowed' >&2
      cors_args=(); configuration_degraded=1
      break
    fi
  done
fi
runtime_seconds SHUTDOWN_SECONDS FH_SHUTDOWN_SECONDS 25
runtime_seconds RESTORE_SECONDS FH_RESTORE_TIMEOUT_SECONDS 300
runtime_seconds RECOVERY_OPERATION_SECONDS FH_RECOVERY_OPERATION_TIMEOUT_SECONDS 120
readonly SHUTDOWN_SECONDS RESTORE_SECONDS RECOVERY_OPERATION_SECONDS
export FH_RECOVERY_OPERATION_TIMEOUT_SECONDS="$RECOVERY_OPERATION_SECONDS"
# TERM may arrive during a capture. Finish that bounded operation, then take a
# separate stopped-writer checkpoint and release ownership. The writer budget
# must not truncate these two operations. External hosts must allow the sum of
# both phases (plus the two-second killed-writer settling interval).
RECOVERY_CACHE_SECONDS=0
if [ "${FH_RECOVERY_AKM_INDEX_CAPTURE:-0}" = 1 ]; then RECOVERY_CACHE_SECONDS=5; fi
readonly RECOVERY_SHUTDOWN_SECONDS=$((2 * (RECOVERY_OPERATION_SECONDS + RECOVERY_CACHE_SECONDS) + 30))
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
    # interrupt shutdown before recovery releases ownership. Use a builtin
    # read, not a command substitution that inherits our EXIT trap.
    { IFS= read -r children <"/proc/$parent/task/$parent/children"; } 2>/dev/null || true
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
    # A writer that already exited and was reaped can leave bash waiting
    # forever inside this trap; only wait for a process that still exists.
    if kill -0 "$pid" 2>/dev/null; then wait "$pid" 2>/dev/null || true; fi
  done
  for pid in "${descendant_pids[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
  # SIGKILL is asynchronous. Do not checkpoint while a killed descendant is
  # still runnable; zombies are stopped and will be reaped by image PID 1.
  deadline=$((SECONDS + 2))
  while :; do
    alive=0
    for pid in "${descendant_pids[@]}"; do
      if [ -r "/proc/$pid/stat" ]; then
        local stat=""
        { IFS= read -r stat <"/proc/$pid/stat"; } 2>/dev/null || true
        stat="${stat##*) }"
        case "$stat" in ""|Z\ *|X\ *) ;; *) alive=1 ;; esac
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

  # Compose mounts the operator's writable cache over /opt/akm/cache. Retain
  # baked assets outside it and seed missing files, just like native defaults.
  # No setup/download runs here; existing native cache files and symlinks win.
  if ! prepare_akm_assets; then
    mark_degraded akm-assets 'Baked AKM assets could not be prepared. Check cache permissions; native AKM remains responsible for asset availability and acquisition.'
  fi

  if ! prepare_native_defaults; then
    mark_degraded native-defaults 'Native remote defaults could not be prepared. Check home permissions and recent logs, then restart; OpenCode remains available.'
  fi
}

start_keyring() {
  # The image environment exposes this same private bus to ordinary docker exec
  # clients as well as OpenCode, native harnesses and scheduled subprocesses.
  if [[ "${XDG_RUNTIME_DIR:-}" != /* ]] || [ "$XDG_RUNTIME_DIR" = / ] ||
     [[ "$XDG_RUNTIME_DIR" =~ (^|/)\.{1,2}(/|$) ]] || [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then return 1; fi
  local ancestor="$XDG_RUNTIME_DIR"
  while [ "$ancestor" != / ]; do
    [ ! -L "$ancestor" ] || return 1
    ancestor=$(dirname "$ancestor")
  done
  mkdir -p "$XDG_RUNTIME_DIR" || return
  [ "$(stat -c %u "$XDG_RUNTIME_DIR")" = "$(id -u)" ] || return 1
  chmod 0700 "$XDG_RUNTIME_DIR" || return
  setsid dbus-daemon --session --nofork --nopidfile --address="$DBUS_SESSION_BUS_ADDRESS" >"$RUNTIME_DIR/dbus.log" 2>&1 &
  local bus_pid=$! deadline=$((SECONDS + 5))
  writer_pids+=("$bus_pid")
  until timeout 1s gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.ListNames >/dev/null 2>&1; do
    kill -0 "$bus_pid" 2>/dev/null || return 1
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.1
  done
  kill -0 "$bus_pid" 2>/dev/null || return 1
  if [ -n "${FH_KEYRING_PASSWORD_FILE:-}" ]; then
    [ -r "$FH_KEYRING_PASSWORD_FILE" ] && [ -s "$FH_KEYRING_PASSWORD_FILE" ] || return 1
    setsid gnome-keyring-daemon --foreground --unlock --components=secrets <"$FH_KEYRING_PASSWORD_FILE" >"$RUNTIME_DIR/keyring.log" 2>&1 &
  else
    setsid gnome-keyring-daemon --start --foreground --components=secrets >"$RUNTIME_DIR/keyring.log" 2>&1 &
  fi
  writer_pids+=("$!")
  deadline=$((SECONDS + 5))
  until fhold-keyring initialize >"$RUNTIME_DIR/keyring-status" 2>/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.1
  done
  cat "$RUNTIME_DIR/keyring-status" >&2
}

prepare_akm_assets() {
  local cache source target parent ancestor temporary
  cache=$(realpath -m "${AKM_CACHE_DIR:-/opt/akm/cache}") || return
  [ -d /assistant-defaults/akm-cache ] || return 1
  mkdir -p "$cache" || return
  while IFS= read -r -d '' source; do
    target="$cache/${source#/assistant-defaults/akm-cache/}"
    if [ -e "$target" ] || [ -L "$target" ]; then continue; fi
    parent=$(dirname "$target")
    ancestor="$parent"
    # Keep operator directory symlinks intact instead of writing through them.
    while [ "$ancestor" != "$cache" ]; do
      [ ! -L "$ancestor" ] || return 1
      ancestor=$(dirname "$ancestor")
    done
    mkdir -p "$parent" || return
    temporary=$(mktemp "$parent/.fhold-akm-asset.XXXXXXXX") || return
    # Large binaries/models must never become visible under their native final
    # names until complete. -n also preserves files created concurrently.
    if ! cp --preserve=mode "$source" "$temporary" || ! mv -nT "$temporary" "$target"; then
      rm -f "$temporary"
      return 1
    fi
    rm -f "$temporary" || return
  done < <(find /assistant-defaults/akm-cache -type f -print0)
}

prepare_native_defaults() {
  # These optional caches/settings must never hold the primary server hostage.
  # Native user files, authentication and trust decisions still take precedence.
  local tool
  for tool in codex claude; do
    native_included "$tool" || continue
    mkdir -p "/home/fhold/.$tool/plugins/cache" || return
    cp -R -n "/native-defaults/$tool/plugins/cache/." "/home/fhold/.$tool/plugins/cache/" || return
  done
  for file in claude/settings.json claude/plugins/installed_plugins.json claude/plugins/known_marketplaces.json codex/config.toml; do
    native_included "${file%%/*}" || continue
    local source="/native-defaults/$file" target="/home/fhold/.$file"
    # Seed missing native metadata only. Native plugin commands own refresh;
    # never replace a whole registry/settings file to update one plugin.
    if [ ! -e "$target" ]; then
      cp "$source" "$target" || return
    fi
  done
}

native_included() {
  jq -e --arg tool "$1" '.harnesses | index($tool) != null' /opt/fhold/tools/package.json >/dev/null
}

read_native_plugins() {
  local output status
  if output=$(env "${writer_env[@]}" timeout 30 "$@"); then
    printf '%s\n' "$output"
  else
    status=$?
    printf 'assistant: native plugin query failed (exit %s): %s\n' "$status" "$*" >&2
    return "$status"
  fi
}

refresh_native_plugins() {
  local claude_plugins claude_marketplaces codex_plugins name marketplace root version failed=0
  if ! native_included claude && ! native_included codex; then return 0; fi
  claude_plugins='[]'; claude_marketplaces='[]'; codex_plugins='{"installed":[]}'
  if native_included claude; then
    claude_plugins=$(read_native_plugins claude plugin list --json) || return
    claude_marketplaces=$(read_native_plugins claude plugin marketplace list --json) || return
  fi
  for name in akm fhold; do
    marketplace="$name-plugins"
    # Only inspect the image-owned local marketplace. Enumerating every Codex
    # marketplace also contacts unrelated remote catalogs and can time out.
    if native_included codex; then
      codex_plugins=$(read_native_plugins codex plugin list --marketplace "$marketplace" --json) || return
    fi
    if [ "$name" = akm ]; then root=/akm-marketplace; else root=/fhold-plugins; fi
    if [ "$name" = fhold ]; then
      version=$(jq -er '.version' "$root/fhold/.claude-plugin/plugin.json") || return
    else
      version=$(jq -er '.version' "$root/claude/.claude-plugin/plugin.json") || return
    fi
    # Operator-selected marketplaces are not ours to update. Local image
    # sources never need a Git refresh, download or an updater channel.
    if jq -e --arg market "$marketplace" --arg root "$root" 'any(.[]; .name == $market and .source == "directory" and .path == $root)' <<<"$claude_marketplaces" >/dev/null &&
       jq -e --arg id "$name@$marketplace" --arg version "$version" 'any(.[]; .id == $id and .scope == "user" and .version != $version)' <<<"$claude_plugins" >/dev/null; then
      env "${writer_env[@]}" timeout 30 claude plugin update "$name@$marketplace" --scope user --json || failed=1
    fi
    # Codex add selects the current local artifact but also enables it. Leave
    # an explicitly disabled plugin alone; refresh it on a later enabled boot.
    if jq -e --arg id "$name@$marketplace" --arg root "$root" --arg version "$version" 'any(.installed[]; .pluginId == $id and .enabled == true and .marketplaceSource.sourceType == "local" and .marketplaceSource.source == $root and .version != $version)' <<<"$codex_plugins" >/dev/null; then
      env "${writer_env[@]}" timeout 30 codex plugin add "$name@$marketplace" --json || failed=1
    fi
  done
  return "$failed"
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

write_cron_environment() {
  local file="$TASK_CRONTAB"
  {
    echo '# fhold managed environment'
    echo 'SHELL=/bin/bash'
    echo "PATH=$PATH"
  for name in TZ HOME AKM_CONFIG_DIR AKM_CACHE_DIR AKM_DATA_DIR AKM_STATE_DIR OPENCODE_API_URL OPENCODE_CONFIG_DIR; do
      if [ -n "${!name:-}" ]; then printf '%s=%s\n' "$name" "${!name}"; fi
    done
  } >"$file" || return
  if [ "$KEEPALIVE_ENABLED" = 1 ]; then
    # Supercronic's seven-field format includes seconds. AKM preserves this
    # product-owned line while reconciling its own marked task blocks.
    printf '%s\n' '*/20 * * * * * * /usr/local/bin/fhold-keepalive tick' >>"$file" || return
  fi
}

start_scheduler() {
  mkdir -p "$TASK_SPOOL_DIR" || return
  write_cron_environment || return
  setsid env "${writer_env[@]}" supercronic -inotify "$TASK_CRONTAB" &
  scheduler_pid=$!
  writer_pids+=("$scheduler_pid")
  printf '%s\n' "$scheduler_pid" >"$RUNTIME_DIR/scheduler.pid"
  # Install schedules once per boot, capturing the image's AKM runtime. The
  # crontab above holds no tasks until this succeeds, so retry a failure each
  # minute until it does; then stop. fhold task create/remove and native
  # enable/disable sync their own changes.
  setsid env "${writer_env[@]}" bash -c '
    until fhold-task sync --rebind >&2; do
      echo "assistant: task sync failed; retrying in 60 seconds; OpenCode remains available" >&2
      printf "%s\n" "Scheduled tasks are not installed: task sync failed at startup and retries every minute. Review task definitions, AKM settings and recent logs." >"$1/degraded-task-sync"
      sleep 60
    done
    rm -f "$1/degraded-task-sync"
  ' task-sync "$RUNTIME_DIR" &
  writer_pids+=("$!")
}

prepare_identity
umask 077
if [ -L "$RUNTIME_DIR" ]; then
  echo 'assistant: private runtime directory cannot be a symbolic link' >&2
  exit 1
fi
mkdir -p "$RUNTIME_DIR"
chmod 0700 "$RUNTIME_DIR"
# These are boot diagnostics, not restored instance state.
rm -f "$RUNTIME_DIR"/degraded-* "$RUNTIME_DIR"/{recovery,scheduler,codex,claude,akm-web}.pid || true
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
if ! start_keyring; then
  mark_degraded keyring 'OS keyring could not unlock. Run fhold-keyring status and inspect private keyring.log/dbus.log; check FH_KEYRING_PASSWORD_FILE if configured. The assistant remains available.'
fi
load_opencode_password
# Restore and seed first; let AKM perform its own backed-up migrations before
# any native agent or task writer starts. Blocked external assets are optional
# degradation, not a reason to restart an otherwise usable Assistant.
if ! env "${writer_env[@]}" timeout --kill-after=5s 60s akm migrate apply --format json >"$RUNTIME_DIR/akm-migration.json" 2>"$RUNTIME_DIR/akm-migration.log"; then
  mark_degraded akm-migration 'AKM migration needs attention. Run akm migrate status for remaining blockers; native backups and private startup diagnostics are retained.'
fi
if ! refresh_native_plugins >"$RUNTIME_DIR/native-plugins.log" 2>&1; then
  mark_degraded native-plugins 'Built-in native plugin refresh needs attention. Inspect native plugin lists and private startup diagnostics; account state and hook consent remain unchanged.'
fi
KEEPALIVE_ENABLED=0
if fhold-keepalive init >/dev/null; then
  if [ -n "${FH_KEEPALIVE_URL:-}" ]; then KEEPALIVE_ENABLED=1; fi
else
  mark_degraded keepalive 'Keep-alive could not initialize. Correct its URL or authorization-file settings and restart; the agent remains available.'
fi

# AKM reads never build the index. Build or refresh it once per boot, after
# restore and migration, beside the agent; reads serve what is indexed so far.
setsid env "${writer_env[@]}" bash -c '
  akm index --format json -q >"$1/akm-index.json" 2>"$1/akm-index.log" ||
    printf "%s\n" "The AKM index could not be built. Run akm index and check private akm-index.log; the agent remains available." >"$1/degraded-akm-index"
' akm-index "$RUNTIME_DIR" &
writer_pids+=("$!")

cd /work
# Optional native AKM Web. The dedicated login secret is read only in this child;
# no secret value is put into Docker settings, arguments, or other writers' env.
case "${FH_AKM_WEB_ENABLED:-0}" in
  0) ;;
  1)
    setsid env "${writer_env[@]}" bash -c '
      set -euo pipefail
      AKM_WEB_SECRET=$(cat "${FH_AKM_WEB_SECRET_FILE:-/run/secrets/akm_web_secret}")
      [[ "$AKM_WEB_SECRET" =~ ^[[:graph:]]{32,4096}$ ]]
      export AKM_WEB_SECRET
      exec akm-web --host 0.0.0.0 --port "${FH_AKM_WEB_PORT:-4097}" --origin "${FH_AKM_WEB_ORIGIN:?}"
    ' >"$RUNTIME_DIR/akm-web.log" 2>&1 &
    writer_pids+=("$!")
    printf '%s\n' "$!" >"$RUNTIME_DIR/akm-web.pid"
    ;;
  *) mark_degraded akm-web 'FH_AKM_WEB_ENABLED must be 0 or 1; the optional web listener is disabled.' ;;
esac
(
  # Remove export attributes rather than mutating shell variables (including
  # readonly environment imports); exec receives only the resulting environment.
  for ((i=1; i<${#writer_env[@]}; i+=2)); do export -n "${writer_env[i]}"; done
  exec setsid opencode serve \
    --hostname 0.0.0.0 \
    --port "$OPENCODE_PORT" \
    --print-logs \
    --log-level "${OPENCODE_LOG_LEVEL:-info}" \
    "${cors_args[@]}"
) &
assistant_pid=$!
writer_pids+=("$assistant_pid")
essential_pids+=("$assistant_pid")
printf '%s\n' "$assistant_pid" >"$RUNTIME_DIR/assistant.pid"

if [ "$SCHEDULER_ENABLED" = 1 ] || [ "$KEEPALIVE_ENABLED" = 1 ]; then
  if ! start_scheduler; then
    mark_degraded scheduler 'Scheduling and keep-alive could not start. Check scheduler files, permissions and recent logs, then restart; the agent remains available.'
  fi
fi

for tool in codex claude; do
  native_included "$tool" || continue
  variable="FH_${tool^^}_REMOTE"
  case "${!variable-1}" in
    0) ;;
    1) setsid env "${writer_env[@]}" fhold-remote "$tool" & writer_pids+=("$!")
       printf '%s\n' "$!" >"$RUNTIME_DIR/$tool.pid" || mark_degraded "$tool" "$tool remote process diagnostics could not be written. Check runtime permissions; OpenCode remains available." ;;
    *) mark_degraded "$tool" "$variable must be 0 or 1; this optional remote worker is disabled. Correct the setting and restart." ;;
  esac
done

if [ -n "$recovery_pid" ] || [ "$KEEPALIVE_ENABLED" = 1 ]; then
  # Do not snapshot SQLite while the native server is opening/migrating it.
  # Ownership renewal is already running; this gates only periodic captures,
  # not the server or optional workers. Shutdown stops this waiter as well.
  (
    until curl --max-time 2 -sf -u "opencode:$OPENCODE_SERVER_PASSWORD" \
      "http://127.0.0.1:$OPENCODE_PORT/api/info" >/dev/null; do
      kill -0 "$assistant_pid" 2>/dev/null || exit 0
      sleep 0.2
    done
    if [ -n "$recovery_pid" ]; then
      printf 'ready\n' >"$RUNTIME_DIR/recovery-writers-started"
    fi
    # OpenCode 2 loads location plugins lazily. Initialize the ordinary default
    # workspace once so an unused native worker can establish whole-instance
    # idle without an operator opening OpenCode first. The plugin itself owns
    # coverage; a failed request must not fabricate readiness. Never repeat this
    # request as a health check or keep a naturally evicted workspace loaded.
    if [ "$KEEPALIVE_ENABLED" = 1 ] && ! curl --max-time 30 -sf --get \
      --data-urlencode 'location[directory]=/work' -u "opencode:$OPENCODE_SERVER_PASSWORD" \
      "http://127.0.0.1:$OPENCODE_PORT/api/config" >/dev/null; then
      mark_degraded activity 'Default workspace activity could not initialize. Keep-alive remains conservative; check native OpenCode configuration and open the workspace normally.'
    fi
  ) &
  writer_pids+=("$!")
fi

# Only the primary server or recovery owner may stop the container. Optional
# worker failures are reported by health diagnostics, not restart tripwires.
status=0
wait -n "${essential_pids[@]}" || status=$?
echo 'assistant: an essential process stopped; restarting the stack service' >&2
stop_children
if [ "$status" = 0 ]; then status=1; fi
exit "$status"
