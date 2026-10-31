# Azure management qualification

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

### Qualification still required

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
