#!/usr/bin/env bash
# Operates on the existing managed native worker; never spawns a second server.
set -euo pipefail
case "${1:-status}" in
  status) exec fhold-remote claude status ;;
  answer) exec fhold-remote claude answer ;;
  restart) exec fhold-remote claude restart ;;
  link)
    fhold-remote claude logs | node --input-type=module -e '
      let text=""; for await (const part of process.stdin) text+=part;
      const links=[...text.matchAll(/https:\/\/claude\.(?:ai|com)\/code\/[^\s<>"\x27]+/g)];
      if(!links.length) { console.error("No native connection link yet; inspect status and complete native approval."); process.exit(1); }
      console.log(links.at(-1)[0]);'
    ;;
  *) echo 'Use status, answer (operator y/n on stdin), link or restart.' >&2; exit 64 ;;
esac
