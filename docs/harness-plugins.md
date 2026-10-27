# Built-in harness plugins and keep-alive

Assistant includes the native AKM plugin and a native fhold plugin in OpenCode,
Claude Code and Codex. The image build runs each vendor's installer against
pinned local marketplaces. Startup seeds the generated caches and missing
defaults; it never installs software or replaces customized native settings.
The image uses the installed native plugins as the single hook registration
path, preserving native trust/consent and user/project hooks. The fhold plugins share one activity reporter and the same
release-owned skills.

The exact AKM CLI and OpenCode plugin pins live in
`containers/assistant/tools/package.json` and the workspace lockfile. Claude and
Codex use the same plugin release from the checksum-verified immutable archive
in `containers/assistant/Dockerfile`. Update these pins together. Image smokes
check the installed versions and execute real session/prompt recall in all three
harnesses, without a vendor account or model request. Guardian and Portal do not
install AKM or native harness plugins.

The current pins use the AKM 0.10 `next` channel: CLI
`0.10.261004-beta` and all three plugins `0.10.261003-beta`.
The published OpenCode plugin pins that exact CLI; no AKM dependency override
is needed. Release builds pin
these immutable versions, not a moving dist-tag. The image smoke verifies the
plugin's actual resolved dependency, not just `akm --version`.

AKM 0.10's OpenCode plugin calls the public CLI instead of importing its internal
modules. OpenCode 2 uses the separate upstream `akm-opencode-v2` package.
Updating AKM does not replace the native OpenCode engine.
The fhold task commands use AKM's current public interfaces: task listing uses
`search --type task`, and paused task adoption uses read-only `task explain`
before reconciliation. Native AKM validates task source grammar; fhold retains
its restricted prompt-only adoption boundary and never activates an import.

