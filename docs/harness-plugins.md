# Built-in harness plugins and keep-alive

Assistant includes the native AKM plugin and a native fhold plugin in OpenCode,
Claude Code and Codex. The image build runs each vendor's installer against
pinned local marketplaces. Startup seeds the generated caches and missing
defaults; it never installs software or replaces customized native settings.
The image registers the existing AKM/fhold handlers as native system-managed
hooks so fresh sessions need no personal hook approval. The fhold plugins share one activity reporter and the same
release-owned skills.

The exact AKM CLI and OpenCode plugin pins live in
`containers/assistant/tools/package.json` and the workspace lockfile. Claude and
Codex use the same plugin release from the checksum-verified immutable archive
in `containers/assistant/Dockerfile`. Update these pins together. Image smokes
check the installed versions and execute real session/prompt recall in all three
harnesses, without a vendor account or model request. Guardian and Portal do not
install AKM or native harness plugins.

## Skills and identity

The skills in `packages/skeleton/system/assistant/skills` are baked into
`/fhold-bundle/skills`, native Claude/Codex plugin packages and OpenCode's managed
configuration. `/fhold-bundle` is owned by root with no write bits, while agents
run as the non-root `fhold` account. Their home is `/home/fhold`; OpenCode's
HTTP Basic username is `user`. The native password remains required.

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
      FH_KEEPALIVE_URL: https://agent.example.com/global/health
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
hooks is unknown, including restored signed-in workers before their first observed
session. Before launching a remote worker, its supervisor asks the native CLI for
the required subscription-account status. A confirmed missing account reports
`sign-in-needed` and waits without starting that worker, so a fresh unsigned-in
instance can become idle normally. Native sign-in is rechecked on the existing
retry interval; the built-in setup skills can restart that supervisor immediately.
No new switch, auth file, credential inspection or idle marker is required.
A failed/unrecognized status check is not proof of inactivity: normal native
startup continues and missing coverage stays unknown. A stopped worker or a
worker waiting to retry is not active by itself. Stale markers after crashes, missed completion events, or
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

AKM and fhold are installed and enabled without account sign-in. Codex and
Claude execute their system-managed handlers without personal approval.
OpenCode loads their existing managed plugins. Deployments can supply native
task permission policies and MCP configuration through the files documented in
[managed harness configuration](managed-harness-configuration.md).

The existing fhold review helper can also select the built-in fhold plugin:

```sh
fhold-codex-recall.mjs review --plugin=fhold@fhold-plugins
```

The default selection remains AKM. A current image reports `managed: true`,
`status: "ready"`, and native `managed` trust. Personal approve/disable operations
are refused for managed hooks. Older images still use the helper's exact-hash,
version-checked native approval flow. Account sign-in, native remote consent,
managed hook readiness and a working remote session remain distinct checks.

Source references: [OpenCode plugins](https://opencode.ai/docs/plugins/),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[Codex hooks](https://learn.chatgpt.com/docs/hooks), and
[Codex plugin packaging](https://developers.openai.com/plugins/build/plugins).

The [local verification record](operations/harness-plugins-verification.md)
records tested behavior and the remaining deployment qualification limits.
