#!/usr/bin/env bash
set -euo pipefail
shared="${BASH_SOURCE[0]%/*}/../../fhold-admin/scripts/session.sh"
action=${1:?Use start, progress, verify, pair, restart, cancel or clean}
case "$action" in
  start) exec bash "$shared" start codex-setup "${2:-900}" ;;
  cancel|clean) exec bash "$shared" "$action" "${2:?}" ;;
  pair) exec timeout 15s codex remote-control pair --json ;;
  restart) exec fhold-remote codex restart ;;
esac
dir=${2:?Provide the session directory returned by start}
[[ "$dir" =~ ^/tmp/fhold-codex-setup\.[A-Za-z0-9]{8}$ ]] || exit 1
[ -d "$dir" ] && [ ! -L "$dir" ] && [ "$(stat -c %u "$dir")" = "$(id -u)" ] || exit 1
case "$action" in
  progress)
    node --input-type=module - "$dir/output.log" <<'NODE'
import { readFileSync } from 'node:fs';
const text = readFileSync(process.argv[2], 'utf8');
let stage;
for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
  if (!line) continue;
  const event = JSON.parse(line);
  if (event.stage) stage = event.stage;
  if (stage === 'sign-in' && typeof event.output === 'string') process.stdout.write(event.output);
  if (event.error) console.error(event.error);
  if (event.ready) console.log('Native setup completed; startup and pairing still need verification.');
}
NODE
    ;;
  verify)
    [ -f "$dir/exit" ] || { echo 'Setup is still waiting.'; exit 1; }
    [ "$(<"$dir/exit")" = 0 ] || { echo 'Setup failed or expired; start a fresh attempt.'; exit 1; }
    env -u OPENAI_API_KEY -u CODEX_API_KEY timeout 10s codex login status 2>&1 | grep -i 'Logged in using ChatGPT'
    ;;
  *) exit 64 ;;
esac