This beta intentionally includes prerelease AKM packages. Advanced users with
custom AKM workflows should review [the upstream 0.10 changes](https://github.com/itlackey/akm/releases/tag/v0.10.261004-beta):
YAML workflows and several deprecated commands/options were removed. Ordinary
fhold prompt tasks remain supported; upgrades do not rewrite knowledge or task
files. Software and plugins are still installed only at image build time, not
through AKM's optional runtime upgrade command.

## Skills and identity

The skills in `packages/skeleton/system/assistant/skills` are baked into
`/fhold-bundle/skills`, native Claude/Codex plugin packages and OpenCode's managed
configuration. `/fhold-bundle` is owned by root with no write bits, while agents
run as the non-root `fhold` account. Their home is `/home/fhold`; OpenCode's
HTTP Basic username is `opencode`. The native password remains required and unchanged.

AKM's seeded configuration includes this read-only source:

```json
"fhold": {
  "path": "/fhold-bundle",
  "writable": false,
  "components": {
    "skills": { "root": "skills", "adapter": "agent-skills", "writable": false }
  }
}
```

This entry belongs under `bundles`. `/stash` remains the default writable bundle.
Ordinary CLI updates preserve existing operator files. Add this source to an
older AKM configuration if you want its catalog to discover the built-in skills.
An absent, disabled or inherited source does not prevent startup: the skills
remain available through the native harness integrations. fhold does not rewrite
the operator's catalog or change their default write target.
The image directory is read-only even to an agent with unrestricted native
tool permissions; the container has no root escalation capability.

Older custom deployments must mount their assistant home at `/home/fhold`
and update any absolute paths in external recovery include files and native
plugin settings. The managed Compose mount keeps the same host-side
`data/assistant` directory. This change does not rewrite old recovery manifests,
remap custom absolute paths or migrate an already-running deployment.

Native plugin defaults refresh automatically only while their generated files
remain untouched. Customized Claude settings and plugin registrations are
preserved. After an image update, use Claude's native plugin manager to install
or update `fhold@fhold-plugins` and `akm@akm-plugins` from the baked local
marketplaces if those customized registrations still select an older version.
No network install is needed. The fhold plugin version follows the product
release so a new image never reuses a stale versioned plugin cache. Managed
handlers always come from the pinned read-only packages in the running image.

## Conditional HTTP heartbeat

Set `FH_KEEPALIVE_URL` to enable keep-alive. Leave it unset to disable it.
For managed Compose, put the following in `config/stack/custom.compose.yml`,
using an ingress endpoint backed by this OpenCode instance:

```yaml
services:
  assistant:
    environment:
      FH_KEEPALIVE_URL: https://agent.example.com/api/info
      FH_KEEPALIVE_AUTH: opencode
```

The deployment can interpolate the URL from its provisioned hostname. fhold
does not guess a cloud provider or assume that a local server address is an
externally routed ingress. Use the URL that the hosting platform measures for
activity; a localhost probe does not count as ingress traffic.
Standalone container deployments use the same environment variables.

For another HTTP endpoint, omit `FH_KEEPALIVE_AUTH` for an unauthenticated GET,
or mount a private file and set `FH_KEEPALIVE_AUTHORIZATION_FILE` to its path.
The file contains the complete Authorization header value, such as a bearer
credential. Do not combine the file with `FH_KEEPALIVE_AUTH=opencode`. Native
OpenCode credentials are sent only after that explicit authentication choice.
Redirects are refused, requests have a five-second timeout, response bodies are
discarded, and diagnostics contain no URL, credential or conversation content.
Environment configuration is read on boot; restart after changing it.
In managed Compose, keep the file private under the existing assistant home
mount (for example `/home/fhold/.config/keepalive-authorization`); this option
does not add credential grants or widen the managed mount boundary.

The existing Supercronic scheduler runs a bounded command every 20 seconds.
No model call or additional service is involved. With `FH_SCHEDULER_ENABLED=0`,
user tasks stay disabled while configured keep-alive still runs in Supercronic.
AKM's reconciliation preserves the product's cron entry.

Native plugins report starts and completions for turns, tools and subagents.
OpenCode's events cover each loaded workspace. Claude's Stop metadata also
accounts for background tasks and session wakeups. Activity has no age-based
expiry: hours of thinking or waiting for approval continue to keep the instance
awake. Markers contain only hashed identifiers and are reset at container boot,
outside recovered user state.

Any active work or unknown observation sends a heartbeat. All observed work
must be idle before heartbeats stop. A running process by itself is never
classified as busy or idle. An enabled native worker with no observed fhold
hooks is unknown. Codex's existing supervisor makes a bounded read-only check of
that same running server's native Unix WebSocket every 20 seconds. It verifies
the enabled and natively approved activity hooks and a complete empty loaded-thread list
before establishing initial coverage. It creates no session, sends no model request,
changes no native configuration and starts no second server. If threads already
exist, normal session hooks must provide coverage. A later native hook approval
can establish unused coverage without a user turn or a worker restart; lost
coverage becomes unknown again.

Codex 0.164 does not emit `Stop` when a model request fails. The same check reads
up to 100 recent turn metadata records per loaded thread, without conversation
items. A native `failed` status retires only that exact turn's observation.
Per-turn identifiers prevent an older failure from clearing a newer prompt;
independent tool and subagent observations remain protected. Missing, malformed,
unavailable or out-of-window metadata never clears activity. No age timeout,
synthetic event, native approval or second server is involved. Changed plugin
definitions still require ordinary native hook review after an update.

Before launching a remote worker, its supervisor asks the native CLI for
the required subscription-account status. A confirmed missing account reports
`sign-in-needed` and waits without starting that worker, so a fresh unsigned-in
instance can become idle normally. Native sign-in is rechecked on the existing
retry interval; the built-in setup skills can restart that supervisor immediately.
No new switch, auth file, credential inspection or idle marker is required.
A failed/unrecognized status check is not proof of inactivity: normal native
startup continues and missing coverage stays unknown. A stopped worker or a
worker waiting to retry is not active by itself. Stale markers after crashes, other missed completion events, or
unsupported background-task metadata conservatively keep the instance awake;
they never expire to make scaling appear successful. Session-end events or a
new container boot clear the corresponding observations.

Inspect the redacted current decision with `fhold-keepalive status`. The private
`$FH_RUNTIME_DIR/keepalive-status.json` records the last tick and whether its
request succeeded. A failed request is retried on the next tick and is logged
without its target or response. It does not stop the native agent. Invalid
keep-alive configuration disables only heartbeats for that boot and reports
an actionable warning. A stopped scheduler or stale/failed heartbeat appears
in CLI status and Admin Overview without making OpenCode unhealthy.

AKM plugin initialization and hook errors likewise warn without rejecting native
agent startup or prompts. Failed hooks retry on subsequent events; automatic
memory capture retries on a later eligible turn. Correct AKM settings and reload
OpenCode after an initialization failure. Native tool errors and security policy
remain owned by their respective tools, not silently converted into success.

This is best-effort activity signaling, not an atomic scale-in veto. Transport
failures or work beginning after termination was committed can interrupt work.
Native hooks must remain enabled; bypassing or disabling activity hooks defeats
observation, particularly for manually launched harnesses outside the managed
supervisors. It cannot detect arbitrary detached OS jobs that the harness no
longer tracks. Hosts still own cooldown, shutdown grace and recovery policy.

## Native approval and verification

AKM and fhold are installed and enabled without account sign-in. Native hook
trust and consent still apply. OpenCode loads the existing image-baked plugins. Deployments can supply native
task permission policies and MCP configuration through the files documented in
[managed harness configuration](managed-harness-configuration.md).

The existing fhold review helper can also select the built-in fhold plugin:

```sh
fhold-codex-recall.mjs review --plugin=fhold@fhold-plugins
```

The default selection remains AKM. The helper reviews native plugin hooks and
reports `approval-needed`, `ready` or `installed`. Explicit approval is bound to
the reviewed command hashes and uses version-checked native configuration APIs;
changed definitions require another native review. It never approves unrelated
hooks. Account sign-in, hook readiness, native remote consent and a working
remote session remain distinct checks.

Source references: [OpenCode plugins](https://opencode.ai/docs/plugins/),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[Codex hooks](https://learn.chatgpt.com/docs/hooks), and
[Codex plugin packaging](https://developers.openai.com/plugins/build/plugins).

The [local verification record](operations/harness-plugins-verification.md)
records tested behavior and the remaining deployment qualification limits.
