# Environment, mounts, and networks

This document describes the active runtime. The executable source is
`packages/skeleton/system/stack/stack.compose.yml`.

## Host layout

New named homes live under `~/fhold/instances/<name>`; Admin's unnamed default
is `~/fhold/instances/default`. CLI `--name`/`-n` selects a directory name
under that root or an absolute path. If absent, explicit `FH_HOME` takes
precedence over cwd. The CLI resolves that choice once for every command and
its child processes; users do not need to export a variable. Admin uses its
default/recent home or a selected custom folder. Default changes never move an
existing home; select its original path explicitly to continue managing it.
`~/fhold` can contain sibling `backups/`, `docs/` or other local directories;
only the selected instance directory is managed or backed up.

The following paths are relative to that instance's home, not `~/fhold`:

| Host path | Owner | Purpose |
|---|---|---|
| `system/` | fhold release | Exact managed OpenCode and Compose files |
| `config/` | Operator | Seed-once OpenCode, Codex, Claude, AKM, and Compose settings |
| `knowledge/` | Operator and AKM | Knowledge, task sources, scoped user environment, provider auth |
| `workspace/` | Operator | Trusted local agent workspace |
| `state/stack.json` | Control plane | Versioned stack intent |
| `state/stack.env` | Control plane | Non-secret values derived from StackConfig intent |
| `state/installation.json` | Control plane | Generated release/managed-image provenance, never an identity fallback |
| `state/applied-runtime.json` | Control plane | Private startup-input digest and pending-activation flag; no secret values; shared by CLI/Admin restart status |
| `state/credentials/` | Control plane/operator | Named Guardian key directories plus derived key-free registry |
| `state/portal-credentials/` | Control plane | Derived, adapter-scoped runtime keyrings |
| `config/guardian/oauth.json` | Operator | OAuth resource-server settings; disabled by default |
| `config/guardian/oauth-identities.json` | Operator | Exact OAuth issuer/subject to credential maps |
| `state/secrets/` | Control plane/operator | File-backed runtime credentials |
| `data/` | Containers | Assistant home, AKM state, portal SQLite files, audit logs |

Updates replace only the allowlisted managed files in `seed.ts`. They seed
operator files only when absent and never synchronize or delete whole directories.

Native policy files under `config/opencode`, `config/codex` and `config/claude`
are mounted read-only at the harnesses' system paths. See
[managed harness configuration](../managed-harness-configuration.md) for exact
mounts, task permissions and standalone deployment inputs.

## Host-side Compose variables

The control plane writes or preserves these non-secret values in
`state/stack.env`:

| Variable | Meaning |
|---|---|
| `FH_HOME` | Absolute stack home |
| `FH_PROJECT_NAME` | Persisted instance name, or stable per-canonical-home default, from deployment intent |
| `FH_INSTANCE_HOSTNAME` | Derived Assistant OS hostname from that same project name; not another user setting |
| `FH_UID`, `FH_GID` | Non-root container identity |
| `FH_IMAGE_NAMESPACE` | Image namespace; default `fwdslsh` (public Docker Hub); `fhold` selects local builds |
| `FH_STACK_CONFIG_VERSION` | Derived intent schema version |
| `FH_ENABLED_ADDONS` | Derived profiles: `gateway,discord,slack` |
| `FH_ASSISTANT_BIND_ADDRESS` | Derived native OpenCode host bind |
| `FH_ASSISTANT_PORT` | Derived native OpenCode host port |
| `FH_TIMEZONE`, `FH_AUTOMATIC_MEMORY` | Derived schedule timezone and automatic memory intent |
| `FH_CODEX_REMOTE`, `FH_CLAUDE_REMOTE` | Independent native supervisor startup switches, both default `1`; optional `0` keeps a worker off without removing account state. Native sign-in/consent is still required. |
| `FH_CODEX_SANDBOX` | Native Codex isolation: `workspace-write` default, `read-only`, or explicit `danger-full-access` container isolation; task approvals follow native policy |
| `FH_GUARDIAN_BIND_ADDRESS` | Derived Guardian host bind |
| `FH_GUARDIAN_PORT` | Derived Guardian host port |
| `DISCORD_ALLOWED_GUILDS`, `DISCORD_ALLOWED_ROLES` | Derived Discord scope |
| `DISCORD_ALLOWED_USERS`, `DISCORD_BLOCKED_USERS` | Derived Discord user scope |
| `SLACK_ALLOWED_CHANNELS` | Derived Slack channel scope |
| `SLACK_ALLOWED_USERS`, `SLACK_BLOCKED_USERS` | Derived Slack user scope |
| `FH_SETUP_COMPLETE` | Install completion marker |

