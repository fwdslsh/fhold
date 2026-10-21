# Dependency review for the October 21 issue fixes

Review the owning manifests, every workspace and override, native marketplace
archive, runtime/compiler images, CI tools and documentation dependencies before
merging the work for issues #42, #38 and #39. This is a development refresh, not a
new release or a claim that published beta.12 contains these versions.

## Selected updates

| Component | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.261005-beta | 0.10.261008-beta (`next`) |
| All three AKM harness plugins | 0.10.261004-beta | 0.10.261007-beta (`next`) |
| OpenCode CLI, client and plugin SDK | 2.0.29 | 2.1.2 (`latest`) |
| Codex | 0.162.1 | 0.163.0 (`latest`) |
| Claude Code | 2.1.300 | 2.1.306 (`latest`) |
| JOSE | 6.2.12 | 6.2.13 |
| Electron | 44.7.2 | 44.9.3 (maintained 44 branch) |
| electron-builder | 26.17.0 | 26.18.0 (`v26`) |
| Go compiler | 1.27.2 | 1.27.3 |
| Supercronic | v0.2.49 | v0.2.50 |
| cosign | v3.1.3 | v3.1.4 |

The [AKM release](https://github.com/itlackey/akm/releases/tag/v0.10.261008-beta)
and [plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261007-beta)
were published October 20. The selected plugin requires AKM CLI
`0.10.261008-beta`; npm's AKM CLI `latest` still selects 0.9.32. Plugin `latest`
also lags its published `next` release. All three selected plugin manifests agree.
The immutable native marketplace commit is
`8ff402c74d8c1e76e21de9dff718ac3eb279ba92`, with archive SHA-256
`7bcebfbd6ab9cfebaa4e5a4c6c4b25ef1eb0b106b4c0b14aab1492e56f2ec090`.
The Dockerfile URL, checksum and extraction prefixes change together.

OpenCode 2.1.2 is the current published `@opencode/cli`, `@opencode/client` and
`@opencode/plugin` release. Its source tag resolves to
`a517687fde98a7329ada3ae644a01a9fc6c4e99e`; the repository's ordinary GitHub release
listing still presents the separate 1.x line. Review the
[version comparison](https://github.com/anomalyco/opencode/compare/v2.0.29...v2.1.2)
and published SDK types rather than substituting a 1.x update. Native provider,
permissions, scheduler, recovery and AKM harness tests qualify the selected 2.x
combination; type checks alone do not establish runtime compatibility.

## Current pins and explicit holds

Effect remains **4.0.1**, which OpenCode 2.1.2's SDK requires exactly; standalone
Effect is 4.0.5. AKM still declares older OpenCode 2.0.26 / Effect rc.112 peers.
Those upstream-owned nested packages are not patched or overridden to hide a
compatibility failure. Actual native harness recall remains a required gate.

Electron stays on the maintained **44** security branch, whose current patch is
44.9.3. Electron 45.0.0 is available as a new major; adopting that major is deferred
to its own compatibility review rather than included implicitly in recovery and
authorization fixes. electron-builder uses maintained v26 at 26.18.0; its `latest`
tag still points to 26.15.3, while v27 is a preview. These are explicit channel
choices, not claims that every selected package equals its global `latest` tag.

Node 24.22.0 LTS, npm 12.2.0, Bun/types 1.4.3, Playwright 1.64.1, Azure Identity
4.14.0, Azure Storage Blob 12.34.0, MCP SDKs 2.3.1, TypeScript 7.0.2, Biome 2.5.15,
Slack/Discord SDKs, tar/JSONC/Zod/accessibility tooling and security overrides remain
current on their selected supported channels. Ubuntu stays on the supported
24.04 browser target. All pinned GitHub Actions remain current; Trivy remains
0.76.0. The documentation renderer/template remain 0.11.16/0.5.0.

## Verification

Official npm metadata for every workspace dependency and override, upstream
release/tag metadata, the native archive's manifests and checksum, supported
Node/Go release indexes, and all workflow action releases were checked October 21.
`bun update --recursive --no-cache` refreshes compatible transitive resolutions in
the one root lockfile. `bun outdated --recursive` reports only the two intentional
Effect/Electron holds above. Frozen installation and all six TypeScript checks
pass; the reviewed dependency audit passes with the two existing exclusions.
No advisory exception is added or expanded.

The final combined issue-fix commit must pass the source, artifact and native
amd64/arm64 image gates after integration. PRs record that exact CI result and
remaining live-account qualification separately. Development image tags use `ci`
metadata; no published version, image or release is overwritten by this refresh.
