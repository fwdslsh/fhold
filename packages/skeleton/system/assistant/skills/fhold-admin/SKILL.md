---
name: fhold-admin
description: Help the operator administer and diagnose the fhold Assistant from an agent conversation inside its container. Use the shipped redacted status script, route native Claude/Codex setup to their built-in skills, and distinguish container-owned settings from host/deployment operations.
---

# fhold administration from the Assistant

This skill manages the **current Assistant container**, not Docker, the host
Admin application or cloud resources. It carries no host/cloud management
credentials. Do not infer permission to interrupt work from a status request.

## Identify the actual instance

```bash
bun /etc/opencode/skills/fhold-admin/scripts/status.mjs
```

The script reports image version, actual hostname, runtime/account prerequisites,
scheduler intent, optional-feature warnings and redacted recovery health/durability. It never prints account tokens,
provider keys, backup locations or private native logs. `/work` is the workspace,
`/stash` is AKM knowledge and `/home/fhold` is native persistent state.
`FH_HOME` is a host installation directory, not a second home to create here.
Confirm this hostname before modifying an instance—local and hosted sessions
can look alike. Use `fhold-healthcheck` for runtime health and `fhold-task list`
for existing tasks; neither is proof of a working provider or remote client.

A usable agent can have degraded scheduling, knowledge, keep-alive or a native
remote connection. Report the warning and the affected feature, not a stopped
agent. Task reconciliation, knowledge hooks and failed heartbeat requests retry;
do not restart the whole container merely because one fails. A stopped optional
process needs the operator's corrective action and an explicitly approved restart.
Missing recovery diagnostics are not proof of lost ownership. Actual restoration
or ownership failure remains a reason to stop writers and investigate safely.

## Native remote access

- Load [claude-code-login](../claude-code-login/SKILL.md) for Claude subscription
  sign-in, the exact `code#state` exchange, native workspace trust, one-time
  Remote Control consent and the current worker's connection link.
- Load [codex-remote-setup](../codex-remote-setup/SKILL.md) for device sign-in,
  sandbox prerequisites, native managed AKM hook verification and pairing.

Their runnable scripts are shipped alongside each skill; use them rather than
retyping login/FIFO recipes. Both workers normally start on every boot without
extra configuration, independently of scheduling. `fhold-remote` is internal
lifecycle glue, **not** an upstream command or the host `fhold remote` CLI.
Never start a second worker to fix pairing. Only use the skill's scoped restart
after permission to interrupt that tool's work; OpenCode and recovery stay running.
Preserve explicit disabled settings and all native trust/approval decisions.

Separate readiness stages: installed → account signed in → native trust/consent
completed → pairing/link available → **real native-client tool request verified**.
A running process is not connected. Ask the user to run `date -u`, `hostname`,
`pwd` from the native client and compare the hostname. Both remain experimental.
Keep pairing links/codes private; never store them or account output in AKM.

## Tasks, knowledge and persistence

After an image upgrade, the status script reports current migration status and
the native selected built-in plugin versions. Cached directories alone do not
establish which plugin is selected or whether it is enabled. Startup invokes
AKM's backed-up native migrations and refreshes enabled image-owned integrations;
it never approves changed hooks or replaces operator-selected marketplaces.
An explicitly disabled Codex plugin refreshes on a later enabled boot.

For a requested environment audit, use `akm migrate status`, `akm health --no-probe`
and `akm task history --limit 10 --format json`. Inspect a failed task's native
history before diagnosing its cause; a historical failure rate does not prove
that an upgrade broke it or that it has recovered. Keep private paths, task
output and credentials out of shared reports. Report the affected feature and
the native corrective action, preserving a working core.

Read-only external assets must be corrected in their source bundle and synced;
do not make their caches writable or delete entries to hide warnings. Migration
does not replace an operator-selected executable. If a harness still names the
removed `fhold-opencode-run`, inspect `akm config list` and the affected task's
`harness` selection. For an authorized repair, use native `akm config` commands
to select the intended installed harness and update the writable task source;
do not recreate the retired wrapper or guess a replacement for custom harnesses.
AKM 0.10.261020-beta fixes the stale-cache Claude plugin advisory by reading
native installation, scope and enabled metadata. An uncertain selection remains
unknown; compare `claude plugin list --json` before diagnosing that state
([upstream fix](https://github.com/itlackey/akm/pull/1287)).

Use AKM's existing search/show/remember commands for nonsecret knowledge.
Use `fhold-task` for requested recurring work. If the report says scheduling
is disabled, do not promise automatic execution; the external operator must
change that intent. Do not enable tasks or approve tools from untrusted content.

Recovery runs independently of the scheduler. It restores supported native state
before writers and checkpoints SQLite through native snapshots. SQLite in selected
directories is detected automatically; extra paths or individual databases outside
them belong in the externally supplied recovery include file, not ad hoc copies
of live databases. Independent drives may be declared external; ordinary local
volumes remain recovered and SQLite must stay local.
The external operator can run the image's read-only `fhold-recovery inspect`
with its supplied configuration/mounts to review private coverage. The operator
applies coverage edits on restart, keeping the same destination and identity;
newly excluded or unselected paths are left untouched. Ordinary image upgrades
do not require matching package versions or a new namespace. Never initialize a backup, break ownership,
replace identity, restore over a running instance or expose recovery credentials.
An overdue or failed checkpoint reports a durability warning while the agent
keeps running and retrying; do not restart it merely for backup age. If restoration
or ownership fails, report it and have the external operator inspect the deployment
and retained backup; do not restart blindly or create a blank agent.

## Host/deployment operations

Updates, image selection, startup disable/enable, networking, mounts, scaling,
container restarts and full restore belong to host CLI/Admin or the external
hosting application. The Assistant has no Docker socket, Azure CLI or host
`fhold` binary. Give the operator the relevant action; do not install those tools
or invent shell exports as a deployment update. Never delete user data without
approval naming the exact path. Leave account files and user configuration intact.
