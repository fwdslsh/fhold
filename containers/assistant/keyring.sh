#!/usr/bin/env bash
set -euo pipefail

# Native Secret Service diagnostics. Never activate a missing provider during a
# passive status check, and never mistake a running daemon for an unlocked store.
call() {
  timeout --kill-after=1s 1s gdbus call --session --dest org.freedesktop.secrets "$@"
}
unavailable() { echo 'OS keyring unavailable; inspect private keyring.log and the session bus.'; exit 1; }
owner=$(timeout --kill-after=1s 1s gdbus call --session --dest org.freedesktop.DBus \
  --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner org.freedesktop.secrets 2>/dev/null) || unavailable
[ "$owner" = '(true,)' ] || unavailable
alias=$(call --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.ReadAlias default 2>/dev/null) || unavailable
if [[ "$alias" =~ ^\(objectpath\ \'([a-zA-Z0-9_/]+)\',\)$ ]]; then
  collection="${BASH_REMATCH[1]}"
else
  unavailable
fi
case "${1:-status}" in
  initialize)
    # A new home uses the native memory-only collection. An explicitly supplied
    # unlock file selects the native encrypted login collection. Preserve any
    # operator-selected persistent default, including a locked one.
    if [ "$collection" = / ] || { [ "$collection" = /org/freedesktop/secrets/collection/session ] && [ -n "${FH_KEYRING_PASSWORD_FILE:-}" ]; }; then
      collection=/org/freedesktop/secrets/collection/session
      if [ -n "${FH_KEYRING_PASSWORD_FILE:-}" ]; then collection=/org/freedesktop/secrets/collection/login; fi
      call --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.SetAlias default "$collection" >/dev/null || unavailable
    fi ;;
  status) ;;
  *) echo 'Usage: fhold-keyring [status|initialize]' >&2; exit 2 ;;
esac
if [ "$collection" = / ]; then echo 'OS keyring has no default collection.'; exit 1; fi
locked=$(call --object-path "$collection" --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection Locked 2>/dev/null) || unavailable
case "$locked" in
  '(<false>,)')
    if [ "$collection" = /org/freedesktop/secrets/collection/session ]; then
      echo 'OS keyring unlocked (session only; credentials disappear on restart).'
    else
      echo 'OS keyring unlocked (persistent collection).'
    fi ;;
  '(<true>,)') echo 'OS keyring locked; mount its unlock secret and set FH_KEYRING_PASSWORD_FILE, then restart. Existing credentials are preserved.'; exit 1 ;;
  *) unavailable ;;
esac
