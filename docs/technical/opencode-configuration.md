# OpenCode configuration

fhold uses OpenCode directly; it does not maintain a parallel agent/session abstraction.

## Assistant configuration layers

| Layer | Host path | Purpose |
|---|---|---|
| managed directory | `system/assistant` | release-owned server settings, global instructions, Guardian/scheduled profiles and native AKM/fhold plugins |
| operator policy | `config/opencode/opencode.json` | native managed settings and permissions, overriding ordinary user settings |
| user config | `config/assistant/` | operator model/provider preferences, persona, and user profile |
| provider auth | `knowledge/secrets/auth.json` | OpenCode credential store |
| workspace | `workspace` | trusted local worktree |

`OPENCODE_CONFIG_DIR=/etc/opencode` points at the managed directory. Both loaded
config directories contain a pre-seeded `.gitignore` and are mounted read-only,
so OpenCode does not bootstrap package metadata or fetch its plugin SDK at
startup. OpenCode discovers the image-baked local plugins at `plugins/akm.js`
and `plugins/fhold.js`. The operator policy is a separate read-only file mount
inside `/etc/opencode`; updates preserve host edits. See
[managed harness configuration](../managed-harness-configuration.md) for its
precedence, edit/restart workflow and custom deployment mounts.

The user directory has one nested writable file: OpenCode's preferred global
preferences (`opencode.jsonc` when present, otherwise `opencode.json`, otherwise
`config.json`; fresh installs seed `opencode.json`). The control plane derives
the filename, not a second configuration store or user option. Trusted native
clients may edit its native fields. Persona/plugin files and all managed policy
remain read-only. Standalone deployments with a writable native home already
support the same API; no special fhold process wrapper is required.

Project configuration, Claude compatibility discovery, external skill
discovery, and OpenCode's embedded browser UI are disabled in the hosted
process. This prevents a checked-out workspace from introducing startup code or
silently widening the managed agent surface. Workspace files remain available
to a trusted local session through normal tools.

The plugin wrapper imports the exact package baked at:

```text
/opt/fhold/tools/node_modules/akm-opencode/dist/index.js
```

## Local and custom AI servers

Admin's **Add AI service** presets send narrow `PATCH /global/config` requests
to OpenCode's authenticated native API. OpenCode persists preferences and
invalidates/reloads its own configuration; it preserves unrelated settings and
JSONC comments. Admin never rewrites a native file or invents a reload command.
The compatible SDK is
bundled in the pinned OpenCode release; no SDK package or startup install is added.
API keys use OpenCode's `/auth` API and its existing private credential store.

The form stores the server's name, `options.baseURL` and chosen `models` entry.
**Use this model** patches native `model: "provider/model"`. After native reload,
Admin checks the effective `/config` result rather than assuming the write won.
The higher-priority `config/opencode/opencode.json` remains operator policy;
conflicting managed provider/model settings must be edited there, not bypassed.
Neither endpoint saving nor default selection restarts the OpenCode process or
container. Reloading native configuration can interrupt active OpenCode work.
An unconfirmed effective result is reported honestly as saved but unconfirmed,
not restored by overwriting the file with an old client-side copy.

**Disable endpoint** patches native `disabled_providers`, retaining the endpoint
definition and its separate sign-in. OpenCode's merge API does not delete provider
definitions. Editing/saving a disabled endpoint explicitly re-enables only that
ID; other disabled services stay disabled. **Remove sign-in** instead uses native
`DELETE /auth/<provider>` without deleting endpoint settings or revoking the vendor
account. Higher-priority operator configuration is never silently bypassed.

Host edits that replace the preferences file's inode, or add a higher-priority
filename, require `fhold restart` to recreate the narrow file bind. Admin's API
writes do not require a pending-restart alert. Edit managed policy files on the
host and restart normally; do not edit generated `state/stack.env`.

**Load models** uses a bounded, one-shot `GET <baseURL>/models` from inside the
running Assistant through ordinary Compose exec and Node's built-in fetch.
An optional key travels on stdin, not Docker command arguments. The discovery
helper installs nothing, starts no daemon and never prints raw responses or keys.
If the server does not support listing models, use its exact documented model ID.
The explicit readiness request subsequently goes through native OpenCode, using
the chosen model; a model listing is not proof of inference or tool-call support.

