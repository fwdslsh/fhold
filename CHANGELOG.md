# Changelog

## 0.1.2610081836-beta.2 — reliable upgrades and idle native remotes

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
