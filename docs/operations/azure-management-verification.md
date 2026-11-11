# Azure management qualification

## November 11, 2026 — mounted backup share live qualification

PR #117 source `bd275ea9db30cd94172c53b30746a99b7c0487ba` passed a live
disposable ACA installation and replica-replacement test. The production
Assistant Dockerfile built the private AMD64 qualification image with manifest
digest `sha256:904053aec3a43d2062931c0f37f37e74d189729e4723ea4e895ba67410b19848`.
This is development qualification, not a published release or the complete
native release matrix.

The test used a new `fh-pr117-261111` app and
`fhold-fh-pr117-261111` backup share in the existing development resource group,
environment and storage account. Shared fhold provisioning and deployment
operations ran against the real Azure SDK. The only fixture addition to generated
templates was ordinary native registry authentication for the private test image,
supplied through a secure ARM parameter. Public release images do not require that
qualification credential. No product source changes or runtime repairs were needed.

| Live scenario | Result |
| --- | --- |
| Fresh mounted-directory installation | Created the dedicated SMB share and environment storage registration; the finite same-image initialization Job succeeded and was removed by the provider. The Assistant mounted that share at `/recovery`, without Blob credentials or a Blob identity/role. |
| Native authentication and local placement | Anonymous native API request returned 401. Authenticated API and shell actions ran as UID 1000. The backup mount reported CIFS/SMB 3.1.1; live SQLite and staging remained on the image-owned local writable layer. |
| Repeating checkpoint with a live WAL writer | Synthetic workspace/knowledge files and a database with a committed row and a nonempty 20,632-byte WAL reached an accepted scheduled checkpoint. Reading its hash-verified manifest/object and opening a local copy of the snapshot confirmed the row before replacement. |
| Normal staged deployment replacement | Preparing and applying a timezone change used the actual provider Stop/PATCH/Start sequence. The old owner directory was absent after native Stop completed, before PATCH. Revision changed from `fh-pr117-261111--y5jvbul` to `fh-pr117-261111--0000001`; Azure reported a different replica name. |
| Cold restoration | The authenticated native API returned the original workspace marker and OpenCode session. A shell on the replacement verified the knowledge marker and SQLite row, UID 1000 and the CIFS backup mount. No seed files, receipts, ownership locks or native databases were repaired by the fixture. |
| Post-restore checkpoint and clean stop | Normal Stop published a new accepted generation containing the replacement's verification file, advanced ownership epoch to 2 and removed the owner directory. No force-unlock or takeover was used. |

Private local evidence is retained under `audit/aca-pr117/` and
`audit/aca-pr117-*.log` in the task workspace: placement, provisioning result,
image build/push, source/replacement replica identities, accepted generation,
runtime assertions and final checkpoint/release. The test used synthetic content
only; existing assistants, recovery settings, shares and sign-ins were untouched.
After clean shutdown, the disposable app, new share, environment storage
registration, test mount and private qualification image tag were removed.
The existing environment, storage account and registry were preserved.

This qualifies the exercised single-replica shared-provider installation/update
path. It does not claim live ACA management-host checkpoint-package transfer,
new-instance cloning, private-network/registry combinations beyond the test,
crash/partition takeover or paid-provider sign-in. Prior interrupted-copy and
ownership rejection evidence below remains applicable; this pass did not inject
a platform kill during an SMB write. Azure support remains experimental.

### Earlier directory-store evidence

New installations now default to local checkpoint staging and Azure Files SMB copy.
Source regressions cover the dedicated share/environment storage ARM resources,
matching Job/App mounts, mounted-path validation, exact destination preservation,
and initialization without Blob credentials. Blob opt-in retains its existing flow.
On November 10, 2026, a new isolated directory on the approved Azure Files test
share passed real SMB checkpoint/cold restore with a committed WAL row, concurrent
owner refusal, interrupted-copy preservation of the accepted generation, and a
post-restore checkpoint/release. The share rejected hard links with errno 95.
Live databases and staging stayed on local storage throughout.
The live installation/replacement evidence above now covers the new mounted-share
provisioning path. Historical Blob qualification below remains specific to Blob;
existing assistants must not be repurposed for qualification.

## October 31, 2026 — live experimental qualification

PR #97 was exercised against two disposable, synthetic-data-only assistants in
the approved development subscription, using the published `0.4.1001` image.
Existing lab assistants were not changed. Azure remains explicitly experimental
in the setup form, installation preview and hosting documentation.

