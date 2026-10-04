---
name: codex-remote-setup
description: Set up experimental Codex remote access from a fhold OpenCode conversation. Use the shipped scripts for native device sign-in, sandbox preflight, managed AKM hook verification and pairing of the existing worker. Use for sign-in, pairing failures or sandbox prerequisite errors in headless containers.
---

# Codex remote setup

Use the image-baked native CLI and [setup script](scripts/setup.sh); install
nothing. This is a separate native agent in `/work`, not an OpenCode client.
Native access bypasses Guardian. Only start at the operator's request after
explaining trusted-workspace access. Preserve sign-in and native approvals;
never copy credentials, log out or implement an OAuth exchange. Restricted
chat/read sessions cannot run setup; do not bypass their permissions.

Managed installations may use **Admin → Connections → Codex → Set up** or
the host command `fhold remote enable codex`. The host CLI is not in Assistant.
The following scripts work from a conversation inside a standalone container.

## Native setup

Keep `FH_CODEX_SANDBOX`, default `workspace-write`. Workspace/read-only modes
need working native namespaces; read-only is not a namespace-error workaround.
Only an explicit user choice may use `danger-full-access`, making the container
the boundary with access to its files, credentials and network. Native
task permissions follow the instance policy. Built-in hooks need no personal
approval. Never auto-switch modes, change
deployment configuration from a shell export or add container capabilities.

```bash
bash /etc/opencode/skills/codex-remote-setup/scripts/setup.sh start
```

Remember the returned `SESSION_DIR`, not a code. The script retains the existing
PTY setup across tool-call timeouts for at most 15 minutes, checks the configured
sandbox, reuses existing ChatGPT sign-in or starts native device login, then
verifies the account. No callback paste is needed.

```bash
bash /etc/opencode/skills/codex-remote-setup/scripts/setup.sh progress SESSION_DIR
```

Share the native link and short-lived device code only with the requesting user.
They enter the code **in their browser**, not chat or stdin. If device login is
unavailable, they must enable it in account settings or contact their admin.
Do not dump logs into knowledge. Check completion in a later call:

```bash
bash /etc/opencode/skills/codex-remote-setup/scripts/setup.sh verify SESSION_DIR
```

Require `Logged in using ChatGPT`; API-key-only accounts do not enable Remote.
Failed/expired setup needs a fresh attempt. `cancel SESSION_DIR` stops only that
attempt; `clean SESSION_DIR` removes only its generated scratch files, leaving
account/configuration intact. Repeat clean after cancellation finishes.

## Verify automatic knowledge recall

```bash
fhold-codex-recall.mjs review
```

Current images register the built-in AKM and fhold hooks as system-managed.
When the result has `managed: true` and `status: "ready"`, proceed to pairing;
no personal hook approval is needed. Task permissions follow the instance's
native policy files and are independent of hook trust. If managed hooks are
disabled or missing, report the policy/configuration error to the operator.

Older images may still return unmanaged plugin hooks. For those, explain the
exact AKM hooks: session hints and prompt recall via `akm curate`. Configured
search/embedding services may be contacted. Only after explicit consent:

```bash
fhold-codex-recall.mjs approve REVIEWED_DIGEST
```

Changed definitions reject stale approval; obtain a fresh review rather than
retrying blindly. Use `disable REVIEWED_DIGEST` only when requested. The native
configuration preserves the decision across restarts; no second approval store.

## Pair the existing worker

The worker starts by default with scheduling on or off. fhold runs the pinned
native foreground app-server with Remote Control and its private Unix socket,
so the standard native pairing command can reach it. Do not run `remote-control
start`: that launches another daemon with a runtime installer/updater.

```bash
fhold-remote codex status
bash /etc/opencode/skills/codex-remote-setup/scripts/setup.sh pair
```

Share the fresh pairing code privately using the supported client's native flow.
If enrollment needs refreshing after sign-in, `setup.sh restart` restarts only
the existing managed worker; get permission before interrupting native work.
Do not restart the whole container or create another app-server. Explicitly
disabled startup must be enabled through host CLI/Admin or external hosting.

Neither `process-running` nor a code proves client availability or usable tools.
Ask the user to run `date -u`, `hostname`, and `pwd` from the native remote client;
confirm the current container and `/work`. Linux/client rollout can differ.
Keep experimental and report the exact verified stages. For runtime diagnostics
load [fhold-admin](../fhold-admin/SKILL.md).

Native references: [headless sign-in](https://learn.chatgpt.com/docs/auth#login-on-headless-devices),
[CLI commands](https://learn.chatgpt.com/docs/developer-commands),
[remote requirements](https://learn.chatgpt.com/docs/remote-connections).
