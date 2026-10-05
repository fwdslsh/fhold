# Admin verification

Use a disposable explicit `FH_ADMIN_E2E_HOME`, separate ports and a fresh desktop
profile. Never launch the test against a real user home. Required image tags must
match the frozen candidate. Test retains evidence according to its explicit
retention controls; do not delete state implicitly.

```bash
bun run --cwd packages/electron test
bun run --cwd packages/electron bundle
bun run --cwd packages/electron test:e2e
```

The rendered harness verifies welcome/recent/folder selection, explicit new-folder
setup and cancellation, non-empty-folder preservation, duplicate-name rejection
before installation, and two simultaneously running named agents with distinct
ports and actual container/OS-hostname checks. Fresh setup keeps Advanced collapsed
and automatic selection enabled. The primary exercises manual overrides; the
second chooses ports automatically while the defaults are deliberately occupied,
without opening Advanced. It also verifies install and startup
recovery, provider readiness, clickable OpenCode, MCP details, masked credentials,
configuration, backup/own-backup restore, keyboard/accessibility and user-controlled
window size. Full provider readiness needs real provider input and normal billing.
Use private provider-key files rather than command arguments.

System has one view with four collapsed sections, in order: **Installation
details**, **Recent logs**, **Import / export**, **Ephemeral container support**.
Static and rendered checks verify this order, the names, matching setup import
labels, keyboard traversal and navigation without duplicate backup/diagnostic
view containers. Import/export distinguishes portable content from the explicit
whole-instance stopped snapshot; ephemeral support uses the separate native
same-instance recovery engine.

The full-instance journey creates a native OpenCode session, refuses export
while containers are live, verifies default-cancel native dialogs, stops through
the normal Admin action and exports the entire home. It opens an empty folder
without installing first, previews without creating the destination, cancels
without writes, then imports while preserving exact stack intent and account
keys. No containers start during import. After an explicit confirmed Start,
the original session must be visible through the authenticated native API.
The restored home has the same project identity; the original is kept and never
restarted concurrently. Window size remains unchanged. The private directory
export, restored home and screenshots are retained with test evidence. Native
vendor reconnect is a separate account/client qualification; this test does not
claim that a vendor will accept an expired copied token.

The save/apply journey postpones a settings restart, checks that the actual
container ID and runtime environment remain unchanged, reopens the instance,
and checks that the pending banner survives. After confirmation it verifies a
new healthy container, the saved runtime settings and the cleared banner. Only
the human response to the native dialog is simulated; persistence, IPC and Docker
are real. Every expected prompt is accounted for, and Escape/default choice must
postpone. Unit tests also cover failed activation, failed image verification,
settings edited during activation and live credential changes that need no restart.

The managed recovery journey uses the normal Admin IPC and shipping Compose
assets, with the native `fhold-recovery` command from the selected image. It
checks the portable/runtime distinction, saves an opt-in private directory and
custom file/SQLite coverage without restarting or initializing, refuses offline
operations while writers run, and verifies default-cancel native confirmations.
After a confirmed stop it initializes an unused namespace, inspects coverage,
starts normally and verifies a fresh **accepted checkpoint**, not merely a PID.
It then removes the running containers through normal Stop, validates recovery
offline, starts fresh containers and verifies restored custom account-style
files and SQLite integrity/content. These custom paths are under the disposable
container's `/tmp`, outside every persistent bind mount: the test must actually
lose them on Stop and recover them from the checkpoint, not merely read a
surviving host volume. The persistent native data and exact receipt survive,
exercising mixed-storage recovery. Focused engine tests also preserve newer
surviving files/databases and refuse unreceipted state, orphan WAL and corrupt
objects before target writes. The second named agent remains independent.
Window size must remain unchanged throughout. Reports and private checkpoints
are retained separately from credentials. This local-directory qualification
does not certify a real network filesystem, Blob account or vendor sign-in.

Focused library/CLI tests cover arbitrary coverage lists, stale saves, optional
earlier intent defaulting off, final instance identity, private storage credential
presence without disclosure, no portable credential copy, persistent restart
tracking, audited mounts/stop grace, and refusal to silently change accepted mount
ownership. Paused, restarting and one-off project writers also block offline
operations. Failed operator runs remove only their uniquely named container;
cleanup uncertainty must be reported, never hidden as a successful restore.

Linux needs an accessible display or Xvfb and a compatible Electron runtime.
Use native Node.js 22.12+ for the launcher/tooling. The E2E launcher invokes
Electron's installed official `install.js` before reading its runtime path;
there is no custom downloader or runtime container install.
Missing display, Docker, image or provider prerequisites are blocked integration
gates, not passes. Static DOM/CSP tests and bundle checks remain useful but cannot
replace rendered verification.

On a host whose default Docker address pools are exhausted, an operator may first
check existing Docker IPAM and host routes, then set
`FH_ADMIN_E2E_INGRESS_SUBNET` to an explicit unused CIDR for this test only. The
harness appends IPAM to the freshly seeded disposable fixture overlay after the
first install and before Guardian; Docker Compose validates it. It refuses a
non-seeded overlay, leaves product defaults unchanged, and records the override
in the report. Do not delete unrelated networks or restart Docker to free pools.
The second agent can use `FH_ADMIN_E2E_SECOND_AGENT_SUBNET` after the same route/IPAM
preflight. This changes only a disposable copy of the Skeleton seed used for that
test's second home; production assets, existing homes and Docker settings are not
changed. The second test stack is stopped after verification and its home/evidence
are retained. The launcher allocates separate free ports automatically.

For a freshly packaged Linux AppImage:

```bash
bun run --cwd packages/electron build:linux
VERSION="$(node -p 'require("./package.json").version')" node scripts/smoke-admin-artifact.mjs
```

The packaged smoke uses the real preload/CSP, separate temporary profile and
empty home, verifies the complete public version and welcome-to-fresh-instance
journey without Docker/provider secrets. `dist/skeleton` is staged exclusively
from the shared library allowlist; `scripts/packaged-assets.test.ts` compares it
against the CLI archive, including exact bytes and unexpected/missing files.

Keep verification reports separate from private credentials and searchable
knowledge. Record exact artifacts/results; do not describe source-bundle tests
as release certification. macOS/Windows native packaging is deferred.
