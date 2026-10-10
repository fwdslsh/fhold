# OpenCode configuration

fhold uses OpenCode v2 directly. It does not maintain a parallel provider,
credential, session or plugin service.

## Configuration and ownership

| Layer | Host path | Purpose |
|---|---|---|
| Managed directory | `system/assistant` | Release-owned instructions, restricted agents and native AKM/fhold plugins; read-only in Assistant |
| Operator policy | `config/opencode/opencode.json` | Native permission defaults and enforced resource policies; separate read-only mount |
| User configuration | `config/assistant/` | Writable native preferences, persona and user plugins |
| Native database | `data/assistant/.local/share/opencode/opencode.db` | OpenCode sessions and provider credentials |
| Workspace | `workspace/` | Trusted local working files |

`OPENCODE_CONFIG_DIR=/etc/opencode` selects the managed directory.
`OPENCODE_CONFIG` selects the user preferences file: `opencode.jsonc` when
present, otherwise `opencode.json`, otherwise the existing `config.json`.
Fresh installs seed `opencode.json`. The directory is writable so ordinary
atomic editor saves work. Managed files and operator policy remain read-only.
Updates preserve operator edits; see
[managed harness configuration](../managed-harness-configuration.md).

Project and Claude compatibility configuration discovery remain disabled in
the hosted process. Explicitly configured native user plugins are trusted code.
Image-baked wrappers load pinned `akm-opencode-v2` and fhold integrations from
`/opt/fhold/tools/node_modules`; nothing is installed at startup.

## AI services and live settings

OpenCode v2 does not offer the old arbitrary global-config PATCH.
Admin makes narrow, atomic JSONC-preserving edits to the selected native user
file, then checks the effective native API result. OpenCode's built-in watcher
applies provider/model, agent, command, permission and user-plugin changes.
No reload endpoint, custom watcher or process restart is used. If activation
cannot be confirmed, Admin reports saved-but-unconfirmed; it does not overwrite
the file with an old snapshot.

Native v2 configuration uses `providers`, `settings.baseURL` and
`model: { "providerID": "...", "model": "..." }`. OpenCode still reads supported
v1 configuration through its own converter; new fhold edits use native fields.
**Use this model** changes the default only when explicitly selected.
**Test response** waits for model activation and makes one tool-free native
generation request. It neither creates a session nor changes the default.
A failed billed request is not retried.

**Disable endpoint** retains its definition and sign-in, using native
`provider.use` resource policy. Saving an endpoint re-enables that ID only.
**Remove sign-in** deletes credentials for that provider's native integration,
not unrelated accounts or MCP OAuth tokens. A saved credential is not proof
that the account works; only the explicit response test verifies inference.

Sign-in uses native integration/authentication/credential APIs. v2 owns active
credentials in its SQLite database. The old `knowledge/secrets/auth.json` mount
is retained solely for upstream's one-time v1 database migration.
Portable provider exports use native credential APIs and exclude MCP credentials.

Changing container environment, mounts, ports, the selected preferences filename,
read-only operator policy or image-baked tools requires normal managed activation.
Editing the already-selected user file, local plugin source or plugin options
does not. Hot updates cannot undo a tool that is already running.

### Local and custom servers

**Load models** makes a bounded `GET <baseURL>/models` from Assistant's network.
Any supplied key travels on stdin, not Docker arguments. The helper installs
nothing and never prints credentials. If listing is unsupported, enter the exact
model ID. Catalog visibility is not proof of inference or tool capability.

OpenAI-compatible URLs usually end in `/v1`. Use the address served by Ollama,
LM Studio, llama-server or the custom service. Inside Assistant, `localhost`
means Assistant, not the host. Configure a deliberate private interface/network
or host gateway with appropriate authentication/firewall rules. fhold does not
expose a previously private server, start it or download its models.

## Trusted native sessions

The authenticated native API uses username `opencode` and the file-backed
server password. The default bind is `127.0.0.1:3810`; fresh setup chooses a
free port when occupied. `fhold connect opencode` reports the saved address.
Other addresses require explicit operator choice.

The OpenCode client connects using `--server <url>`; use the native
`OPENCODE_PASSWORD` setting for authentication. The browser interface remains
available at the configured address. Native access bypasses Guardian and is
trusted full agent access, subject to native operator policy.

## Guardian and remote policies

Guardian chooses the native agent from the authenticated credential's policy:

- `chat`: `remote`, deny all tools.
- `read`: `remote-read`, deny all except explicit non-secret reads.
- `full`: `remote-full`, inherit native permissions.

For chat/read, Guardian reapplies the credential ceiling as native session
permissions on every turn, including sessions converted from v1. Remote prompts
cannot select another policy. Workspace reads also pass through Guardian's own
read-only filesystem boundary. Native resource policies can deny operations even
for full access; ordinary global permission defaults are not a managed ceiling.

Suspicious prompts and interaction answers use OpenCode's native tool-free
generation endpoint. Guardian supplies its classification prompt and the model
selected in `config/guardian/opencode.json`. Upstream binds generation to global
configuration, with no agent tools, session, second server or copied provider
credentials. Unavailable, malformed or ambiguous moderation still blocks the
suspicious request.

V2 no longer has native symbol search or TODO lists. Those MCP capabilities are
removed, not emulated. File/text search, transcripts, tool progress, changes,
forms and permission decisions remain available.

## Scheduled work

Supercronic and AKM run inside Assistant. Operator task definitions live in
`knowledge/tasks/*.yml`; host-local `scheduler.enabled` controls activation.
The scheduled engine in `config/akm/config.json` runs
`opencode run --server http://127.0.0.1:4096 --agent scheduled` through the
existing password-loading helper. Provider credentials stay in OpenCode.

`fhold-task sync` delegates to `akm task sync --rebind` at startup and every
60 seconds. On upgrade, it changes only the exact formerly shipped engine's
`--attach` argument to native v2 `--server`. Custom engine definitions remain
operator-owned and need review. Task sources and activation are preserved.

The restricted scheduled agent may read non-secret knowledge/workspace files,
fetch public content and write under `/stash/inbox/`; it cannot execute shell
commands or modify the workspace. Results persist in AKM task history.
Invalid tasks, sync failures or optional scheduler failure report degraded state
without stopping the native agent. Downtime does not replay missed cron slots.
The timezone defaults to the detected host timezone.

Use `fhold-task` or ordinary assistant requests to create, pause, resume and
remove work. Removed definitions are preserved under `knowledge/disabled-tasks/`.
Portable restore stages task sources inactive for review; full-instance and
same-instance runtime recovery preserve the configured activation choices.

## Other credentials

The entrypoint never sources `knowledge/env/user.env` into its process. Commands
needing those secrets use explicit AKM scoped execution. Native provider accounts
are not stored in Compose environment variables.

Guardian keys are private files under `state/credentials/<username>/key`.
Each portal receives only its generated keyring for configured identities.
Bot tokens and the native API password use private file-backed secrets.
