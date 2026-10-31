# AKM CLI022 and plugin020 refresh

Reviewed October 30, 2026 (America/Chicago), starting from main
`6572f36`. The owner subsequently authorized the first stable release, **0.4.1001**,
on October 31 UTC. One final stamped release candidate supplies the PR and
publication artifacts.

| Dependency | Previous | Selected stable |
| --- | --- | --- |
| AKM CLI | 0.10.261021 | 0.10.261022 |
| OpenCode, Claude and Codex AKM plugins | 0.10.261019 | 0.10.261020 |

These are npm's `latest` versions at review. The older `next` prereleases are
not selected. The [CLI release](https://github.com/itlackey/akm/releases/tag/v0.10.261022)
preserves reserved-name skill-directory intent, fixes declared command types
when indexing placeholder documentation, and improves native UI review context
and operational charts. The [plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261020)
requires exactly CLI022.

Both native marketplace manifests report plugin020. The immutable source is
`cb5aa3f66356dc17928d1ff5e573a4d275741fb3`; the downloaded archive SHA256 is
`7e0b147d5540c1f0fa10c5384372b5a07741327b29122a9f8f7ec971a6d6f281`.
All extraction paths and the checksum are updated together. npm integrity
records remain generated in the single root `bun.lock`.

The selected plugin retains its existing OpenCode SDK2.1.4 and Effect4.0.1
peer declarations. Main already ships OpenCode2.2.1 with Effect4.0.1; this update
retains that combination and verifies the real native harnesses. No override,
vendor edit or alternate integration is added. Unrelated image tools, bases,
workspace packages and existing advisory exceptions are unchanged.

## Stable release inventory review — October 31 UTC

Rechecked every workspace/override with `bun outdated --recursive` and the
selected native marketplace release. The AKM CLI022/plugin020 pair remains
the current stable pair. Native archive provenance and compatibility evidence
above are unchanged. Bun 1.4.4, Node 26.13.0 LTS, npm 12.2.1, Go 1.27.3,
Supercronic 0.2.51, Trivy 0.76.1, Playwright 1.64.1 and Azure Identity 4.14.1
remain current supported selections. Node 27 alpha is not selected. CI actions
and docs inputs retain the preceding full inventory review's pins.

The following separate noncritical upgrade batch remains deferred; these pins
are intentionally held and are **not** described as latest:

| Dependency | Selected | Available at review |
| --- | --- | --- |
| OpenCode CLI/client/plugin | 2.2.1 | 2.2.5 |
| Claude Code | 2.1.312 | 2.1.316 |
| Codex | 0.165.0 | 0.166.0 |
| Electron | 45.1.0 | 45.2.1 |
| discord.js | 14.27.0 | 14.28.0 |
| Effect | 4.0.1 | 4.1.1; held for the selected SDK's peer contract |

The owner-approved exact glob/minimatch audit exceptions join the existing
MCPB Zod exception. Existing npm-bundled Undici image exceptions keep their exact
package/path scopes and November 6 expiry. Raw reports remain unfiltered; the
required reviewed audit and image security gates still run on the final SHA.
No security override or vendor-tree edit is added for these findings.

Validation results and final hosted native checks are recorded in the release PR.
Use private disposable fixtures on the workspace disk for local testing rather
than the nearly full machine-wide `/tmp`. No live instance is changed.
