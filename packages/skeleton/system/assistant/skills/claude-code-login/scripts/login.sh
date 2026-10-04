#!/usr/bin/env bash
set -euo pipefail
shared="${BASH_SOURCE[0]%/*}/../../fhold-admin/scripts/session.sh"
action=${1:?Use start, link, submit, verify, cancel or clean}
case "$action" in
  start)
    if env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN timeout 10s claude auth status | node --input-type=module -e 'let text=""; for await (const chunk of process.stdin) text+=chunk; try {const s=JSON.parse(text);process.exit(s.loggedIn===true&&s.authMethod==="claude.ai"?0:1);}catch{process.exit(1);}' 2>/dev/null; then
      echo '{"signedIn":true,"note":"Existing Claude subscription sign-in preserved."}'
    else exec bash "$shared" start claude-login "${2:-900}"; fi
    exit 0
    ;;
  cancel|clean) exec bash "$shared" "$action" "${2:?}" ;;
esac
dir=${2:?Provide the session directory returned by start}
[[ "$dir" =~ ^/tmp/fhold-claude-login\.[A-Za-z0-9]{8}$ ]] || exit 1
[ -d "$dir" ] && [ ! -L "$dir" ] && [ "$(stat -c %u "$dir")" = "$(id -u)" ] || exit 1
case "$action" in
  link) grep -oE 'https://[^[:space:]]+' "$dir/output.log" ;;
  submit)
    [ ! -f "$dir/exit" ] && [ -p "$dir/input" ] && [ ! -L "$dir/input" ] || exit 1
    IFS= read -r callback
    case "$callback" in ?*#?*) ;; *) echo 'Paste the full code#state value, not a bare code.' >&2; exit 1 ;; esac
    mkdir "$dir/submitted"
    printf '%s\n' "$callback" | timeout 5s tee "$dir/input" >/dev/null
    ;;
  verify)
    [ -f "$dir/exit" ] || { echo 'Login is still waiting.'; exit 1; }
    [ "$(<"$dir/exit")" = 0 ] || { echo 'Login failed or expired; start a fresh attempt.'; exit 1; }
    env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN timeout 10s claude auth status | node --input-type=module -e '
      let text=""; for await (const chunk of process.stdin) text+=chunk;
      try { const value=JSON.parse(text);
        if(value.loggedIn!==true || value.authMethod!=="claude.ai") throw Error();
        console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai"}));
      } catch { console.error("Native Claude subscription sign-in is not verified."); process.exit(1); }'
    ;;
  *) exit 64 ;;
esac
