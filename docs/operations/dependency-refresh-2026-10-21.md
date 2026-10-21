# Dependency review for the October 21 issue fixes

Review the owning manifests, every workspace and override, native marketplace
archive, runtime/compiler images, CI tools and documentation dependencies before
merging the work for issues #42, #38 and #39. This is a development refresh, not a
new release or a claim that published beta.12 contains these versions.

## Selected updates

| Component | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.261005-beta | 0.10.261009-beta (`next`) |
| All three AKM harness plugins | 0.10.261004-beta | 0.10.261008-beta (`next`) |
| OpenCode CLI, client and plugin SDK | 2.0.29 | 2.0.32 (compatible 2.0 branch) |
| Codex | 0.162.1 | 0.163.0 (`latest`) |
| Claude Code | 2.1.300 | 2.1.306 (`latest`) |
| JOSE | 6.2.12 | 6.2.13 |
| Electron | 44.7.2 | 44.9.3 (maintained 44 branch) |
| electron-builder | 26.17.0 | 26.18.0 (`v26`) |
| Go compiler | 1.27.2 | 1.27.3 |
| Supercronic | v0.2.49 | v0.2.50 |
| cosign | v3.1.3 | v3.1.4 |

The [AKM release](https://github.com/itlackey/akm/releases/tag/v0.10.261009-beta)
and [plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261008-beta)
were published October 21 at 06:35 and 06:44 UTC, during the initial qualification.
The dependency review was repeated to include both before merge. The selected plugin requires AKM CLI
`0.10.261009-beta`; npm's AKM CLI `latest` still selects 0.9.32. Plugin `latest`
also lags its published `next` release. All three selected plugin manifests agree.
The immutable native marketplace commit is
`880677362943f13a8f83cf0f07cbf0ed13631250`, with archive SHA-256
`3522fa33b331f156821b87108bf924429bc4de42833228cbfc6aa13242e952d7`.
The Dockerfile URL, checksum and extraction prefixes change together.

The new plugin archive changes manifests and version requirements, with no native
hook code changes. CLI 0.10.261009 adds current-belief recall filtering, retains
proposal evidence/scopes and uses complete claims for consolidation checks. It
requires no state migration; this refresh does not reindex user libraries or
change pending proposal decisions. Upstream's release notes call for review of
older pending/staged retirements before unattended proposal draining.

OpenCode's ordinary GitHub release listing still presents the separate 1.x line.
The selected published `@opencode` packages advance together to the latest 2.0
patch, 2.0.32. Review the
[version comparison](https://github.com/anomalyco/opencode/compare/v2.0.29...v2.0.32)
and published SDK types rather than substituting a 1.x update. Native provider,
permissions, scheduler, recovery and AKM harness tests qualify the selected 2.x
combination; type checks alone do not establish runtime compatibility.

## Current pins and explicit holds

OpenCode **2.1.2** is available on npm's `latest` channel but is held for a verified
history-import compatibility boundary. Its
[minor breaking change](https://github.com/anomalyco/opencode/commit/acdcdb8dd9)
moves compaction continuation state into `metadata.recent` or `metadata.keepID`.
The existing fhold history importer deliberately discards arbitrary message
metadata to remove runtime authority; adopting 2.1 without a reviewed, narrowly
validated preservation policy can drop that continuation context. This is a
source-derived compatibility finding, not a claim that a live user's history was
lost. The exact 2.0.32 schema and v1 migration retain top-level `recent`, which
the existing importer preserves. Keep the latest compatible 2.0 patch for these
fixes; qualify the 2.1 import boundary separately rather than patching vendor code
or silently weakening authority filtering.

Effect remains **4.0.1**, which OpenCode 2.0.32's SDK requires exactly; standalone
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
the one root lockfile, including markdown-it 14.3.3, which fixes the new high/low
advisories reported against 14.3.2 in the initial issue PR's CI.
`bun outdated --recursive` must report only the intentional OpenCode, Effect and
Electron holds above. Frozen installation, all six TypeScript checks and the
reviewed dependency audit are required on this final set, retaining only the two
existing exclusions. No advisory exception is added or expanded.

The final combined issue-fix commit must pass the source, artifact and native
amd64/arm64 image gates after integration. PRs record that exact CI result and
remaining live-account qualification separately. Development image tags use `ci`
metadata; no published version, image or release is overwritten by this refresh.
