# Changelog

## 0.2.2610133-beta.11 — native toolchain and browser tools

Assistant now includes Playwright 1.64.0, its matching Chromium, fonts and system
libraries, ready to render pages as the non-root operator without downloads.
Its runtime uses supported Ubuntu 24.04 LTS for patched browser graphics/XML
libraries, retaining the pinned upstream Bun and Node binaries.
Also include ripgrep, jq, Python/pip/venv, SQLite, archive utilities, Poppler PDF
tools and common inspection utilities. Native image smoke tests cover JavaScript,
light/dark themes, mobile layout, hover tooltips, screenshots and PDF output.

Release validation reuses recent successful canonical CI for the exact release
commit and scope, retaining all six native image gates. Publication imports
native CI build caches, reducing ARM64 compilation under emulation. A separate
dry run is optional; source/artifact checks, signing and download verification
remain required. The earlier unpublished candidates are superseded.

Refresh the image-baked AKM CLI to 0.10.261004-beta and all three AKM harness
plugins to 0.10.261003-beta from the verified immutable upstream release.
Update OpenCode CLI/client/plugin SDK to 2.0.28, Codex to 0.162.1 and Claude Code
to 2.1.296. Bun advances to 1.4.3 across containers, development types and CI;
the unchanged Supercronic source builds with Go 1.27.2.

Also refresh MCP SDKs, Electron/packaging/accessibility tooling, supporting
types and runtime dependencies, the Unify renderer/template, and artifact
upload/download actions. Node 24 LTS, npm, Supercronic and the remaining direct
dependencies retain their current supported releases. A new contributor guide
documents pin ownership, upstream review, native qualification and release
publication. This full release advances CLI/Admin, the Claude Desktop extension,
native fhold plugins and all three runtime image pins together.

Native Linux x64 and ARM64 dependency gates passed, including real AKM recall,
managed permissions, provider/task behavior, history and cold/upgrade recovery.
The release also verifies fresh native CLI artifacts and packaged Linux x64 Admin
startup. ARM64 Admin startup and real vendor entitlement remain unqualified.
The existing narrowly reviewed dependency exceptions remain in force; raw audit
and image findings are retained. See the
[dependency verification](docs/operations/dependency-refresh-2026-10-13.md).

## 0.2.2610121-beta.10 — complete SSH management (tooling only)

SSH instances now use the normal Admin pages and shared local management operations:
installation, AI/app setup, deferred settings, update, logs and local import/export.
Native SSH forwards make OpenCode usable without manual tunnel commands. Connection
selection discovers instances automatically, and remote folders have their own picker.
The normal CLI commands work over SSH, with private staging for file inputs and archives.
Full exports retain exact timestamps, modes, links and session data across transfer.
Native host trust, sign-in and operation confirmations remain unchanged. No runtime
image changes, management daemon or automatic window resizing is introduced.

Verified through the packaged Linux x64 Admin and standalone CLI against a
disposable SSH-hosted instance: fresh installation, native provider setup,
automatic browser forwarding, deferred settings and update, and stopped full
export/import preserving the original agent session. Existing agents were not
restarted. GitHub additionally builds both Linux CLI architectures and AppImages;
ARM64 Admin startup and ACA full-stack management remain unqualified.

CLI/Admin downloads advance to this version. Runtime images and the Claude
Desktop extension remain pinned to **0.2.2610112-beta.8**; no runtime upgrade is
required. Remote hosts need the new CLI for full management; Admin's explicit
Repair action installs it without changing or restarting their instances.

## 0.2.2610113-beta.9 — host connections (tooling only)

CLI and Admin now discover managed Docker instances from Compose labels, including
custom `/opt/stacks/<name>/home` layouts. Native SSH finds the remote CLI in
`~/.local/bin` as well as the normal PATH. Missing or outdated remote CLIs have
actionable diagnostics and an explicitly confirmed, atomic installation/update
path that never restarts containers or changes instance files.

Admin adds a Host connections manager with add, edit, check, repair and remove.
Discovery errors are visible where the user is choosing an instance; changing
connections clears stale results without resetting a saved selection. Names,
roots and ports are editable. Retargeting a host or removing a connection requires
confirmation and clears only its recent selections. CLI offers matching
`hosting edit`, `check`, `repair` and `remove` commands.

This release publishes CLI/Admin downloads only. Runtime images and the Claude
Desktop extension remain pinned to **0.2.2610112-beta.8**; no instance runtime
upgrade is required.

