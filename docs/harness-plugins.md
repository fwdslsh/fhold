# Built-in harness plugins

Assistant includes the native AKM plugin and a native fhold plugin in OpenCode,
Claude Code and Codex. The image build runs each vendor's installer against
pinned local marketplaces. Startup seeds the generated caches and missing
defaults; it never installs software or replaces customized native settings.
The image uses the installed native plugins as the single hook registration
path, preserving native trust/consent and user/project hooks. The fhold plugins
carry the same release-owned skills and register no hooks.

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
`search --type task`, execution uses `akm run`, and adoption delegates to
`akm import --type task`. AKM validates the complete task grammar and keeps new
imports disabled under its scheduler lock. Fhold preserves the staged source
and never passes `--force` or activates an import. Review the native task ref
and its side effects before explicitly resuming it.

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

## Optional failures

Before launching a remote worker, its supervisor asks the native CLI for
the required subscription-account status. A confirmed missing account reports
`sign-in-needed` and waits without starting that worker. Native sign-in is
rechecked on the existing retry interval; the built-in setup skills can restart
that supervisor immediately. A failed/unrecognized status check does not block
normal native startup.

AKM plugin initialization and hook errors warn without rejecting native
agent startup or prompts. Failed hooks retry on subsequent events; automatic
memory capture retries on a later eligible turn. Correct AKM settings and reload
OpenCode after an initialization failure. Native tool errors and security policy
remain owned by their respective tools, not silently converted into success.

## Native approval and verification

AKM and fhold are installed and enabled without account sign-in. Native hook
trust and consent still apply. OpenCode loads the existing image-baked plugins. Deployments can supply native
task permission policies and MCP configuration through the files documented in
[managed harness configuration](managed-harness-configuration.md).

The fhold review helper reviews the AKM plugin's native Codex hooks:

```sh
fhold-codex-recall.mjs review
```

It reports `approval-needed`, `ready` or `installed`. Explicit approval is bound to
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