| Live scenario | Result |
| --- | --- |
| Fresh CLI installation | Created a Consumption environment, storage account, per-assistant Blob container, user-assigned identity and initialization Job; deployed the assistant and removed its successful temporary Job. |
| Admin installation using existing resources | The actual Electron wizard reused the test environment/account, selected on-demand availability and an existing Azure Files mount, reviewed costs/resources and installed successfully. |
| Identity propagation failure | The second initializer initially failed Blob authentication while the newly assigned role propagated. The failed Job remained inspectable. Admin's explicit Retry failed step succeeded without clearing the namespace. No automatic retry or credential workaround was used. |
| Native management | Admin connected using the generated native secret. Native preference writes hot-reloaded and round-tripped multibyte UTF-8. Both image-baked worker setup scripts accepted immediate cancellation without vendor sign-in. |
| Stop, update while stopped, Start | Interrupted update was resumed with the compiled CLI. Final stopped intent was preserved. Start restored three synthetic files and a real SQLite-backed OpenCode session onto a different replica. |
| Deferred settings and revision update | The real Admin IPC saved a timezone draft without changing Azure; the draft survived closing/reopening Electron. Explicit apply created a new revision, retained authentication/identity/mounts and restored the files/session. Native OS confirmation dialogs were not manually qualified; the shared confirmation/Later behavior is covered by renderer regressions. |
| Recovery policy editing | Native inspection supplied the baseline; saving a changed checkpoint interval and custom path created a pending draft. Explicit apply preserved native credentials and produced healthy, durable recovery with the requested coverage. |
| Natural scale to zero and wake | With clients closed and no ingress probing, ARM reported zero replicas. Access through the normal authenticated OpenCode endpoint woke a new replica. Three recovered local files, the SQLite-backed session and an independent Azure Files marker were intact. |
| Independent Azure Files | Non-root writes succeeded. Coverage reported the mounted directory as external and excluded it from checkpoint ownership. |
| Invalid Azure placement | An invalid CPU/memory combination produced a retained failed ARM deployment, no application writers, and an inspectable continuation. Initial rejection, accepted-then-failed and uncertain transport results now have distinct regression coverage using the actual Azure SDK transport. |

Failures found and fixed during qualification:

- ARM rejects the CLI's literal logging destination `none`; the template now
  omits log routing, verified by live Azure validation and a fresh deployment.
- Recovery inspection now receives only recovery-related environment inputs,
  rather than unrelated container settings such as timezone.
- Azure resource identity comparison is case-insensitive; local/SSH paths are
  unchanged. Existing recent selections and deployment drafts retain their identity.
- Native remote setup no longer has an extra stdin reader that could consume
  the user's first answer or cancellation before the setup program starts.
- Generic ARM SDK resource calls no longer double-prefix the resource path.
  Existing native continuations with that spelling remain resumable without
  altering their signed polling URLs.
- `update --resume --confirm` gives CLI users an explicit route to finish saved
  deployment changes. Plain Update still does not consume an unrelated draft.
- Confirmed initial rejections remain actionable after temporary inspection
  failures. Confirmed failed/canceled pollers are not mislabeled as unknown;
  genuinely uncertain submissions are still inspected instead of replayed.
- The setup screen distinguishes platform status from native readiness instead
  of claiming startup failure merely because native readiness is uninspected.

Verification: full repository suite **1,227 passed, nine opt-in tests skipped,
zero failed**; subsequent final focused regressions **48 passed**; actual Chromium
workflow **360 assertions**; all six typechecks, configured lint gate, CLI/Admin
builds and documentation tests passed. Terra reviewed the final changes and its
remaining transient-inspection finding was fixed and regression-tested.

This qualifies the exercised single-replica public-ingress path, not every Azure
topology. Native vendor login/pairing, paid model inference, private-network/Key
Vault/private-registry deployments and packaged OS confirmation dialogs remain
outside this live pass. Forced termination can still lose work since the last
accepted checkpoint; Files mounts require their own protection. No container
source or runtime pins changed, and this work does not claim full cloud archive,
Guardian or Portal provisioning support.

## October 31, 2026 — PR #97 Terra review follow-up

A separate `gpt-6.1-terra` reviewer examined the PR and re-reviewed the fixes.
The parent verified the reported paths against source and synthetic regressions:

- Correcting a failed apply preserves whether the instance was originally running,
  including after reopening the tool. Discard retains explicit manual-Start guidance
  and never silently restarts or rolls back a deployment.
