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
The subsequent owner-requested stable refresh is recorded below. The raw audit
still reports only the three reviewed source exceptions tracked in #63;
runtime image scans remain separate gates.

## Compatible dependency refresh and upstream holds

Reviewed November 8, 2026 against npm publications, native package requirements
and official image tags. Update Claude Code **2.1.312 → 2.1.319**, Codex
**0.165.0 → 0.167.0**, Playwright **1.64.1 → 1.65.0** (including its matching
Chromium), jose **6.2.14 → 6.2.16**, discord.js **14.27.0 → 14.28.1**, Electron
**45.1.0 → 45.2.3**, electron-builder **26.18.0 → 26.18.1**, electron-updater
**6.8.11 → 6.8.12** and Biome **2.6.4 → 2.6.6**. Electron builder/updater's
maintained `v26` dist-tag contains the newer stable releases even though their
`latest` tags lag. Existing Discord REST constraints accept the retained override.

Published glob **13.0.7** backports the abort/cancellation fix and satisfies
the existing `^13` ranges. However, `bun update glob` deduplicated those edges
onto OpenCode's exact **13.0.5** instead of selecting the backport. Discard that
refresh and preserve the existing **13.0.6**, **13.0.5** and **10.5.0** resolutions.
The backport is available but is not adopted here; wait for owning upstream
package updates rather than adding a dependency solely to influence hoisting,
forcing an override, or editing generated lock entries by hand.

Wait for supported upstream package updates before changing these dependencies:

| Hold | Reason and next action |
| --- | --- |
| Effect 4.1.0 | OpenCode 2.2.6's SDK and related packages require exactly 4.1.0. Adopt 4.1.2 or newer with a compatible upstream SDK release; do not force mixed versions. AKM's plugin retains its own native SDK/Effect resolution. |
| MCPB 2.1.2 / Zod 3.25.76 | Latest MCPB still requires Zod 3. Await MCPB adopting patched Zod; never override its major version. AKM's own Zod 4.6.7 is already patched. |
| Remaining glob and minimatch | Await OpenCode, Electron-builder and their owning dependencies adopting patched versions within supported constraints. Even Electron-builder 26.18.1 retains minimatch 10 and older native packaging dependencies. Do not force glob 14 or minimatch 11 into incompatible parents. |
| Skopeo image 1.22.3 | Source 1.24.1 exists, but `quay.io/skopeo/stable:v1.24.1` is absent and the registry's `latest`/`v1` tags still resolve to the pinned 1.22.3 digest. Wait for the official image publication before changing the digest. |

The [glob backport](https://github.com/isaacs/node-glob/compare/v13.0.6...v13.0.7)
is newer evidence than the advisory's listed patched range (still only 14.0.2).
The three exact source-audit exceptions in [#63](https://github.com/fwdslsh/fhold/issues/63)
remain necessary for affected chains. No exceptions are widened or added, and
the issue must stay open until all affected chains are resolved. Audit metadata
alone must not obscure a verified backport or be treated as proof all chains are fixed.

AKM CLI/web **0.10.261113-beta** and plugins **0.10.261112-beta** remain the
approved compatible beta set. Bun 1.4.4, Node 26.13.0, npm 12.2.2, Go 1.27.3,
Supercronic 0.2.51 and Trivy 0.76.2 were current on this review. Changed inputs
require fresh native image and desktop checks; prior PR success does not qualify
these dependency changes.

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

After the owner selected an existing Azure Files share, a new isolated synthetic
directory exercised real SMB 3.1.1 semantics. Hard links failed with EOPNOTSUPP;
AKM's unmodified fallback preserved 80 concurrent writes and passed live-owner
exclusion, killed-owner reclaim, fresh-empty grace and release cleanup. Native
retry handled Azure's delayed metadata refresh (two attempts in all three fresh
crash cases). CLI remember/show/index/search/feedback passed with content on Azure
and SQLite kept local. The synthetic directory was removed and the share
unmounted. This does not qualify cross-host PID ownership or network SQLite.
[Detailed evidence](https://github.com/fwdslsh/fhold/pull/103#issuecomment-6726168329).

## Native AKM web interface

The published `akm-web` **0.10.261113-beta** now joins Assistant's exact image
pins. Its required CLI matches **0.10.261113-beta**; no extra CLI copy or
dependency override is needed. The ordinary `akm-web` executable replaces the
removed `akm ui` command in Admin's session-owned launcher.

Use upstream's JSON readiness message, `desktop_session` bootstrap and native
HttpOnly cookie. Local access binds the container bridge address. SSH selects
a loopback port before launch and supplies that exact browser `--origin`, then
uses the existing native SSH TCP forward. There is no header-rewriting proxy,
new authentication service, published port or persistent UI daemon.

The image browser smoke covers the published application over direct and
forwarded TCP routes, authenticated page/reload, token removal from the URL,
and rejection of unauthenticated, wrong-Host and wrong-Origin requests.

## Validation and deferred work

Local development checks passed: type checks; 1,236 source tests with nine opt-in
skips; the updated workflow suite (10 tests); lint (existing repository warnings);
CLI build; Admin bundle; docs check; frozen-lockfile installation; all Compose
profiles; changed shell syntax; and the real OpenCode browser regression above.
The PR's native image matrix remains the authority for the final image/plugin,
provider, scheduler, recovery and security checks; local source/browser success
does not substitute for those gates.

Workspace API changes remain excluded. Native learning, cache-contract and
offline-marketplace follow-ups remain dependent on AKM issues
[#1506](https://github.com/itlackey/akm/issues/1506),
[#1507](https://github.com/itlackey/akm/issues/1507) and
[#1508](https://github.com/itlackey/akm/issues/1508); no downstream substitute is added.
