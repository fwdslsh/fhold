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