## 0.2.2610112-beta.8 — shared hosting management

CLI and Admin now share host-side hosting adapters. Local Docker remains the
default, with existing installation, settings and lifecycle behavior. Saved
connections and recent targets live outside instance homes and contain locators,
not hosting credentials, AI accounts or app access keys.

Docker over SSH supports discovering existing instances, status, recent logs and
confirmed start/stop/restart through the remote host's installed fhold CLI. Native
SSH owns authentication and host-key review. Remote lifecycle uses the existing
ownership, recovery-drain and pending-settings paths, without replaying mutations.
Local Docker endpoints are pinned per subprocess without changing global context;
remote daemons cannot receive local instance bind paths.

An experimental Azure Container Apps adapter uses the management host's native
Azure CLI for scoped discovery, platform/revision status, system logs and confirmed
Start/Stop requests on externally provisioned assistants. Accepted requests remain
pending, not verified shutdown or readiness. There is no provisioning, deployment
editing, host-side recovery engine or change to the Assistant container.

Admin offers connection discovery, unambiguous recent targets and controls based
on each provider's supported actions. Lifecycle confirmation, pending restart
and unavailable-action guidance remain explicit. Switching instances does not
resize windows or start/stop agents.

Remote installation, upgrades, settings/provider/native-worker setup, import/export
and managed SSH tunnels remain deferred. SSH and ACA live platform qualification
has not been performed; ACA lifecycle and native Claude/Codex connections remain
experimental. OpenCode/AKM pins and existing reviewed dependency exceptions are
unchanged. Publishing does not upgrade running instances.

## 0.2.2610111-beta.7 — reliable portal replies and scoped workload environment

Guardian's admitted MCP streams no longer close during quiet tool runs. Portal
reconnects to the existing credential-scoped job after a transient connection
failure, with bounded inspection retries and no replay of requests, approvals or
cancellations. Accepted jobs are reported before native inspection. Interrupted
delivery is distinguished from native failure, and partial answers are retained.
Slack uses native Markdown blocks for answers, preserving them when Stop controls
are removed; apps rejecting those blocks fall back to plain text.

Standalone deployers can opt into exact `SOURCE=ALIAS` workload environment
mappings with `FH_OPENCODE_ENV_MAP`. Values reach OpenCode without command-line,
file or log copies, while scheduler and remote-worker launches receive no aliases.
Invalid optional configuration warns and leaves the agent available. This scopes
launch environments, not agent tools or plugins: OpenCode subprocesses inherit
aliases and its plugins may use them during scheduled requests. No cloud-specific
code, token broker, sidecar or extra Admin configuration is added.

Healthy v2 upgrades no longer retain a false pending-restart alert after the
exact shipped scheduled-engine conversion. Recovery shutdown waits for an
in-flight ownership renewal before checkpoint/release. Repeated termination
signals and asynchronous parent shutdown are covered; external deployment
parents must use persistent, idempotent signal handling and await their child.

Regression coverage includes a real MCP HTTP stream quiet for thirteen seconds,
same-job reconnection and exactly one submission, Slack rendering/fallback,
and shipped-image native tools consuming workload aliases while scheduler and
remote launches remain clean. GitHub release gates additionally qualify both
native image architectures, recovery/history, provider settings and harnesses.
OpenCode/AKM pins are unchanged from beta.6. Native remote connections remain
experimental, and existing narrowly reviewed dependency exceptions remain.
Publishing does not upgrade existing instances or modify external launch wrappers.

## 0.2.2610103-beta.6 — OpenCode v2 and AKM 0.10 next

The Assistant uses OpenCode 2.0.26 and AKM CLI/harness plugins
0.10.26101002-alpha. Standard upstream installation remains image-baked.
Claude and Codex remote connections remain experimental.

Native settings and user plugins apply through OpenCode's file watcher without
reloading or restarting the agent. Admin preserves JSONC comments, confirms the
effective configuration and keeps saved accounts separate from working
connections. MCP OAuth integrations no longer appear as AI providers.

Guardian uses native tool-free generation for moderation; its second OpenCode
server, provider credential mount and obsolete configuration are removed.
Credential-scoped sessions, chat/read/full policies, forms, approval controls,
file/text search and portal progress remain. Native symbol search and TODO-list
resources are removed because v2 no longer provides them.

