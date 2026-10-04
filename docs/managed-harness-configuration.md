# Managed harness configuration

fhold installs AKM and fhold integrations for OpenCode, Codex and Claude Code
at image build time. Fresh sessions load the built-in hooks without personal
hook approval. Operators supply task permissions and other settings in each
harness's native format; fhold does not translate between permission models.

## Deployment inputs

The CLI/Admin seed these files only when missing. Updates preserve operator
edits. Managed Compose mounts each file read-only into Assistant:

| Instance file | Container path | Purpose |
| --- | --- | --- |
| `config/opencode/opencode.json` | `/etc/opencode/opencode.json` | Managed OpenCode configuration, `permission`, agents and MCP servers |
| `config/codex/config.toml` | `/etc/codex/config.toml` | Codex defaults, including `approval_policy`, plugins and MCP servers |
| `config/codex/requirements.toml` | `/etc/codex/requirements.toml` | Enforced Codex constraints and managed-only hooks |
| `config/claude/managed-settings.json` | `/etc/claude-code/managed-settings.json` | Claude managed settings, including `permissions` and managed-only hooks |

Standalone containers contain the same defaults. Provisioners supply read-only
file mounts at the same container paths before starting the container, for example:

```sh
docker run --env-file ./runtime.env \
  --mount type=bind,src="$PWD/config/opencode/opencode.json",dst=/etc/opencode/opencode.json,readonly \
  --mount type=bind,src="$PWD/config/codex/config.toml",dst=/etc/codex/config.toml,readonly \
  --mount type=bind,src="$PWD/config/codex/requirements.toml",dst=/etc/codex/requirements.toml,readonly \
  --mount type=bind,src="$PWD/config/claude/managed-settings.json",dst=/etc/claude-code/managed-settings.json,readonly \
  fwdslsh/fhold-assistant:YOUR_PINNED_RELEASE
```

`runtime.env` supplies the normal runtime inputs, including the required OpenCode
server password. Mount individual files so the built-in hook files, managed
plugins and skills remain visible. Restart the container after changing policy.
Use the seeded files as a base to retain the built-in settings and marketplace
declarations. Agents cannot modify these system files. Their normal home and
account settings remain writable and recoverable.

## Task permissions

Managed hooks and task permissions are independent. Defaults preserve the
existing task behavior; an operator can provision stricter or unattended policies.

For Codex, `config.toml` supplies `approval_policy = "on-request"` by default.
To prohibit users selecting a different policy, add this top-level constraint
to `requirements.toml`, before `[features]`:

```toml
allowed_approval_policies = ["on-request"]
```

For an explicitly unattended deployment, set `approval_policy = "never"` in
`config.toml` and `allowed_approval_policies = ["never"]` in `requirements.toml`.
`never` disables approval prompts; it does not grant filesystem/network access
outside the selected sandbox. The remote worker retains the isolation selected
by `FH_CODEX_SANDBOX`/StackConfig. Native requirements can further constrain
allowed sandbox modes and command rules. User defaults may override system
defaults; use requirements for enforcement.

Claude uses native `permissions.defaultMode`, `allow`, `ask` and `deny`. For
example, preserve `allowManagedHooksOnly` and add reviewed command permissions:

```json
{
  "allowManagedHooksOnly": true,
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash(git status *)"],
    "deny": ["Bash(sudo *)"]
  }
}
```

OpenCode uses singular `permission`, with native `allow`, `ask` and `deny`
values. For example, merge the following into its managed file:

```json
{
  "permission": {
    "bash": { "*": "ask", "git status *": "allow", "sudo *": "deny" },
    "edit": "ask"
  }
}
```

OpenCode's managed tier wins over conflicting user/project/inline settings.
Native per-agent permission rules still apply. Scheduled work continues to use
the restricted `scheduled` agent; global permissions do not remove Guardian's
separate request authorization, moderation or path boundaries. Operators needing
different scheduled-agent permissions supply native `agent.scheduled.permission`
settings and must qualify that deliberate change.

The native launchers do not force Codex's approval policy or Claude's permission
mode on the command line. No new permission store, per-command wrapper or
startup configuration merge is involved.

## Hooks and MCP servers

The image derives managed hooks from the pinned plugins' existing definitions:

- Codex: `/etc/codex/hooks.json`; enforced `[features] hooks = true` and
  `allow_managed_hooks_only = true` in requirements.
- Claude: `/etc/claude-code/managed-settings.d/10-fhold.json`;
  `allowManagedHooksOnly: true` in managed settings.
- OpenCode: the existing AKM/fhold plugins in `/etc/opencode/plugins`.

Keep the managed-only settings to prevent the same handlers also executing from
user plugin caches. This also suppresses other unmanaged hooks; provision any
required additional handlers through the native managed mechanism. Claude makes
an exception for plugins force-enabled by managed `enabledPlugins`. Do not
force-enable AKM or fhold there while also registering their managed handlers.
The shipped user plugin registrations still expose their skills normally.

MCP servers can be configured through Codex's native `mcp_servers` tables and
OpenCode's native `mcp` object. Claude supports an optional system
`/etc/claude-code/managed-mcp.json`. In managed Compose, create
`config/claude/managed-mcp.json` and add this exact read-only mount through the
existing `config/stack/custom.compose.yml` overlay:

```yaml
services:
  assistant:
    volumes:
      - ${FH_HOME}/config/claude/managed-mcp.json:/etc/claude-code/managed-mcp.json:ro
```

That Claude file is an exclusive server inventory: other MCP sources are
suppressed. It is intentionally absent by default. Claude also offers additive
managed HTTP/SSE servers; follow its native documentation for that alternative.
External provisioners own vendor-specific packages, configuration and sign-in;
the generic fhold image contains no Databasin client or tools.

## Startup, recovery and verification

System files are present before recovery and native workers start. Recovery
restores account/user data; current deployment policy comes from the image and
operator mounts. Do not include system policy paths in custom recovery inputs.
Existing personal hook approvals are preserved but do not control managed hooks.

Codex's `fhold-codex-recall.mjs review` checks the exact built-in managed inventory
and reports `managed: true` with `status: "ready"`. Admin displays **Managed ·
ready** and offers no personal approve/disable operation for those hooks. Older
images retain their existing review flow. Use `opencode debug config` and
`claude doctor` for native configuration diagnostics.

Account sign-in and native remote-access consent remain vendor flows. Managed
hook readiness does not imply a signed-in account or a working remote client.
The offline image smokes exercise real hooks and policy precedence without
claiming live vendor authentication or model readiness.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Codex configuration and requirements](https://learn.chatgpt.com/docs/config-file/config-reference),
[Claude managed settings](https://code.claude.com/docs/en/managed-settings),
[Claude managed MCP](https://code.claude.com/docs/en/managed-mcp), and
[OpenCode configuration](https://opencode.ai/docs/config/).