Project, namespace and image pins belong to `deployment` in StackConfig.
`FH_ASSISTANT_VERSION`, `FH_GUARDIAN_VERSION` and `FH_PORTAL_VERSION` are derived
Compose inputs. Managed image defaults advance together on update; explicit pins
survive. `state/installation.json` records verified build-release provenance,
not product identity; StackConfig's `product: "fhold"` remains required.

`GUARDIAN_ALLOWED_ORIGINS`, `GUARDIAN_MODERATION_TIMEOUT_MS`, and
`GUARDIAN_ASSISTANT_TIMEOUT_MS` are advanced Guardian settings. They may be
passed to the host command or preserved in
`stack.env`; neither may contain a credential. The escalation threshold is a
managed security value and cannot be raised through the user overlay.

Only fhold, Guardian, Discord, and Slack interpolation keys from
`stack.env` are copied into the Docker client process. Process-control values
such as `DOCKER_HOST`, `PATH`, and `COMPOSE_FILE` are never trusted from that
file. The same sanitized environment is used for preflight and activation.

## File secrets

| Host file under `state/secrets/` | Consumers |
|---|---|
| `fhold_opencode_password` | Assistant, Guardian |
| `fhold_guardian_handle_key` | Guardian handle encryption and ownership proofs |
| `discord_bot_token` | Discord adapter |
| `slack_bot_token` | Slack adapter |
| `slack_app_token` | Slack adapter |

Named Guardian keys live at `state/credentials/<username>/key`; generated keys
contain 32 random bytes encoded as base64url. Guardian mounts the complete
credential store read-only. Each portal mounts only its generated keyring,
containing the fallback and credentials referenced by that portal's
`config/portal/<adapter>/credentials.json` user map. Bot-token files are
created empty and must be filled through `fhold portal token` or Admin before
their portal is enabled.
Other secrets are mounted through Compose `secrets`; no secret value belongs
in an environment variable.

Provider credentials are the deliberate exception to the `state/secrets`
location. OpenCode owns `knowledge/secrets/auth.json`; Assistant reads it
through its normal knowledge tree and OpenCode auth path, while Guardian receives
only a read-only file mount for moderation.

## Assistant

Assistant joins only `agent_net` and publishes the native OpenCode server as
`${FH_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${FH_ASSISTANT_PORT:-3810}:4096`.
The values are derived from StackConfig and may not be changed by the custom
Compose overlay. Any non-loopback bind is an explicit operator choice and
bypasses Guardian.

| Host source | Container target | Mode |
|---|---|---|
| `data/assistant` | `/home/fhold` | read/write |
| `config/assistant` | `/home/fhold/.config/opencode` | read-only |
| `knowledge/secrets/auth.json` | OpenCode auth path | read/write |
| `system/assistant` | `/etc/opencode` | read-only |
| `config/opencode/opencode.json` | `/etc/opencode/opencode.json` | read-only, nested operator-policy mount |
| `config/codex/config.toml` | `/etc/codex/config.toml` | read-only |
| `config/codex/requirements.toml` | `/etc/codex/requirements.toml` | read-only |
| `config/claude/managed-settings.json` | `/etc/claude-code/managed-settings.json` | read-only |
| `config/akm` | `/etc/akm` | read-write; AKM's native scheduler activation only, no delegated ingress credentials |
| `knowledge` | `/stash` | read/write |
| `data/akm/cache` | `/opt/akm/cache` | read/write |
| `data/akm/data` | `/opt/akm/data` | read/write |
| `workspace` | `/work` | read/write |