History and optional provider-account transfer use native APIs on private
SQLite snapshots rather than writing the vendor schema. Pagination, target
preservation, retry, interrupted history and key/OAuth round trips are covered.
Native history import does not recreate fork/revert/worktree/snapshot state;
use entire-instance export for complete same-instance recovery. Periodic
recovery capture waits for native readiness to avoid racing startup migration.

Recurring tasks use the v2 `--server` argument. The exact previously shipped
engine is upgraded automatically; custom engines remain untouched. Tool/shell
activity, native AKM recall, all five AKM tools and trusted automatic memory are
qualified against the real native engine with controlled model responses.

Before upgrading, retain a stopped full-instance export and its v1 image.
Native credentials now live in OpenCode's database; direct API username is
`opencode`. Review mandatory operator denials using v2 resource policies;
ordinary permission settings are defaults, not an enforced ceiling. Existing
operator files are not replaced. Never downgrade against a converted database.
See [upgrade guidance](docs/managing-fhold.md#moving-from-opencode-v1-to-v2) and
[qualification evidence](docs/operations/opencode-v2-qualification.md).

AKM 0.10 is deliberately a prerelease. Live vendor OAuth/remote pairing and ACA
platform Stop/scale-to-zero were not requalified here. Existing dependency
exceptions and experimental labels remain disclosed; publishing does not update
live instances automatically.

## 0.2.2610102-beta.5 — reliable recovery shutdown and current AKM

Assistant shutdown no longer stalls when a short-lived writer exits while its
process metadata is being read. Writers stop before the final recovery checkpoint
and ownership release, with ordered shutdown logs and the existing grace budgets.
A failed recovery worker is reported as a failure rather than a successful stop.
No new service, configuration flag or automatic ownership takeover is added.

Regression coverage exercises the actual container entrypoint, graceful PID 1
shutdown, final checkpoint acceptance, owner release and cold restoration of
sessions, SQLite databases and custom paths. Directory and Blob-emulator checks
use the normal container lifecycle. Live ACA Stop, revision-deactivation and
scale-to-zero qualification remain deployment-specific follow-up checks.

The Assistant now ships AKM CLI 0.9.31 with the latest stable 0.9 harness plugins,
0.9.30202610090106, for OpenCode, Claude and Codex. Standard native installation
is unchanged. OpenCode's in-process AKM dependency is aligned with the installed
CLI, and image verification checks that alignment and real recall in all three
harnesses. There are no startup downloads or upstream source patches.

OpenCode remains on its qualified 1.x API. Claude/Codex remote connections remain
experimental, and the disclosed dependency/platform qualification limits remain
unchanged. See the [release runbook](docs/operations/release.md).

## 0.2.2610101-beta.4 — richer Discord and Slack conversations

Discord channel mentions now create or reuse a conversation thread, with a
normal-channel fallback when thread permissions are unavailable. Both apps
show tool activity, stream reply updates and keep an active working indicator
until the agent finishes or asks for input. Discord also maintains its typing
indicator during long-running work.

Questions and permission requests use requester-only buttons in the original
conversation. Multiple-choice, multi-select and custom-text answers are
supported; permission approval remains explicit. Slack adds a requester-only
Stop button for active work. No slash commands, services or configuration flags
are added, and existing policies, allowlists and conversation history remain.

Guardian MCP supplies scoped live progress and tool name/status only, without
exposing tool arguments, outputs or private reasoning. Intermediate tool-call
messages no longer prematurely complete a job. Automatic reply delivery still
requires the Portal to remain running; a restart preserves native work/history
but does not recover pending notifications or button state.

Discord needs thread and reaction permissions for those optional affordances.
Slack buttons require Interactivity to be enabled; tool reactions additionally
use the optional `reactions:write` scope. Missing reaction permission does not
prevent replies. See the [Discord](docs/portals/discord-setup.md) and
[Slack](docs/portals/slack-setup.md) setup guides.

AKM, native harness versions, experimental remote status and the disclosed
dependency/platform qualification limits remain unchanged from beta.3. See the
[release runbook](docs/operations/release.md).

## 0.2.2610093-beta.3 — automatic replies for long-running work

Slack and Discord now keep tracking running Guardian jobs until they complete,
fail or need explicit input. The old overall reply deadline and raw job-token
handoff are removed. Work that takes longer than the initial wait receives one
"still working" notice, followed by the result in the original conversation.
Each MCP request still has a bounded timeout; no new service, setting or queue
is introduced.

Conversation continuity is saved before sending the progress notice so follow-up
messages remain queued behind active work. A failed progress notice is logged
without abandoning the job. Existing permission approvals remain explicit.
Automatic final-reply delivery requires the Portal to remain running; a Portal
restart does not cancel native work but does not recover pending notifications.

The Assistant builds the unchanged Supercronic v0.2.49 source with Go 1.26.9
in a standard build-only Docker stage, correcting newly reported HTTP/TLS
denial-of-service advisories in the older Go runtime of its upstream prebuilt
binary. The compiler is not shipped and no upstream source is modified.

AKM, native harness versions, experimental remote status and the disclosed
dependency/platform qualification limits remain unchanged from beta.2. See the
[release runbook](docs/operations/release.md).

## 0.2.2610091-beta.2 — reliable Slack connections

The optional Discord/Slack Portal now runs on Node 24.21.0 LTS with the official
Debian 13 slim base, using its SDKs' supported runtime. This fixes Slack Socket Mode authenticating successfully
but repeatedly disconnecting when Bun's built-in WebSocket implementation lacks
the SDK's heartbeat APIs. Existing bot tokens, allowlists, permissions and
conversation databases are preserved; no account reconfiguration is required.

Portal health follows the current native connection instead of retaining the
initial login result. Slack's SDK handles reconnection, and a disconnected portal
does not stop the Assistant. An image-backed regression test exercises genuine
heartbeat frames, message acknowledgement and delivery after reconnection.
The image uses standard Node HTTP/SQLite APIs without SDK patches, startup
installs, new services or additional operator settings.

AKM and its harness plugins remain at the versions shipped in beta.1. OpenCode
remains on its qualified 1.x API; Claude/Codex remote connections remain
experimental. Previously disclosed dependency exceptions and the ARM64 Admin
startup qualification limit remain unchanged; see the
[release runbook](docs/operations/release.md).

## 0.2.2610081-beta.1 — current AKM and date/build releases

The patch format changes from `yyMMddHHmm` to `yyMMdd<build>`: two-digit
UTC year/month/day plus a daily build number starting at 1. Examples:
`0.2.2610081` and `0.3.2612225-beta.1`. Alpha, beta and rc suffixes remain
supported. Release tools compare date and daily counter separately, including
multi-digit builds and next-day resets, and accept the 0.1 → 0.2 boundary without
rewriting historical tags. See the [release runbook](docs/operations/release.md#date-and-daily-build-from-02).

The Assistant now ships AKM 0.9.30 and matching 0.9.30202610090106 plugins for
OpenCode, Claude and Codex, installed through their standard native mechanisms.
There are no startup downloads, vendor patches or extra services. OpenCode remains
on the qualified 1.x API while upstream AKM/OpenCode 2 integration is pending.

Recovery guidance now explains draining the previous deployment, allowing final
checkpoint/ownership release and using exact-owner unlock only after confirmed
termination (#14). Native remote naming guidance covers Claude's supported
display prefix and the pinned Codex hostname limitation (#15); recovery identity
is unchanged. Both remote integrations remain experimental. Scoped dependency
exceptions and unqualified ARM64 Admin startup remain disclosed in the runbook.

Recovery verification scripts use standard subprocess handling with separate
JSON stdout and diagnostic stderr. A degraded-state warning no longer causes a
spurious JSON parse failure in directory or Blob upgrade qualification.

## 0.1.2610081904-beta.2 — reliable upgrades and idle native remotes

Assistant recovery no longer rejects valid checkpoints or surviving receipts
because image dependencies changed. Package versions remain diagnostic provenance;
native tools own their database upgrades. Retried startup does not invalidate a
receipt solely by advancing the ownership epoch. Backup inventory limits no
longer block startup of an already receipted home or provisioned first-run data.

Coverage edits now use the existing destination and leave newly excluded paths
untouched. SQLite created in selected directories is detected and snapshotted
without requiring manual registration. Overdue/failed checkpoints warn and retry
without shutting down a working agent. Invalid optional remote-worker settings
no longer prevent OpenCode from starting, and image activation verifies content
IDs rather than tag spelling or an assumed single replica. Operator-owned Compose
add-ons can build normally without fhold demanding a pre-existing image reference.

Identity, supported checkpoint formats, checksums, database integrity, path
boundaries and exclusive writer ownership remain enforced. Regression tests and
published-image upgrade smokes cover cold storage, surviving local state and
restoring a checkpoint made by the upgraded image.

Optional scheduling, reconciliation, knowledge hooks, keep-alive, native-worker
and diagnostic failures no longer stop a usable agent. Reconciliation starts in
the background and retries. CLI status, Admin Overview and the built-in admin
skill show actionable warnings separately from core readiness. Invalid numeric
tuning uses safe defaults; failed status writes retry and an unavailable optional
probe does not invalidate recovery ownership. Real-image smoke tests stop optional
processes and verify native sessions and shell tools remain usable.

Native remote supervisors now wait for required subscription sign-in before
launching Claude/Codex workers. Fresh unsigned-in instances can become idle and
stop conditional keep-alive normally; sign-in is picked up on retry or the existing
worker restart. Failed account checks and unknown signed-in activity remain
conservative. No new enablement flag or activity expiry is added. The standard
image smoke runs with both remotes at their default-on setting and verifies real
native work keeps heartbeats running, then stops them when work completes.

Claude/Codex remote connections remain experimental. This release does not move
to OpenCode 2 or add managed-workload identity forwarding. The previously
disclosed, owner-approved dependency exceptions and ARM64 Admin startup
qualification limit remain unchanged; see the release runbook.

## 0.1.2610061043-beta.1 — qualified setup and reliable installation retry

This corrected beta.1 includes the simpler wizard, Apps, native AI settings and
entire stopped-instance import/export introduced below. Installation failure
recovery now keeps its controls busy until the native snapshot finishes, so an
immediate retry cannot race the previous operation. Published earlier beta bytes
remain unchanged.

The complete Linux x64 Admin walkthrough passed fresh installation, independent
instances, app permissions and deferred restarts, cold directory recovery,
cancelled and confirmed full export/import, preserved keys and native history,
and read-only reopening in a second process. Real provider responses and the
controlled native settings regression are recorded separately from account-free
management checks. Claude/Codex remote connections remain experimental; ARM64
Admin startup and the disclosed dependency exceptions remain unchanged.

## 0.1.2610060849-beta.1 — simpler setup, Apps and native AI settings

Admin now has a focused install/import wizard, a compact instance picker and
an app-oriented Apps page. App permissions are configured where they are used;
access-key rotation stays under System. Pending-restart alerts live in the
sidebar and saved settings do not unexpectedly restart active containers.

Agent settings distinguish saved sign-ins from verified working providers.
Common hosted and local endpoints have guided setup, searchable models and an
explicit Test → Use model flow. Provider/model changes use OpenCode's native
configuration API and take effect without restarting the container. Custom
endpoint disabling and account removal are separate actions.

Import/export adds an entire stopped-instance archive, including native sessions,
account state and configuration. Full export and import require all instance
containers to be stopped and explicit confirmation. Portable reviewed-content
transfer and automatic same-instance ephemeral recovery remain distinct options.

The Assistant includes AKM 0.9.26 and matching 0.9.26202610051302 plugins for all
three harnesses, installed through their native mechanisms. Real-image release
gates cover hooks, recovery, history and managed policy on amd64 and arm64.
Claude and Codex remote connections remain experimental. Native ARM64 Admin
startup is not yet qualified; scoped dependency exceptions, including the
approved unpatched `sprintf-js` proxy-logger finding, are disclosed in the
release runbook.

## 0.1.2610050714-alpha.6 — simpler Admin and managed ephemeral support

Admin's System view now presents four compact, collapsed sections in order:
Installation details, Recent logs, Import / export, and Ephemeral container
support. Import/export explicitly transfers reviewed content into a fresh
installation; ephemeral support restores the same instance's runtime state,
including native history and account configuration. Existing CLI commands and
archive formats are unchanged.

Admin and CLI can configure directory or Blob checkpoints for managed instances,
inspect checkpoint status, initialize an explicitly confirmed fresh namespace,
and restore while application writers are stopped. Configuration changes remain
pending until confirmed activation. Recovery is opt-in, credentials remain
private, and no cloud administration, sidecar, startup installer or new service
is added. See [configuration and safe transitions](docs/assistant-recovery.md).

Recovery now fills missing ephemeral files and registered SQLite databases when
the exact accepted receipt survives on a persistent mount, without replacing
newer surviving state. Unreceipted partial state still fails closed. Reading an
atomically published recovery status no longer falsely fails when its previous
inode is replaced; strict snapshot capture checks are unchanged.

Includes selection and lifecycle regressions, a concurrent status publication
test, and real Electron/Docker setup, import/export and cold-recovery checks.
The native-worker retry fixture now flushes its output before exiting and allows
the existing bounded process-group cleanup; no runtime retry delay is changed.
Fresh CLI/Admin installs use the matching public Docker Hub images. Existing
homes, names, ports, credentials and policies are preserved during upgrade.
Claude/Codex remote workers remain experimental; ARM64 Admin startup remains
unqualified. Previously reviewed scoped dependency exceptions remain disclosed.

## 0.1.2610050129-alpha.5 — mount-aware recovery and deferred Admin restarts

Runtime recovery now supports explicit directory exclusions, required independent
mounts and opt-in network-mount discovery through the versioned
`FH_RECOVERY_INCLUDE_FILE`. Ordinary local volumes keep their coverage.
Registered SQLite and WAL/SHM paths must remain local and cannot be excluded.
Missing required mounts and changed ownership policies block startup rather than
restoring historical files over independently persistent content.
See [the policy and stopped-writer transition](docs/assistant-recovery.md#independently-persistent-mounts).

The image adds private read-only `fhold-recovery inspect` and confirmed offline
`restore --confirm-stopped` without starting application writers. Legacy catalogs
remain readable; catalog 3 requires a supporting image. Existing namespace policy
changes require a reviewed transition to a fresh namespace. Portable backup stays
the fresh-install content-transfer path, with no new runtime authority or archive
conversion.

Admin settings save without immediately restarting containers. A persistent
pending-restart notice survives closing/reopening and instance switching.
Users can confirm activation now or restart later; failed activation leaves
changes pending. Explicit start/stop/restart and native setup interruptions also
require confirmation. CLI status reports pending activation, and successful
activation clears it through the same shared control plane.

Includes mount-policy regressions, real directory/Blob-emulator cold replacement,
read-only external-content preservation, offline restore and native AKM harness
checks. GitHub release gates now exercise directory recovery on native amd64 and
arm64 runners. Actual SMB/NFS/FUSE hosting, real account renewal/reconnect and
measured RPO/RTO still require deployment-specific qualification.

Fresh CLI/Admin installs default to the matching public Docker Hub images.
Publishing does not restart or upgrade existing instances. Claude/Codex remote
workers remain experimental; native ARM64 Admin startup remains unqualified.
Previously reviewed scoped dependency exceptions remain disclosed.

## 0.1.2610041911-alpha.4 — managed harness settings and simpler instance selection

OpenCode, Codex and Claude now load operator-owned native policies from the
instance's `config/` directory. Edit the files and restart; no image rebuild,
new service or cloud-specific configuration is needed. Updates preserve edits,
and the files are mounted read-only inside the Assistant. See
[the file map and examples](docs/managed-harness-configuration.md).

Built-in AKM/fhold hooks use native managed registration, with no personal hook
approval required. **Custom-hook behavior changes:** the managed-only defaults
suppress user, project and ordinary plugin hooks. Add reviewed custom hooks to
the native managed settings if needed; plugin skills and MCP servers remain
available. Managed policy is deployment configuration, not part of portable
knowledge backups; preserve and reprovision it separately.

Upgrade the CLI/Admin and Assistant image together. Activation checks image
compatibility, preventing an older image pin from silently losing its hooks.
Existing image pins remain explicit choices. See [alpha.3 upgrade instructions](docs/managing-fhold.md#upgrade-from-alpha3).

New named instances live under `~/fhold/instances/<name>`, leaving room beside
`instances/` for backups, docs and other local files. One global CLI `--name`/`-n`
accepts a directory name under that root or an absolute path, with precedence
argument → optional `FH_HOME` → current directory. The selector works before or
after commands. A DNS-safe name is also the initial container/hostname identity;
there is no separate instance selector or install-name option. Existing saved
identities are preserved when selecting a home by name or absolute path.
Admin suggests the folder as a new instance is named; its unnamed default is
`~/fhold/instances/default`, and custom folder choices remain supported.
Existing homes, project names, ports, credentials and data are not relocated or
changed automatically. Alpha.3 binaries still require `FH_HOME`; the new global
selector is available in alpha.4.

Admin and CLI now link directly to the matching public Claude Desktop extension.
Installation, management and release documentation have been aligned with the
public GitHub/Docker Hub distribution and native configuration paths.

Linux x64/ARM64 CLI, Admin AppImages and the optional unsigned MCPB are built
on GitHub with checksums and an asset manifest. Fresh installs select the
matching pinned public images. Claude/Codex remote workers remain experimental;
ARM64 Admin startup remains unqualified. The previously approved, scoped
[dependency exceptions](docs/operations/release.md#reviewed-runtime-advisories)
remain in effect; this is not a clean-audit claim. Publishing does not update
existing running instances.

## 0.1.2610040821-alpha.3 — public Linux alpha

First public GitHub/Docker Hub release: standalone Linux x64/ARM64 CLI, optional
Admin AppImages, Claude Desktop extension, checksums and asset manifest. CLI and
Admin fresh installs use the pinned public `fwdslsh/fhold-assistant` image;
optional Guardian/Portal use their matching public images. Images support amd64
and arm64 and are signed through GitHub Actions. No Docker Hub login is needed.

Includes the dependency refresh, native fhold plugins and shared image-baked
skills for OpenCode, Claude Code and Codex. Optional conditional HTTP keep-alive
uses the existing scheduler and can run with user scheduling disabled. Native
completion/cancellation handling prevents stale activity from keeping instances
awake; append-only history does not count as live work. Older AKM catalogs no
longer prevent startup. See [keep-alive configuration](docs/harness-plugins.md).

Assistant now runs as `fhold` at `/home/fhold`; its OpenCode HTTP username is
`user`. Custom deployments must update old mount paths, absolute plugin/backup
paths and clients before upgrading. Managed host data directories are preserved.
Existing local-build homes retain their namespace; they do not silently switch
to public images. Native plugin customizations and consent are preserved.

Claude/Codex remote workers remain experimental. ARM64 Admin is cross-built,
not native-startup-qualified. The owner approved narrow, expiring exceptions for
three npm-bundled denial-of-service advisories and the existing unsigned MCPB
build-tool advisory; see [scope and expiry](docs/operations/release.md#reviewed-runtime-advisories).
Raw reports remain visible; no upstream package internals were patched.

## 0.1.2610040740-alpha.3 — unreleased combined source candidate

Combine the dependency refresh with native fhold plugins in all three harnesses,
shared image-baked skills, and opt-in conditional HTTP keep-alive using the
existing scheduler. Keep-alive can run with user scheduling disabled. Native
hook approval remains explicit; no accounts or trust decisions are image-baked.

Agents now run as `fhold` at `/home/fhold`; the native OpenCode HTTP username is
`user`. Custom deployments must update their mounts, absolute plugin/recovery
paths and clients before activating this candidate. Managed homes keep the
same host data directory. Customized native plugin registrations are preserved;
use the native plugin manager to update their selected baked versions.

Review fixes use native completion events for failed/cancelled tools and
background subagents, avoid treating append-only history as active work, and
version native fhold plugins with the product release. Older AKM catalogs no
longer prevent startup. The combined candidate passed 496 tests with no skips,
all image smokes, and directory/Blob-emulator recovery. The existing npm security
gate remains unresolved; this is not a published release or merge approval.

## 0.1.2610040637-alpha.3 — unreleased public source candidate

GitHub is the canonical source and contribution host. Product documentation,
package metadata and image source labels use `https://github.com/fwdslsh/fhold`.
The Linux source-build path remains a standalone CLI with locally built images;
public binary/image publishing is not configured. Native remote workers remain
experimental. No runtime feature, installer or provider flow is added by this
source preparation.

Read-only CI runs in contributor forks, and Linux ARM64 CLI release checks use
a native runner. The MCPB source manifest participates in release stamping.
The locked Electron build dependency `http-cache-semantics` is updated to 4.3.0
for the newly reported cache-disclosure advisory. Local agent state and generated
artifacts are excluded from image build contexts.

Assistant uses the supported build-time npm upgrade to pinned 12.2.0. It removes
four bundled dependency findings; three upstream findings still block the
unchanged image security gate. No vendor bundle patches or scan waivers are added.

Refresh workspace dependencies and the native tools to their latest stable
published versions: Claude Code 2.1.289, Codex 0.160.0, AKM CLI 0.9.24 and MCP SDK
2.3.0. All three AKM plugins use 0.9.21202610040615, with the native marketplaces
pinned to the matching verified archive. Bun 1.4.2, Node 24.21.0 LTS and OpenCode
1.18.34 remain current. CI actions are updated alongside Trivy 0.75.0 and cosign
3.1.3. Upstream nested dependency pins are preserved; no vendor internals are
rewritten to force versions.

## 0.1.2610040221-alpha.2 — qualified Linux artifacts

Qualification passed all 473 product tests with no failures or skips, standard
Assistant/Guardian/Portal image smokes, native x64 CLI/AppImage startup and
unsigned MCPB packaging. ARM64 CLI/AppImage cross-builds passed; native ARM64
execution remains unqualified. Real native API, authenticated MCP, provider
readiness, scheduler and restart checks passed, with Claude native tool and
Discord interaction confirmation. See the [qualification summary](docs/operations/alpha-qualification.md)
for evidence scope and remaining gates. These locally qualified artifacts are
not a public-download or stable-release claim.

## 0.1.2610020452-alpha.1 — unpublished Linux candidate

Fresh CLI and Admin setup prefer ports 3810/3830, choosing and persisting a free
pair when either is already in use. Admin hides ports under collapsed Advanced
with automatic selection on by default; manual choices and CLI `--config` remain
explicit. Docker-published TCP ports are considered even without host listeners.
Existing installations keep their saved ports on refresh and update. Availability
is checked before home materialization, not promised as a permanent reservation.

The portable-backup review documents intended use, exclusions, sensitive opt-ins,
restore conflicts and retry behavior, separate native history and grounded follow-up
findings. Operator guidance now explains encryption/snapshot limitations, map
semantics and the difference between CLI revalidation and Admin preview binding.
No backup implementation or real instance data was changed by that review.

## 0.1.2610020403-alpha.1 — unpublished Linux candidate

Use lowercase **fhold** in product copy, UI, manifests, managed instructions and
documentation; the f/hold wordmark and `FH_*` configuration identity are unchanged.
Welcome now explicitly creates a separate instance in an empty or specified new
folder. Setup exposes connection ports and a user-chosen instance name; CLI adds
`install --name`. The existing project-name setting controls container names and
the Assistant's derived OS hostname, with duplicate-name and project-folder
ownership checks. Existing installations are not renamed or adopted.
The new-folder input reuses the existing form styling rather than a separate
component or native unstyled control.
Install help also advertises `--name`, so the CLI path is discoverable.

Regression coverage includes cancellation, folder/selection preservation,
in-flight and duplicate-name refusal, draft retention, native hostnames and two
simultaneously running agents. Earlier artifacts/receipts remain immutable; this
entry does not claim a public release or qualification of untested platforms.

## 0.1.2610020212-alpha.1 — unpublished Linux candidate

Close the compiled host CLI's ambient dotenv/bunfig boundary: unrelated
invoking-directory `.env` must not redirect `FH_HOME`, and `bunfig.toml` must
not alter runtime configuration. All three CLI build commands use Bun's two
native compiler opt-out flags; three real-binary regression cases cover this
boundary rather than relying only on source tests.

Close the Assistant Bun helper/AKM workspace-preload boundary: `/work/bunfig.toml`
must not execute a preload through managed helper launches. The image sets
`BUN_OPTIONS='--no-env-file --config=/dev/null'`; real-image and native-harness
hostile-workspace smoke cover the boundary. These are native runtime options,
not a new launcher or configuration service.

This new version preserves the superseded candidate's immutable artifacts and
receipt. That candidate passed the 380-test no-skip suite, repeated real
Admin/live acceptance and installed CLI/AppImage checks against its source and
artifacts. ARM64 was build-only. See the [qualification summary](docs/operations/alpha-qualification.md)
for later alpha.2 evidence and remaining platform/publication gates.

## 0.1.2610020008-alpha.1 — superseded unpublished Linux candidate

First independent fhold runtime candidate: persistent OpenCode/AKM agent,
restricted recurring work, optional authenticated Guardian MCP/Discord/Slack,
shared CLI/local Admin operations and own-backup/native-history recovery.
The refined Admin remains a local utility with explicit instance selection.

Timestamped UTC versioning is frozen across Linux artifacts and local images.
Public publishing and Windows/macOS native packaging are deferred. Verification
evidence and remaining gates are recorded in the implementation documents;
this entry does not claim publication or complete release readiness.
