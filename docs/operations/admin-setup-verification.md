# Admin verification

## Current UI preview iteration

The current preview removes the Welcome/creation headings and duplicate naming
screen. The wizard has one editable name, background Docker/Compose checks,
collapsed Advanced for folder/ports, Install below Advanced, and top-aligned
Back/Cancel or Instances/Finish later navigation. Successful prerequisite checks
are hidden; failures show guidance, official Docker/Compose links and retry.
The sidebar combines the slash/picker and disclosures use filled headers and
chevrons. Import is above Advanced and has separate Import → Review → Open
progress with export/destination fields instead of install controls. One folder
control moves between those two visible workflows; it does not create a second
configuration value. Preparation still goes through
the existing native empty-folder validation; installation and full-instance
import use the existing control-plane operations and protections.

At the user's request, automated tests, rendered E2E and packaged startup smoke
are deferred until the final design iteration. Earlier test counts/screenshots
do not qualify this changed source. The existing startup smoke and renderer
fixtures still describe the previous two-screen naming flow and must be updated
to the final wizard before running that qualification. This is an unreleased
preview AppImage, not a new certified release. TypeScript compilation and the
standard AppImage build are build checks, not end-to-end verification.

For this preview, manually check first-launch choices, one-click previous-instance
opening, name-based folder suggestions, custom-folder preservation, navigation,
default-collapsed Advanced, background check/retry states and installation.
Check that the slash/picker stays on one row, disclosure headers are clearly
interactive, and the requirement guides open normally before selecting a home.
After installing in a disposable home, Finish later must not stop the agent;
reopening must resume account setup. Review full import with a disposable export:
folder edits must invalidate preview, closing import must return the same folder
control below the Advanced summary, Enter in the target field must not install
while import is selected, and importing must retain the native confirmation and
stopped-writer checks. Product navigation must never resize the window.

## Final automated qualification

Use a disposable explicit `FH_ADMIN_E2E_HOME`, separate ports and a fresh desktop
profile. Never launch the test against a real user home. Required image tags must
match the frozen candidate. Test retains evidence according to its explicit
retention controls; do not delete state implicitly.

```bash
bun run --cwd packages/electron test
bun run --cwd packages/electron bundle
bun run --cwd packages/electron test:e2e
```

The rendered harness verifies the two first-launch choices, progressive new-agent
naming, Back/draft preservation and optional **Folder location**, at normal/narrow
sizes and 200% zoom. Real Tab, Shift+Tab and Enter input checks task order and
focus after setup/Back. It also verifies named recent/folder selection, explicit
new-folder setup and cancellation, refusal to open empty folders as existing
instances, non-empty-folder preservation, duplicate-name rejection
before installation, and two simultaneously running named agents with distinct
ports and actual container/OS-hostname checks. Fresh setup keeps Advanced collapsed
and automatic selection enabled. The primary exercises manual overrides; the
second chooses ports automatically while the defaults are deliberately occupied,
without opening Advanced. It also verifies install and startup
recovery, provider readiness, clickable OpenCode, MCP details, masked credentials,
configuration, backup/own-backup restore, keyboard/accessibility and user-controlled
window size. Full provider readiness needs real provider input and normal billing.
Use private provider-key files rather than command arguments.

The launcher also starts a second real Electron process with the same disposable
desktop profile. It must open the last-used installed home directly without
rewriting preferences/intent or starting containers. **Open another instance…**
then returns to Welcome and stays there even after another renderer reload.
Unit tests cover missing, empty, incompatible and corrupt previous homes without
silently opening an older instance, writing data or starting fresh setup.

Sidebar checks compare the named recent-instance dropdown against the actual
selected snapshot, verify direct switching and the **Open another instance…**
Welcome route, and require no subtitle, footer, visible path or Refresh button. Overview
owns the complete path and container status. The rendered walkthrough covers
long names, clearly unavailable status, automatic recovery on focus, keyboard
traversal, expanded narrow navigation and 200% zoom, with 44px action targets and
no horizontal overflow. Long identities and transport failure are explicitly
isolated renderer fixtures, not real Docker outages. Unit tests verify the
15-second visible-window polling, busy/hidden pauses, coalesced reads, read-before-
switch coordination, cancelled/failed switching, drafts/key/review preservation
and unchanged configuration baselines. Runtime status does not claim provider/
account readiness. Only the harness manually resizes for responsive checks;
product navigation and status checks never resize windows.

Screenshot checks focus only the owned test window and bound the complete
render/accessibility/capture wait. A stalled native renderer must fail the test
instead of hanging indefinitely; test focus and sizing are not production behavior.

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
