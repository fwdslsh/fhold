# Assistant editions

Every edition includes OpenCode, AKM and AKM web, the scheduler, backup/recovery,
Chromium/Playwright, fonts and the common command-line utilities. Slim removes
the additional native clients, not the shared assistant features.

Slim also includes the OpenSSH client tools (`ssh`, `scp`, `sftp`, `ssh-keygen`
and `ssh-agent`). This installs the client only, with no SSH server or listener.

All editions also include the default-off, experimental
[task-only credential access MVP](credential-custody.md). It uses an explicit
Docker overlay and native sudo rules; it does not create another image edition.

| Edition | Native harnesses | Image repository | Automatic publication |
|---|---|---|---|
| AIO (default) | OpenCode, Claude Code, Codex | fwdslsh/fhold-assistant | Yes |
| Slim | OpenCode | fwdslsh/fhold-assistant-slim | Yes |
| Claude | OpenCode, Claude Code | Local/manual image | No |
| Codex | OpenCode, Codex | Local/manual image | No |

AIO retains the existing repository and default selection. Each Assistant release
publishes the same version and channel to AIO and Slim on native amd64 and arm64,
with the existing security checks, signatures, attestations and exact-candidate
promotion. Guardian and Portal remain separate optional products. Building only
two editions avoids automatically building and qualifying the two dormant
editions; no build-time reduction is claimed without measuring the relevant run.

## Choose an edition

After a release containing Slim is published:

```sh
fhold install --edition slim
fhold config assistant --edition aio
```

The second command applies the changed selection through the normal restart
flow; add `--no-apply` to save it for later. Use the normal instance selection
options to target the intended home. Admin offers the same choice during local
or SSH installation and under Connections → OpenCode → Advanced.
The common Deployment image editor also supports edition changes.

The persisted field is `assistant.edition` in `state/stack.json`; omission
means AIO. Generated Compose variables select its image repository without
changing the logical Assistant version pin. Updates retain the edition and
explicit operator image tags. ACA can use the full Slim image reference through
its existing image field; an ordinary managed-image update retains that
repository. Custom images still require an explicit new image reference.

Native credentials, consent, plugin choices and remote on/off settings survive
edition switches. The switch archives unchanged product setup-skill files for
omitted harnesses outside discovery paths; modified files are preserved with a
warning for operator review. It does not remove account directories, workspace
data, recovery coverage, tasks or user skills. Returning to AIO restores its
product setup skills. Tiny native system files remain stable Compose bind
targets, even when their client is omitted.

Existing tasks explicitly using an omitted harness require an edition that
contains it or an operator-selected replacement. fhold never rewrites tasks,
adds authorization restrictions or installs a missing harness at startup.

## Build and test

Run these from the repository root:

```sh
# Default group builds only the two editions published automatically.
PLATFORM_VERSION=dev docker buildx bake -f docker-bake.json --load

# Optional editions are explicit manual targets.
PLATFORM_VERSION=dev docker buildx bake -f docker-bake.json --load assistant-claude
PLATFORM_VERSION=dev docker buildx bake -f docker-bake.json --load assistant-codex
```

Targets use separate thin `Dockerfile.aio`, `.slim`, `.claude`, and `.codex`
files linked to the shared Dockerfile through native Bake target contexts.
Shared OS/browser, core tool and AKM runtime layers precede edition-specific
native tools and assets. Core and native client dependency graphs have separate
frozen installations, so Slim never copies Claude/Codex packages or their caches
into its final image. `packages/skeleton/assistant-editions.json` owns the edition
inventory and publication set. Enabling another published edition also requires
reviewing the release workflow outputs, qualification and native evidence;
changing a Dockerfile alone is insufficient.

Local tags are `fhold/fhold-assistant[-slim|-claude|-codex]:dev`.
Use the explicitly local `fhold` image namespace and a matching version when
deploying manual builds; unavailable public Claude/Codex tags are not substitutes.
The regular development Compose override builds the saved edition from the shared
definition.

Run the normal source gates and native Assistant smoke lanes for **both** AIO and
Slim. Test a manually built optional edition with the same image smoke commands
before using it. The image inventory drives vendor-specific cases; shared browser,
AKM/OpenCode, scheduler, policy, recovery and upgrade tests remain enabled.
`smoke-assistant-edition.mjs` additionally asserts real binary/package/cache/skill
presence and absence, rather than accepting a reported edition label alone.

## Harness-specific keep-alive

All editions keep the same conditional HTTP sender and 20-second cron. Keep-alive
is independent of task scheduling and sends for busy **or unknown** activity;
only proven idle suppresses requests.

The immutable image manifest reports the included harnesses. Omitted Claude or
Codex clients do not require supervisor/observer coverage, and diagnostics report
`not-included`. An included client whose observation fails remains conservative.
Existing native activity markers still count, even when its remote supervisor is
disabled or the marker belongs to an omitted harness.

The observers remain distinct:

- OpenCode tracks execution/tool/shell activity and confirms the observer is
  installed in every loaded location. Normal idle unload retains coverage;
  disabling/removing the plugin makes coverage unknown.
- Claude hooks retain background tasks, session cron and subagent work after
  foreground Stop, and clear cancelled/denied tools through PostToolBatch.
- Codex retains native thread/turn hooks and app-server inspection, approved-hook
  coverage and terminal turn handling. fhold never creates synthetic sessions or
  grants native hook consent to establish observation.

Edition selection changes which observers are required, not their meaning or
native authorization rules.