Common OpenAI-compatible base URL paths end in `/v1`. Use the address actually
served by Ollama, LM Studio, llama-server or your custom service. A server on
the host's loopback interface is not automatically reachable from a Linux bridge
container. Use a deliberately configured private interface/network, or the host
gateway address if the server listens on it. Keep firewall and authentication
appropriate; do not expose a previously loopback-only server publicly to make
setup pass. A `localhost` address targets Assistant itself. fhold does not change
the model server's listener, launch it or fetch models.

## Trusted native sessions

A client connecting to the configured Assistant endpoint uses the native
OpenCode server and normal Assistant configuration. OpenCode Basic
authentication is always enabled through the file-backed server password. The
bind defaults to `127.0.0.1:3810`; fresh setup selects a free port if defaults
are occupied. `fhold connect opencode` reports the saved address. StackConfig
may explicitly select another host address and port.

The [OpenCode TUI](https://opencode.ai/docs/cli/) can connect with
`opencode attach <url>` and the `--username` and `--password` options or
corresponding environment variables. Direct native sessions do not pass
through Guardian moderation.

## Remote sessions

Guardian selects one fixed agent name from the authenticated credential's
configured policy on every message:

- `chat` -> `remote`, with `"*": deny`;
- `read` -> `remote-read`, with wildcard denial followed by explicit read,
  glob, list, `/stash`, and `/work` allowances, plus explicit denials for
  managed knowledge secrets, knowledge environment files, and `.env` reads; and
- `full` -> `remote-full`, with no profile permission override, so the global
  Assistant permission configuration remains authoritative.

All profiles treat input and retrieved content as untrusted and forbid secret
or unrelated-data disclosure. Wildcard denial in `chat` and `read` means a
newly installed tool is denied without needing an fhold update.

## Guardian moderator

Guardian starts a separate OpenCode server on container loopback port 4097. It uses:

- managed config from `system/guardian`;
- operator model selection from `config/guardian/opencode.json`; and
- the same provider `auth.json` through a read-only file mount.

The moderator managed configuration denies every tool. It creates an ephemeral session per escalated input and deletes it after classification. Moderator unavailability blocks the suspicious message.

The moderator uses the same read-only, pre-seeded config-directory contract as
Assistant. Its process performs no package installation at boot.

## Scheduler

Supercronic runs inside Assistant. AKM task source files live in
`knowledge/tasks/*.yml`. `config/akm/config.json` defines a `scheduled` engine
that attaches to the already-running authenticated OpenCode server and selects
the restricted `scheduled` profile. Its image-baked command wrapper loads only
the local native API password, which AKM's agent environment allowlist would
otherwise strip. Provider credentials are used by OpenCode, not copied into
AKM configuration. At startup and every 60 seconds:

```bash
akm task sync --rebind
```

Invalid tasks are reported without preventing OpenCode from starting. fhold
seeds no default tasks in a fresh installation. Own-backup restore stages
allowlisted task definitions as disabled until the user reviews their
schedule, policy, tools, secrets, and result destination.

AKM activates schedules in host-local `scheduler.enabled` configuration,
not an `enabled` YAML field. `fhold-task pause`/`resume` use native
`akm task disable`/`enable`; importing a source never authorizes scheduling.
The AKM configuration directory is writable to permit those atomic registry
updates, contains no delegated ingress credentials, and remains operator-owned.
The first sync failure marks Assistant unhealthy until successful
reconciliation, while its native API stays available to repair the definition.
If the scheduler, reconciliation process, or OpenCode exits, the supervisor
stops the service so Compose restarts the complete runtime together.

`assistant.timezone` in stack intent supplies `TZ` for supercronic and defaults
to the detected host timezone. Downtime does not replay missed cron slots.

The image-baked `fhold-task` helper is the single mutation boundary for both
Assistant-created and host-CLI task operations. It prepends hostile-content
guidance, validates task IDs and AKM sources, reconciles the scheduler, and
preserves removed definitions under `knowledge/disabled-tasks/`. Editing task
files is an advanced interface, not the primary product experience.

## Credentials

The Assistant entrypoint never sources `knowledge/env/user.env` into its own process. User commands that need those values should explicitly use AKM's scoped environment execution. Provider credentials use OpenCode's `auth.json` rather than Compose environment variables.