- An image Update with a pending draft requires apply/discard first; it no longer
  reports an update while silently applying only the unrelated draft.
- Selecting a sidecar image does not redirect Assistant environment/recovery edits.
  Ambiguous Assistant controls stay disabled, and invalid targeting is caught before
  Stop. Explicit image updates remain available.
- Reused environments omit the optional named workload pin, accommodating legacy
  consumption-only environments. The reviewer’s broader dedicated-only claim was
  narrowed after checking [Microsoft’s workload-profile documentation](https://learn.microsoft.com/en-us/azure/container-apps/structure):
  workload-profile environments include a default Consumption profile.
- Fresh and offline initialization Jobs carry the Assistant’s Files mounts required
  by its recovery policy. Offline jobs preserve the app’s workload-profile selection;
  unrelated service secrets and native API credentials remain excluded.
- Native PTY output uses streaming UTF-8 decoding, tested with multibyte characters
  split byte-by-byte across binary frames interleaved with cursor metadata.

Focused regressions: 160 passed. The real Chromium workflow passed 360 assertions;
CLI/Admin builds, all six typechecks, lint gate and documentation checks passed.
The full-suite result is recorded in the PR follow-up. Changes remain tooling-only,
with no container/runtime pins changed. These checks and the review do not qualify
live Azure behavior; no Azure or lab instance was mutated.

## October 31, 2026 — ACA parity implementation

Branch `codex/aca-management` extends the existing-app provider with provisioning,
deferred deployment changes and shared native agent management. It uses the
published `0.4.1001` Assistant; no container source or runtime pin changes are
required. The [implementation plan](../technical/aca-management-implementation-plan.md)
records scope and the explicitly deferred cloud archives/Guardian/Portal work.

Evidence gathered during implementation:

- The actual published Assistant image
  `fwdslsh/fhold-assistant@sha256:5d5696bb382a802c7f441c6db87e6dec4ab98cdb3936bf186df6585b4c9f41de`
  passed the opt-in native-management test: 14 assertions covering authenticated
  native PTY execution, atomic preference edits and the existing recovery
  inspection command. These used synthetic local data, not an existing instance.
- The native recovery initialization diagnostic passed seven assertions against
  that image. It also showed why mounting root-owned empty local tmpfs directories
  over native homes is not a qualified default. The ACA template instead retains
  the image's owned writable directories and restores durable state from Blob.
  This local diagnostic is not evidence of ACA volume ownership behavior.
- Real Azure SDK pollers, with intercepted HTTP and synthetic responses, cover
  serialization/resume of Start and resource PATCH. Resume issues only GETs;
  request bodies, results and secret values are not retained in continuation
  metadata. This caught and fixed a missing native poller-mode field that simpler
  adapter mocks did not expose.
- Adapter regressions cover narrow updates, preservation of unrelated Azure
  configuration, completed lifecycle ordering, failed versus unknown outcomes,
  target-bound continuations, initialization progress/retry, and generated Job
  collision avoidance. There is no external-manager/adoption/tag prerequisite.
- The shared Admin workflow passed a real Chromium walkthrough with 360
  assertions against synthetic hosting/native services. It includes new cloud
  installation, collapsed defaults, deployment preview, pending changes, narrow
  layouts and local-provider regressions. It is not a live Azure deployment test.

The UX consistency follow-up gives local and SSH Docker the same System deployment
editor as ACA, backed by existing intent-save and lifecycle operations. Shared
drafts remain target-bound on the management computer until explicit apply.
Tests cover postponement, discard, persistence across reopen, unrelated-setting
preservation and failed activation. The common action/confirmation is Apply
changes, with host-effect-specific interruption details. Docker-only limitations
(scale-to-zero, scheduling overrides and custom image repositories) are explained
without changing the screen layout. No new Compose layer or runtime input was added.

The follow-up also fixes the form's incorrect timezone key (`TZ` instead of the
shared `FH_TIMEZONE`). Renderer tests now pass all three provider submissions
through the real input parser; the Azure adapter verifies the native `TZ`
translation and normalized readback. Real Chromium exercises the same form,
disabled fields and Later behavior for all three providers, with desktop and
320-pixel captures visually reviewed. These use synthetic service responses,
not live Azure or SSH deployments.

Final integrated checks:

