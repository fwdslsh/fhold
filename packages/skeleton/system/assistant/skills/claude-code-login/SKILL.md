---
name: claude-code-login
description: Set up Claude Code subscription sign-in and experimental Remote Control from a fhold OpenCode conversation. Use the shipped scripts to keep native OAuth alive across tool calls, submit the complete code#state once, and guide native workspace trust and consent on the existing background worker.
---

# Claude Code sign-in and Remote Control

Use the image-baked native CLI and the [login script](scripts/login.sh) and
[remote script](scripts/remote.sh); install nothing and do not implement OAuth.
Only begin at the operator's request. Native access bypasses Guardian policies.
Keep existing sign-in, workspace trust and consent; never log out, copy host
credentials, edit native approval files or approve prompts on the user's behalf.
Restricted chat/read sessions cannot run setup; explain their tool permissions.

## Sign in, only if needed

Run `claude auth status`. Require `loggedIn: true` and `authMethod: claude.ai`;
an API key is not enough. The script also preserves an existing subscription.

```bash
bash /etc/opencode/skills/claude-code-login/scripts/login.sh start
```

Remember the returned `SESSION_DIR`. Variables do not survive separate tool
calls. The script keeps one native login alive for at most 15 minutes. Do not
start competing attempts or recreate its FIFO. Read the link in a later call:

```bash
bash /etc/opencode/skills/claude-code-login/scripts/login.sh link SESSION_DIR
```

Share that authorization URL only with the requesting user. Ask them to open it
and paste the **entire callback value, `code#state`**. The code and PKCE verifier
belong to this one process. Send it on stdin, not in command arguments; never
echo it, save it to knowledge or send a probe/test line.

```bash
bash /etc/opencode/skills/claude-code-login/scripts/login.sh submit SESSION_DIR <<'CALLBACK'
PASTE_FULL_CODE#STATE
CALLBACK
```

The script permits one submission and rejects bare codes. Verify in a later call:

```bash
bash /etc/opencode/skills/claude-code-login/scripts/login.sh verify SESSION_DIR
```

Require native subscription status, not a successful pipe write. Invalid code,
expiry or container replacement needs a fresh attempt and URL, never reuse of
the old callback. `cancel SESSION_DIR` stops only that attempt; `clean SESSION_DIR`
removes only its generated scratch files. Repeat clean after cancellation finishes.
Neither operation removes native account files.

## Complete native trust and Remote Control consent

Both workers start by default; there is no environment variable to set after
sign-in. Use the existing managed Claude worker, not a second `claude remote-control`:

```bash
bash /etc/opencode/skills/claude-code-login/scripts/remote.sh status
```

`approval-needed` identifies either workspace trust or Remote Control consent.
Explain that trust applies to `/work`, and Remote Control allows the user's own
Claude account to access this container's tools/files outside Guardian policies.
Ask for an explicit yes/no for the actual pending prompt. Only after their answer:

```bash
printf '%s\n' y | bash /etc/opencode/skills/claude-code-login/scripts/remote.sh answer
```

Use `n` if they decline. Recheck status: trust and Remote Control are two separate
native choices and may require two answers. The native CLI saves the decisions;
the script never edits those files. It refuses input unless a prompt is pending.

```bash
bash /etc/opencode/skills/claude-code-login/scripts/remote.sh link
```

Share the live worker's private link with the requesting operator. Open it in
their Claude browser/mobile app. If a worker failed before sign-in, `restart`
restarts only this managed worker; obtain approval before interrupting native
work. Never kill all Claude processes or restart the whole container to pair.
`not-started` means disabled startup/older image: use host CLI/Admin or the
external hosting app, not an export in the agent's shell.

Verify a real native-client tool request (`date -u`, `hostname`, `pwd`) and confirm
the current container hostname and `/work`. Sign-in, running process, consent
and a link are prerequisites—not proof of client/tool readiness. Keep experimental.
For broader runtime diagnostics load [fhold-admin](../fhold-admin/SKILL.md).
Native reference: [Claude Remote Control](https://code.claude.com/docs/en/remote-control).
