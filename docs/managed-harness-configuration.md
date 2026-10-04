# Managed harness configuration

fhold installs AKM and fhold integrations for OpenCode, Codex and Claude Code
at image build time. Fresh sessions load the built-in hooks without personal
hook approval. Operators supply task permissions and other settings in each
harness's native format; fhold does not translate between permission models.

For a normal personal instance, no policy editing is necessary. Use the usual
provider/remote sign-in flows. Change these files only to customize permissions,
add managed integrations or enforce restrictions for a hosted deployment.

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

For a local instance, edit the files under the selected instance directory and
run `fhold --name personal-agent restart` (replace `personal-agent` with your instance name or
absolute directory). Standalone Docker, Compose, Kubernetes and ephemeral hosts
use the same image paths: the deployment tool supplies the files and recreates
the container. No cloud-specific fhold settings or bootstrap script is needed.

`config/assistant/opencode.json` remains the ordinary user/provider configuration.
Use `config/opencode/opencode.json` for operator-managed policy that takes
precedence over it. Do not move provider credentials into the policy files.
Neither an image rebuild nor a new environment variable is required. You can
also change into the instance home and run `fhold restart` with `FH_HOME` unset.
Do not edit `system/` or generated `state/stack.env`; updates own those files.

Upgrade the CLI/Admin and Assistant image together. Activation checks the image's
`dev.fwdslsh.fhold.managed-harness-policy=1` capability label before applying the
new Compose policy mounts; an old explicit image pin is rejected before replacing
running containers. Updates that start the stack also check before changing managed
files. Offline `update --no-start` only stages files; compatibility is checked when
you next start. Source builds need an image built from the same source, not an
older published alpha. External deployments must likewise keep image and policy
inputs together. Older untouched installations retain their personal-hook workflow.

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
user plugin caches. **This changes custom-hook behavior on upgrade:** user,
project and ordinary plugin hooks no longer run. Plugin skills and MCP servers
remain available through their native installation process; managed-only hooks
are not an MCP or plugin-installation allowlist.

To add an operator-reviewed hook without changing the image, put it in the
already-mounted native policy file. Codex accepts `[hooks]` tables in
`config/codex/requirements.toml`. For example, append:

```toml
[hooks]
managed_dir = "/etc/codex"

[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "printf 'Operator hook loaded\\n' >&2"
```

Claude accepts a `hooks` object in `config/claude/managed-settings.json`; merge
it alongside the existing keys rather than replacing the whole file:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "printf 'Operator hook loaded\\n' >&2" }]
    }]
  }
}
```

Native merging keeps these additional handlers alongside the image's AKM/fhold
hooks. Use container paths for any referenced scripts, and provision those
scripts with the deployment or a derived image. Do not copy plugin handlers
into a new fhold-specific configuration format.

Claude also permits hooks from a reviewed third-party plugin force-enabled in
managed `enabledPlugins`. Do not force-enable AKM or fhold there while also
registering their managed handlers, or their hooks can execute twice. Simply
turning off managed-only settings also permits duplicate built-in hooks.

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
the generic fhold image does not bake in third-party service clients.

## Startup, recovery and verification

System files are present before recovery and native workers start. Recovery
restores account/user data; current deployment policy comes from the image and
operator mounts. Do not include system policy paths in custom recovery inputs.
Existing personal hook approvals are preserved but do not control managed hooks.

Portable `fhold backup`/`restore` deliberately does not transfer these operator
policies or their executable integrations to a new instance. Preserve them in
your private deployment configuration or full-home backup, review them, then
provision them separately before starting the restored instance. Ephemeral
recovery likewise depends on the deployment supplying policy on every boot.

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
