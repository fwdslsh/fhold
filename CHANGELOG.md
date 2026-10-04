# Changelog

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
