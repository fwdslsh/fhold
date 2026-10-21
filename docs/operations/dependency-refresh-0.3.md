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