Assistant receives only the OpenCode server password. It receives no Guardian,
portal, bot, Docker, or host-admin credential.

The OS account and home are `fhold` and `/home/fhold`; native OpenCode Basic
authentication uses username `user`. `/fhold-bundle` is an image-baked,
root-owned read-only AKM skills source, shared with the native fhold plugins.
Custom AKM configuration is preserved; it does not prevent the built-in skills
from being available through the native harness integrations.

`FH_KEEPALIVE_URL` optionally enables conditional HTTP heartbeats using the
existing scheduler, including when user schedules are disabled. Authentication
is opt-in with `FH_KEEPALIVE_AUTH=opencode` or a mounted
`FH_KEEPALIVE_AUTHORIZATION_FILE`. URLs and credentials are never logged.
See [harness plugins and keep-alive](../harness-plugins.md) for behavior, native
approval, custom deployment configuration and the best-effort boundary.

Optional native Codex/Claude Code remote workers inherit the same nonroot
container boundary, with no additional mounts or ports. Their own native sign-in
state persists under `data/assistant`; it is not a delegated Guardian credential
or portable OpenCode provider auth. Child environments omit OpenCode server
credentials and ingress settings. The mounted filesystem remains trusted native
agent access, not a Guardian policy boundary. See [native remote access](../native-remote-access.md).

## Guardian

Guardian joins `agent_net` and `ingress_net`. It publishes
`${FH_GUARDIAN_BIND_ADDRESS:-127.0.0.1}:${FH_GUARDIAN_PORT:-3830}:8080` only
when an ingress profile is enabled.

| Host source | Container target | Mode |
|---|---|---|
| `data/logs` | `/opt/fhold/logs` | read/write |
| `system/guardian` | `/opt/fhold/moderator-config` | read-only |
| `config/guardian` | Guardian OpenCode user config | read-only |
| `knowledge/secrets/auth.json` | Guardian OpenCode auth path | read-only |
| `workspace` | `/work` | read-only |
| `state/credentials` | `/run/fhold-credentials` | read-only |

Guardian receives the named credential store, handle-signing key, and upstream
OpenCode password. It has no persistent application database or writable copy
of provider credentials. Each registry record selects a fixed managed Assistant
agent profile. Guardian reads files
through its own read-only workspace mount so MCP workspace access can reject
canonical paths and file descriptors that escape `/work`; it never delegates
that authorization decision to OpenCode's native file API.

The read-only `config/guardian` mount also carries `oauth.json` and
`oauth-identities.json`. Both are mode `0600` operator files. They contain
public identity-provider metadata and identity-to-credential names, never an
OAuth token or client secret. Guardian reads identity mappings per request;
resource-server configuration changes require a restart.

## Portal adapters

Discord and Slack join only `ingress_net`, publish no host ports, and call
`http://guardian:8080/mcp`. Each gets only its generated named-credential
keyring, platform credential files, and one adapter-specific
`data/portal/<adapter>` volume containing SQLite continuity state.

## Container hardening

All four managed services:

- run as the resolved non-root UID/GID;
- enable an init process;
- drop all Linux capabilities; and
- set `no-new-privileges:true`.

Before start or restart, the control plane resolves the complete managed file
plus user overlay and rejects boundary expansion: replaced core images or
commands, changed mounts, secrets, networks, health commands, logging, runtime
users or published ports beyond the StackConfig choices, plaintext secret-like environment values, custom
managed-secret grants or access to `agent_net`, privileged containers, added
capabilities, host namespaces/devices, and container-runtime mounts.
