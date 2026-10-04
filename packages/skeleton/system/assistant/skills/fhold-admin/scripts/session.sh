#!/usr/bin/env bash
# Private, bounded native sign-in across separate agent tool calls.
set -euo pipefail
umask 077
action=${1:?Specify start, run, cancel or clean}
if [ "$action" = start ]; then
  kind=${2:?Specify claude-login or codex-setup}
  case "$kind" in claude-login|codex-setup) ;; *) exit 64 ;; esac
  seconds=${3:-900}
  [[ "$seconds" =~ ^[1-9][0-9]*$ ]] && [ "$seconds" -le 900 ] || { echo 'Setup timeout must be 1–900 seconds.' >&2; exit 1; }
  sandbox=${FH_CODEX_SANDBOX:-workspace-write}
  case "$sandbox" in workspace-write|read-only|danger-full-access) ;; *) echo 'Invalid configured Codex sandbox.' >&2; exit 1 ;; esac
  dir=$(mktemp -d "/tmp/fhold-$kind.XXXXXXXX")
  mkfifo -m 600 "$dir/input"
  setsid bash "${BASH_SOURCE[0]}" run "$dir" "$kind" "$sandbox" "$seconds" </dev/null >/dev/null 2>&1 &
  printf '%s\n' "$dir"
  exit 0
fi
dir=${2:?Provide the exact session directory returned by start}
[[ "$dir" =~ ^/tmp/fhold-(claude-login|codex-setup)\.[A-Za-z0-9]{8}$ ]] || { echo 'Invalid native session directory.' >&2; exit 1; }
[ -d "$dir" ] && [ ! -L "$dir" ] && [ "$(stat -c %u "$dir")" = "$(id -u)" ] || exit 1
for name in input output.log pid exit submitted; do [ ! -L "$dir/$name" ] || exit 1; done
case "$action" in
  run)
    printf '%s\n' "$BASHPID" >"$dir/pid"
    trap 'printf "%s\n" 143 >"$dir/exit"; exit 143' TERM INT
    exec 9<>"$dir/input"
    set +e
    case "${3:-}" in
      claude-login)
        timeout --foreground --signal=TERM --kill-after=5s "${5:?}s" \
          env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
          claude auth login --claudeai <"$dir/input" >"$dir/output.log" 2>&1 ;;
      codex-setup)
        timeout --foreground --signal=TERM --kill-after=5s "${5:?}s" \
          fhold-remote-setup codex "${4:?}" <"$dir/input" >"$dir/output.log" 2>&1 ;;
      *) exit 64 ;;
    esac
    printf '%s\n' "$?" >"$dir/exit"
    exec 9>&-
    ;;
  cancel|clean)
    if [ ! -f "$dir/exit" ] && [ -r "$dir/pid" ]; then
      pid=$(<"$dir/pid")
      [[ "$pid" =~ ^[1-9][0-9]*$ ]] || exit 1
      if [ -r "/proc/$pid/cmdline" ]; then
        command_line=$(tr '\0' ' ' <"/proc/$pid/cmdline")
        case "$command_line" in *session.sh\ run\ "$dir"\ *) kill -TERM -- "-$pid" 2>/dev/null || true ;; *) echo 'Recorded process no longer belongs to this attempt.' >&2; exit 1 ;; esac
      fi
    fi
    [ "$action" = clean ] || exit 0
    [ -f "$dir/exit" ] || { echo 'Cancellation is finishing; repeat clean in a later call.' >&2; exit 1; }
    rm -f -- "$dir/input" "$dir/output.log" "$dir/pid" "$dir/exit"
    if [ -d "$dir/submitted" ]; then rmdir -- "$dir/submitted"; fi
    rmdir -- "$dir"
    ;;
  *) exit 64 ;;
esac
