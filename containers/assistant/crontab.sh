#!/usr/bin/env sh
# AKM's native cron backend writes the file watched by Supercronic.
set -eu
file=/tmp/fhold-crontabs/fhold
case "${1:--}" in
  -l) cat "$file" 2>/dev/null ;;
  -r) rm -f "$file" ;;
  -) cat >"$file" ;;
  -*) echo "crontab: unsupported option: $1" >&2; exit 1 ;;
  *) cat "$1" >"$file" ;;
esac
