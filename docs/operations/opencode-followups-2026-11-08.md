# Native platform follow-ups — November 8, 2026

## OpenCode model visibility

Update all owning OpenCode CLI/client/plugin pins from **2.2.1 to 2.2.6** and
fhold's Effect pin from **4.0.1 to 4.1.0**, matching the new plugin SDK.
[Upstream PR #60496](https://github.com/anomalyco/opencode/pull/60496) preserves
an unknown model release timestamp instead of converting it to January 1970.
This allows the native picker to apply its existing unknown-date visibility rule
and addresses [fhold #34](https://github.com/fwdslsh/fhold/issues/34).

The image browser smoke now checks the real bundled OpenCode UI with a synthetic
configured model and fresh browser storage: default visibility, explicit hide
and show across reloads, selection, and another fresh profile. It does not seed
localStorage, invent release dates, alter provider restrictions or make model
calls. Existing image-native provider and AKM harness gates cover inference,
configuration preservation and plugin compatibility separately.

AKM CLI **0.10.261113-beta** and plugins **0.10.261112-beta** remain the current
published `next` pair at review time. The native marketplace stays unchanged.
AKM's OpenCode plugin still declares SDK 2.1.4 / Effect 4.0.1; its native harness
must pass alongside OpenCode 2.2.6. There are no overrides or vendor patches.
This targeted update does not refresh unrelated dependencies. The raw audit
still reports only the three reviewed source exceptions tracked in #63;
runtime image scans remain separate gates.

## Smaller maintenance changes

- OpenCode 2.2.6 also executes the preserved migrated AKM harness invocation
  without the old `service.json` permission failure. Remove the upgrade test's
  expected failure and manual argument repair; require successful execution and
  persisted proposals while asserting the operator config stays byte-identical.
- Native Windows/macOS desktop CI already qualifies draft opening and pushes.
  Remove the redundant `ready_for_review` trigger, retaining base-change,
  reopening and manual runs. No failed check is waived or converted to success.
- Clarify release merge planning before qualification. Preserve and verify
  candidate content without treating repository merge-setting changes as a
  routine release operation.
- Correct earlier indexing descriptions: AKM removed the freshness walker,
  not native first-use indexing. Missing/uninitialized indexes and a changed
  stash still require native bootstrap; incremental writes remain AKM-owned.

## Filesystem verification boundaries

A disposable loopback Samba 4.21.9 share mounted through Linux CIFS/SMB 3.1.1
exercised the published CLI's unmodified lock module. Eight processes completed
80 serialized writes without loss; live-owner exclusion, killed-owner reclaim,
fresh-empty lock grace and final lock cleanup passed. The guest-only fixture
used permissive test-directory modes and no existing user data.

This Samba server supports hard links, so that result does **not** qualify
the hard-link-free fallback or Azure Files semantics. Azure testing requires an
explicitly selected isolated test directory. Keep SQLite/index state on local
storage; a shared content/lock test does not authorize network-hosted SQLite,
live-instance changes, recovery changes or a restore.

## Deferred work

Local development checks passed: type checks; 1,236 source tests with nine opt-in
skips; the updated workflow suite (10 tests); lint (existing repository warnings);
CLI build; Admin bundle; docs check; frozen-lockfile installation; all Compose
profiles; changed shell syntax; and the real OpenCode browser regression above.
The PR's native image matrix remains the authority for the final image/plugin,
provider, scheduler, recovery and security checks; local source/browser success
does not substitute for those gates.

Defer AKM UI integration until the upstream `akm-web` package is published.
Workspace API changes remain excluded. Native learning, cache-contract and
offline-marketplace follow-ups remain dependent on AKM issues
[#1506](https://github.com/itlackey/akm/issues/1506),
[#1507](https://github.com/itlackey/akm/issues/1507) and
[#1508](https://github.com/itlackey/akm/issues/1508); no downstream substitute is added.
