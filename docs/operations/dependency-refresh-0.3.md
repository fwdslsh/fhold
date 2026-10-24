# Dependency review for the first 0.3 beta

Checked official npm metadata for every workspace dependency and override,
GitHub tool/action releases, Node/Go release indexes and the native marketplace
on October 21, 2026, before freezing the 0.3 candidate.

| Component | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.261009-beta | 0.10.261010-beta (`next`) |
| AKM OpenCode, Claude and Codex plugins | 0.10.261008-beta | 0.10.261009-beta (`next`) |

The [CLI release](https://github.com/itlackey/akm/releases/tag/v0.10.261010-beta)
fixes workflow output/redaction/update behavior, caches successful no-change
memory decisions and adds knowledge UI improvements. The
[plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261009-beta)
requires exactly that CLI. npm `latest` lags both selected `next` channels.
The native marketplace is pinned to commit
`c8d8d965f5afe86637f649cfb821674d0ac1cabf`, archive SHA-256
`1c8afd88ee41aefacfbfd84dd7d23e591b49b6408355108652a0da2e774a25d3`.
Both native manifests agree on the plugin version; the comparison with the
previous baked commit changes version/dependency metadata, not native hook code.
The prior npm plugin was 0.10.261008-beta; its baked archive's native manifests
actually reported 0.10.26101001-alpha. This refresh replaces that mismatch with
the verified 0.10.261009-beta manifests in both native harnesses.

All other direct pins remain current on their selected compatible channels:
OpenCode CLI/client/SDK 2.0.32, Codex 0.163.0, Claude Code 2.1.306,
Playwright 1.64.1, Electron 44.9.3, electron-builder 26.18.0 (`v26`),
Node 24.22.1 LTS, npm 12.2.0, Bun/types 1.4.3, Go 1.27.3,
Supercronic 0.2.51, Trivy 0.76.1 and cosign 3.1.4.
MCP/Azure/Slack/Discord SDKs, TypeScript, Biome, archive/JSONC/Zod/JOSE and
accessibility dependencies, security overrides, all pinned Actions, and the
docs renderer/template were also reviewed. The single root lockfile receives
the compatible transitive refresh.
That refresh includes AWS SDK credential/provider packages, types and nested
clients, plus Azure MSAL Browser 5.26.0 / Common 16.14.3.

The existing [compatibility holds](dependency-refresh-2026-10-21.md#current-pins-and-explicit-holds)
remain: OpenCode 2.1.2 needs a reviewed history-import continuation metadata policy;
Effect 4.0.1 matches the selected SDK; Electron 45 needs separate major-version
qualification. The upstream AKM plugin still declares nested OpenCode 2.0.26 /
Effect rc.112 peers; actual image-backed native recall in all three harnesses
must pass. No vendor patch, floating runtime pin or startup upgrade is added.
Existing reviewed audit exceptions retain their exact scope.

The stamped final SHA must pass source/artifact gates and all six native
amd64/ARM64 image jobs. Publication reuses eligible canonical push CI for that
exact SHA, then verifies public assets and signed images. No existing instance
or recovery configuration is changed by this development/release process.

## Tooling-only 0.3.261001-beta review

Rechecked October 22, 2026 at 03:30 UTC before merging PR #53. Reviewed official
npm metadata for all 32 distinct workspace dependencies and overrides, selected
AKM/electron-builder channels, every pinned Action, native marketplace manifests
and immutable tag commit, Node/Go indexes, Supercronic, Trivy, cosign, docs renderer
and template. Bun 1.4.3's recursive no-cache update dry run made no source changes.

Admin/CLI dependencies remain current on their selected compatible channels:
Electron 44.9.3 (newest maintained 44 release), electron-builder 26.18.0 (`v26`),
TypeScript 7.0.2, Biome 2.6.2, axe-core 4.14.0, tar 7.5.22, JSONC 3.3.1,
citty 0.2.2 and Node types 26.6.5. Bun/types remain 1.4.3. Electron 45 retains
the separate major-version compatibility hold described above. All Actions and
the docs renderer/template remain current; no dependency declarations or package
resolutions change in this tooling release.

The published runtime cohort stays **0.3.261000-beta**. AKM CLI `next`
0.10.261010-beta and all three plugins 0.10.261009-beta remain current; both native
manifests and commit `c8d8d965f5afe86637f649cfb821674d0ac1cabf` were reverified.
Node 24.22.1 remains latest LTS; Go 1.27.3, Supercronic 0.2.51, Trivy 0.76.1
and cosign 3.1.4 remain current. The existing OpenCode 2.1/Effect holds remain.

New upstream Claude Code **2.1.307** (published runtime: 2.1.306), npm **12.2.1**
(12.2.0), and the dry run's runtime-only `@effect/platform-node-shared` **4.0.6**
(4.0.5) are explicitly deferred to the next full runtime qualification. Updating
them here would change the Assistant/dependency cohort and require publishing
containers outside this Admin/CLI-only release. They are not described as current
in the retained image. No new advisory exception or vendor patch is introduced.

Tooling versions advance only the root, library, CLI and Admin manifests and their
lockfile workspace versions. Container pins, Skeleton and extension versions,
existing instance homes/data and native account state remain untouched. Qualify
the final stamped SHA using the normal tooling and native artifact gates.

## Admin settings/updater review

Rechecked October 22, 2026 at **05:02 UTC** against official npm metadata for all
33 workspace dependency/override names, selected AKM/electron-builder channels,
every pinned Action, native marketplace tag, Node/Go indexes, Supercronic, Trivy,
cosign and docs renderer/template. Add the current supported **electron-updater
6.8.9** to Admin only. The existing compatible dependency versions are retained;
Bun adds its four missing packages and rehoists existing YAML/argparse entries
without changing their per-consumer versions. Frozen installation and the
763-package audit pass with the two existing reviewed exceptions only.

Existing OpenCode 2.1, Effect and Electron 45 compatibility holds remain. AKM
CLI `next` 0.10.261010-beta and all three plugins 0.10.261009-beta remain current,
with the same immutable native marketplace commit. All pinned Actions, Bun 1.4.3,
Node 24 LTS, Go, Supercronic, Trivy and cosign remain current on selected channels.
Claude Code **2.1.308** has now superseded the 2.1.307 noted at 03:30; it and npm
12.2.1 remain explicit next-full-runtime refresh items, not part of a desktop
settings/updater feature. No runtime pin, container source, new advisory exception
or vendor implementation is changed here. This branch does not stamp or publish
a release or upgrade any installed instance.

## Tooling-only 0.3.261002-beta final review

Rechecked official metadata on **October 22, 2026 at 16:46 UTC** for all 33
workspace dependency/override names, selected channels, native marketplace,
Actions, base/tool indexes and documentation dependencies. Admin's updater 6.8.9,
Electron's supported 44.9.3 line, electron-builder's `v26` 26.18.0, TypeScript,
Biome, accessibility and CLI/library dependencies remain current on the selected
compatible channels. No dependency resolution or runtime pin changes in this
release preparation; the updater addition already passed PR #54's full native
amd64/ARM64 image gates.

New AKM `next` CLI **0.10.261011-beta** / plugins **0.10.261010-beta**, Bun/types
**1.4.4**, Claude Code **2.1.308** and npm **12.2.1** are deferred to the next
full runtime/dependency-cohort qualification. The image still contains the exact
versions recorded for 0.3.261000-beta above. OpenCode is now **2.1.3**, retaining
the documented 2.1 migration hold; Effect **4.0.5** retains the selected OpenCode
SDK's exact 4.0.1 compatibility hold, and Electron 45 remains a separate major
qualification. No runtime update is claimed by this Admin-only beta. Actions,
Node 24 LTS, Go, Supercronic, Trivy, cosign and docs remain current as reviewed.

Tooling-only lock classification now compares resolved non-tooling dependency
edges, package metadata and integrity, allowing the Admin-only updater addition
and unchanged YAML/argparse rehoisting. Runtime source/resolution changes still
require full publication; unknown formats and unexplained changed records retain
full gates. Regression tests cover shared upgrades, wrong hoists, workspaces,
scoped packages, optional/peer edges, cycles and changed integrity.

## Runtime dependency refresh after 0.3.261002-beta

Rechecked official npm metadata, the native marketplace tags, Docker Hub base
image tags, GitHub Action/tool releases and Node/Go/Bun/Supercronic indexes on
**October 22–23, 2026**. This branch updates container pins and the single root
lockfile; it does not stamp or publish a release or change any installed instance.

| Component | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.261010-beta | 0.10.261012-beta (`next`) |
| AKM OpenCode 2 plugin (Assistant and fhold plugin) | 0.10.261009-beta | 0.10.261011-beta (`next`) |
| AKM Claude/Codex marketplace | `c8d8d965…` (0.10.261009-beta) | `4f27fc82…` (`v0.10.261011-beta`) |
| Claude Code | 2.1.306 | 2.1.309 (`latest`) |
| npm (Assistant Node stage) | 12.2.0 | 12.2.1 |
| Bun, base images, workflows, `bun-types` | 1.4.3 | 1.4.4 |

The [AKM 0.10.261011/261012 CLI changes](https://github.com/itlackey/akm/blob/v0.10.261012-beta/CHANGELOG.md)
improve distill lesson quality, fix process-group signal handling and extraction
re-proposals, and rename date frontmatter keys (`observed_at` becomes `observed`;
old names are still read and stashes are not rewritten). fhold does not reference
those keys. The native lock/state paths used by the recovery catalog are unchanged
from 0.10.261009-beta. The selected plugin requires exactly AKM CLI
0.10.261012-beta. Its marketplace tag resolves to commit
`4f27fc82d02e4dd5901d725bc9fd23e762264c1a`, archive SHA-256
`c762ca0b4545b364c47b39f518f505c366bc72d9091c1b59215b7a3e9197c123`
(reproduced with `git archive` plus `gzip -n`, and confirmed against the previous
pin's known checksum). Compared with the previous baked commit it changes only
version metadata. Both native manifests report 0.10.261011-beta; hook code and
extraction paths are unchanged.

npm 12.2.1 bundles `brace-expansion` 5.0.12 and `undici` 6.29.0, fixing the three
approved runtime findings. The Trivy exception file is removed (see
[reviewed runtime advisories](release.md#reviewed-runtime-advisories)).
`bun update --recursive --no-cache` also refreshes `body-parser` 2.4.0,
`on-finished` 2.4.2 and `@electron-internal/extract-zip` 1.0.6, and dedupes
`@effect/platform-node`'s shared package onto 4.0.1, matching its Effect 4.0.1 peer.
The raw audit now reports only the reviewed node-forge advisory; the reviewed
sprintf-js exception is unchanged.

Holds retained: OpenCode stays on **2.0.32** (2.1.3 is `latest`) pending the
documented 2.1 history-import continuation metadata review, with Effect at the
SDK's exact **4.0.1** (4.0.6 available). Electron stays on maintained 44.9.3
(45.0.0 needs its own major qualification). electron-builder stays on `v26` 26.18.0.
AKM's plugin still declares nested OpenCode 2.0.26 / Effect rc.112 peers, so native
recall in all three harnesses remains a required image gate. Codex 0.163.0,
Playwright 1.64.1, Node 24.22.1 LTS, Go 1.27.3, Supercronic 0.2.51, Ubuntu 24.04,
Azure/MCP/Slack/Discord SDKs, TypeScript 7.0.2, Biome 2.6.2, overrides, all pinned
Actions, Trivy 0.76.1, cosign 3.1.4 and the docs renderer 0.11.16/template 0.5.0
are current on their selected channels.

## Tooling-only 0.3.261004-beta review

Rechecked official upstream metadata on **October 23, 2026 at 05:18 UTC** for
all 33 workspace dependency/override names, selected channels, native AKM
marketplace manifests and tag commit, all pinned Actions, Node/Go/Bun,
Supercronic, Trivy, cosign and the documentation renderer/template. Bun 1.4.4's
`bun update --recursive --no-cache --dry-run` checked 878 packages and found
nothing to update. The root lock changes only tooling workspace version metadata.

Electron's maintained `44-x-y` channel remains 44.9.3, electron-builder `v26`
remains 26.18.0, and electron-updater remains 6.8.9. All other tooling pins remain
current on their selected compatible channels. The existing OpenCode 2.1,
Effect and Electron 45 compatibility holds remain documented above.

The retained runtime is **0.3.261003-beta**. AKM CLI `next` 0.10.261012-beta and
OpenCode plugin 0.10.261011-beta still agree on the exact required CLI. Both native
marketplace manifests report 0.10.261011-beta at the same immutable
`4f27fc82d02e4dd5901d725bc9fd23e762264c1a` commit. Claude Code 2.1.309, npm 12.2.1,
Bun 1.4.4, Node 24.22.1 LTS and the selected base/compiler/tool versions remain
current. Newly published Codex **0.164.0** is deferred to the next full runtime
qualification; this tooling release retains the published image's **0.163.0**.
No new advisory exception, runtime pin or dependency resolution is introduced.

Management architecture tests are explicitly classified and executed as tooling
checks. Unknown inputs, runtime sources and runtime dependency changes still
select full qualification. The release advances CLI/Admin only, preserving the
published runtime and extension defaults and leaving live instances unchanged.

## Tooling-only 0.3.261005-beta restart fix

Rechecked October 23, 2026 at **15:26 UTC** against official npm metadata for
all 33 workspace dependency/override names and selected channels, every pinned
Action, native marketplace manifests, Node/Go indexes, Bun, Supercronic, Trivy,
cosign and docs renderer/template. Tooling packages remain current on their
compatible channels. Docker login Action **4.7.0** supersedes 4.6.0 and is updated
in the release workflow; its container-only jobs are not exercised by this tools
publication. Other Actions and selected toolchain pins remain current. Bun's
recursive no-cache update dry run checked 878 packages with nothing to update;
only tooling workspace version metadata changes in the lockfile.

AKM CLI `next` 0.10.261012-beta and all three plugins 0.10.261011-beta match the
immutable marketplace commit `4f27fc82d02e4dd5901d725bc9fd23e762264c1a`. Retain
runtime/extension cohort **0.3.261003-beta**. Codex 0.164.0 remains deferred to
the next runtime release (image pin 0.163.0). OpenCode 2.1.4 now supersedes 2.1.3
upstream; the existing history-import compatibility hold retains 2.0.32 with
Effect 4.0.1. Electron 45 retains its separate major-version qualification hold;
the selected maintained 44 line stays at 44.9.3. No runtime dependencies or
container inputs change for this host-tool regression fix.

## Full 0.3.261006-beta review

Rechecked official metadata on **October 23, 2026 at 20:12 UTC** for all 33
workspace dependency/override names, selected channels, native AKM marketplace
manifests, every pinned Action, Node/Go indexes, Bun, Supercronic, Trivy, cosign
and documentation dependencies. This is a full runtime and tooling release.

| Component | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.261012-beta | 0.10.261013-beta (`next`) |
| AKM OpenCode, Claude and Codex plugins | 0.10.261011-beta | 0.10.261012-beta |
| Codex | 0.163.0 | 0.164.0 |
| MCP client/server SDKs | 2.3.1 | 2.4.0 |

The [AKM CLI changelog](https://github.com/itlackey/akm/blob/v0.10.261013-beta/CHANGELOG.md)
includes task synchronization from the implicit working stash, workflow reference
handling and environment propagation fixes. Existing fhold task commands and
recovery paths remain applicable. The OpenCode plugin requires this exact CLI.
The [native plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261012-beta)
resolves to commit `1b272d8ddc07530e7378bcd76c7ff57a70d1f1fe`, archive SHA-256
`7b85dc778e9c4100b7e3ff7dbc7b716c5c539d0a5924aae76023aa3040c41b3e`.
Both native manifests report 0.10.261012-beta; changes from the previous baked
commit affect version metadata, not native hook logic. Actual native recall in
all three harnesses remains an image gate, including the plugin's nested
OpenCode 2.0.26 / Effect rc.112 peers.

[Codex 0.164.0](https://github.com/openai/codex/releases/tag/rust-v0.164.0)
includes resume/settings fixes and is qualified with fhold's managed native
configuration. MCP 2.4.0's changed header-schema annotations and output wrapping
do not require source changes for fhold's schemas; Guardian, Portal and bridge
tests cover the updated clients/server. A recursive no-cache lock refresh also
updates compatible `node-abi` resolutions to 3.101.0 and 4.40.0.

Explicit holds remain: OpenCode **2.0.32** rather than 2.1.4 pending #57's
history-import continuation review; Effect **4.0.1** to match that SDK's exact
peer; Electron **44.9.3** on its maintained major rather than 45.0.0.
electron-builder remains on the current `v26` channel, **26.18.0**.
Claude Code 2.1.309, npm 12.2.1, Bun/types 1.4.4, Node 24.22.1 LTS,
Go 1.27.3, Supercronic 0.2.51, Ubuntu 24.04, remaining workspace dependencies,
overrides, Actions, Trivy 0.76.1, cosign 3.1.4 and docs renderer/template
0.11.16/0.5.0 remain current on their selected channels.

The product owner approved a new, narrowly scoped
[Brotli exception](release.md#temporary-brotli-exception-october-23-2026):
only CVE-2026-111497 in Debian `libbrotli1` 1.1.0-2+b7, expiring November 6.
The raw report remains visible and other critical/fixable-high findings still
block publication. The old npm exceptions remain removed. No library is patched,
no floating runtime dependency is introduced, and no live instance is changed.

Qualify the stamped source with source/artifact tests and all six native image
jobs, then verify published assets and signed multi-architecture images. Release
publication is separate from upgrading existing instances.

## Tooling-only 0.3.261007-beta review

Rechecked official registry metadata on **October 24, 2026 UTC**, immediately
before merging PR #62: all workspace dependencies/overrides via recursive Bun
inspection, compatible transitive refresh, selected AKM channels, immutable native
marketplace tag, pinned Actions/tools and Node/Go release indexes. The docs
renderer/template retain their supported 0.11.16/0.5.0 versions.

Update Admin's **electron-updater 6.8.9 → 6.8.11** on the stable channel, including
upstream differential-download/cache fixes and cached-filename validation. Electron
**44.9.3** remains latest on the supported 44 line; 45.0.0 retains its separate
major-version qualification hold. Other direct tooling pins remain current.

Retain runtime **0.3.261006-beta** and its exact package resolutions. AKM CLI
`next` **0.10.261013-beta**, all three plugins **0.10.261012-beta**, native archive
commit `1b272d8ddc07530e7378bcd76c7ff57a70d1f1fe`, Codex 0.164.0, Bun 1.4.4,
Node 24.22.1 LTS, npm 12.2.1, Go 1.27.3 and Supercronic 0.2.51 remain current on
their selected channels. Actions, Trivy 0.76.1 and cosign 3.1.4 are unchanged.

Explicit holds: OpenCode **2.0.32 → 2.1.4** and Effect **4.0.1 → 4.0.6** remain
pending the native compatibility work in #57. Claude Code **2.1.309 → 2.1.310**
waits for the next qualified runtime refresh. The compatible lock refresh also
found ONNX/AKM's **global-agent 4.1.3 → 4.1.6** and MCPB's
**ignore 7.0.13 → 7.0.14**. Both are deferred to that full runtime/extension
qualification, not silently shipped in a tools-only candidate. Their known-good
lock records were retained and frozen installation reverified.

The owner approved the two precise temporary MSAL/Zod exceptions described in
the [release runbook](release.md#temporary-upstream-msal-and-zod-exceptions),
tracked by [#63](https://github.com/fwdslsh/fhold/issues/63). Azure Identity still
requires MSAL 6; AKM and MCPB still require Zod 3. Re-review on the next AKM update,
before release and by November 6; remove each exception when its supported chain
is fixed. No forced major override or vendor patch is used. Runtime images and
their existing Brotli exception are unchanged and are not requalified by a
tooling publication. Qualify the stamped tools on canonical main CI and verify
the public downloads and update feeds before calling publication complete.