| Check | Result |
| --- | --- |
| All six workspace typechecks | Passed. |
| Full repository tests with socket tests enabled | 1,207 passed, zero failed; nine opt-in image tests skipped in the general run. The two new image tests were exercised separately as described above. |
| Repository lint | Passed its configured gate; existing style warnings remain. |
| CLI compile and Admin bundle | Passed, including both bundled Linux management helpers. |
| Compiled CLI no-start installation and all-profile Compose validation | Passed against a disposable generated home; no services started. |
| Documentation tests and site check | Passed. |
| Runtime dependency scope | Existing classifier reports tooling-only, no container images required. All non-tooling package resolutions and platform metadata remain unchanged. |
| Independent architecture and engineering review | Approved after continuation, retry, identity selection and native cancellation fixes. |

Local tests used Bun 1.4.1 and installed Node.js 24.18.0; CI uses the repository's
pinned Bun version. Initial native-test failures were reproduced as a host
Bun-as-Node alias and an AKM fixture under an ignored `.private` directory.
Using native Node and a normal generated fixture directory resolved them without
product/test workarounds. Packaged AppImage and native runner qualification are
left to PR CI; a successful bundle is not claimed as packaged-app qualification.

### Qualification outstanding at the implementation checkpoint

The later live experimental qualification above supersedes this earlier list.

Live Azure resource creation, initial managed-identity role propagation, actual
Blob checkpoint/restore across a new replica, scale-to-zero/wake, optional Azure
Files mounts and stopped-state behavior during Azure revisions remain unverified.
No existing Azure or lab instance was changed. Vendor sign-in and paid inference
were not used. New cloud provisioning remains experimental until those scenarios
are exercised with an explicitly approved disposable resource group.

Offline restore in a separate ACA Job is intentionally unavailable: its writable
layer is not the app's writable layer. Normal app Start performs the real restore.
Existing system-assigned identities are not silently replaced with user-assigned
identities to make initialization Jobs possible.

## Historical qualification — October 22, 2026

Checked October 22, 2026 UTC on `codex/azure-management`, based on main
`ec42455`. This is host-side management of existing Container Apps, not a new
Assistant image or a provisioning/deployment system.

## Evidence

- Full regression run: 938 passed, five opt-in native-image tests skipped.
  All package type checks, CLI build, Admin bundle, the focused Chromium UI test
  (137 assertions), documentation checks and all-profile Compose validation
  passed. Lint passed with warnings; the existing two reviewed audit exceptions
  remain unchanged. No dependencies or runtime pins changed.
- Native Azure CLI 2.91.0 with Container Apps extension 1.3.0b4: account and
  resource-group checks, discovery of seven existing fhold apps, revision status,
  zero-replica observation, system logs and subscription/resource-group choices.
  Queries projected metadata only; no environment, secret or storage values were
  read. No agent HTTP request was made and no app was started, stopped or changed.
- Actual bundled Electron 44.9.3 Admin and compiled Linux x64 CLI: a private
  connection profile, automatic discovery, instance selection, native platform
  status/logs, connection editing and scope loading. The selected scope survived
  refresh. Window geometry stayed 1120 × 780 throughout the walkthrough. No
  renderer/preload API was replaced for this live walkthrough.
- Adapter/CLI tests cover native argument arrays, no global account change,
  recognition/scope boundaries, malformed responses, partial diagnostics,
  confirmation, stale/multiple revision selection, no mutation replay, log
  target selection, console invocation and preservation of unknown native logs.
  Renderer tests cover setup choices, native-only setup and refresh behavior.

Live checks found and corrected two issues in the previous adapter: system logs
require `--format json` (JSONL), whereas console logs support text; and Azure
reports `ScaledToZero`, not only the older `ScaledTo0` spelling. An absent replica
count now remains unknown rather than being presented as zero.

## Limits

Existing sign-in was used; a new browser sign-in, interactive cloud console,
Start/Stop/restart, vendor reconnect, recovery checkpoint and real writer drain
were **not** exercised against these existing apps. Mutating calls are covered
by adapter tests and the documented native commands, not claimed as live Azure
qualification. Request acceptance remains separate from readiness/completion.

No resources, images, scale settings, mounts, credentials, user data or recovery
owners were changed. Container/native-runtime acceptance remains a separate gate;
this change does not rebuild or requalify those images. Docker's full instance
settings/import/export are not emulated for ACA. Use the agent's native interface
and your existing deployment tooling for operations outside the adapter's scope.

See [hosted management](../hosting.md#azure-container-apps-experimental) for the
normal CLI/Admin path and [provider architecture](../technical/hosting-provider-architecture.md)
for the extension boundary.
