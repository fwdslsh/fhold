# October 29 dependency refresh

This batch updates the reproducible source manifests, native marketplace archive,
container runtimes and single Bun lockfile. It does not update an existing
installation or publish a release. Official npm metadata and upstream releases
were checked on October 29, 2026 before selecting these versions.

| Component | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.261016-beta | 0.10.261019 stable |
| AKM OpenCode, Claude and Codex plugins | 0.10.261014-beta | 0.10.261017 stable |
| OpenCode CLI/client/plugin SDK | 2.1.4 | 2.2.1 |
| Codex | 0.164.0 | 0.165.0 |
| Claude Code | 2.1.309 | 2.1.312 |
| Assistant/Portal Node | 24.22.1 | 26.13.0 LTS |
| Electron | 44.9.3 | 45.1.0 |
| jose | 6.2.13 | 6.2.14 |
| Biome | 2.6.2 | 2.6.4 |
| Node types | 26.6.5 | 26.6.6 |
| Unify / docs template | 0.11.16 / 0.5.0 | 0.11.17 / 0.5.1 |

## Provenance and compatibility

- [AKM stable](https://github.com/itlackey/akm/releases/tag/v0.10.261019)
  includes incremental embedding refresh improvements and a newer private
  OpenCode runtime. The [matching plugins](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261017)
  require exactly CLI 0.10.261019. Both native manifests report 0.10.261017.
  Marketplace commit: `4793b763cb309a145987050cf1b2c1c037f04205`;
  archive SHA256: `b26462cb0a0f172ab05de3a1f69e7707fec98f01199ed1e597eafe9a20ec3786`.
  Installation and acquisition remain upstream-native and image-baked.
- OpenCode [2.2.0](https://github.com/anomalyco/opencode/releases/tag/v2.2.0)
  and [2.2.1](https://github.com/anomalyco/opencode/releases/tag/v2.2.1)
  change the direct AI provider API and TUI plugin peers. fhold does not import
  the removed AI entry points or implement a TUI plugin. Both selected SDKs
  require Effect 4.0.1, so Effect 4.1.0 is deliberately not selected. AKM still
  declares the 2.1.4 SDK peer; real native recall and all five AKM tools must pass
  with the resolved 2.2.1 runtime, without overrides or vendor patches.
- [Codex 0.165.0](https://github.com/openai/codex/releases/tag/rust-v0.165.0)
  fixes marketplace URL validation and cancellation behavior. Native sandbox,
  approval and hook-consent boundaries remain unchanged.
- [Claude 2.1.312](https://github.com/anthropics/claude-code/releases/tag/v2.1.312)
  includes resumed-message preservation and hook scheduling fixes. Tests use
  the installed native plugin registration and normal runtime entrypoints.
- [Node 26.13.0](https://nodejs.org/en/blog/release/v26.13.0) is the Lithium LTS
  release. Assistant and Portal use its exact image tags. The Assistant installs
  Node's required `libatomic1` through normal APT in its build and runtime stages.
  npm remains 12.2.1,
  whose declared Node range includes 26; its private bundle is not patched.
- [Electron 45](https://www.electronjs.org/docs/latest/breaking-changes#breaking-api-changes-450)
  removes Node polyfills from sandboxed preloads. fhold's preload imports only
  Electron and bundled application constants; it uses none of those removed
  shims. Packaged renderer/bridge startup remains a required check with sandboxing
  enabled. Native ARM64 desktop execution is not implied by a cross-build.
- [Unify 0.11.17](https://github.com/fwdslsh/unify/releases/tag/v0.11.17)
  and template 0.5.1 retain native template resolution and strict documentation
  checks. No fetched template files are committed.

## Retained pins and accepted advisories

Official metadata still selects Bun 1.4.4, Go 1.27.3, Supercronic 0.2.51,
Playwright 1.64.1, TypeScript 7.0.2, Azure Identity 4.14.0, Blob 12.34.0,
MCP 2.4.0, Slack Bolt 5.1.0, discord.js 14.27.0, Electron Builder 26.18.0
and Trivy 0.76.1. All pinned GitHub Actions remain current. Security overrides
remain exact. Compatible transitive resolutions are refreshed through
`bun update --recursive --no-cache`, then checked by frozen installation.

The existing owner-approved MSAL, MCPB Zod and npm-bundled Undici exceptions
remain in their existing scopes and expiry. No exception is added or widened.
Raw audit/scan findings stay visible. Available upstream fixes are adopted;
unresolved approved upstream findings do not block an otherwise verified merge.

## Verification record

The PR records results for the final dependency set: source checks and tests,
CLI/Admin/extension/docs builds, all Compose profiles, native image security,
scheduler/provider/AKM/keepalive, history and recovery checks, and native CI on
amd64 and ARM64. Source and image identities distinguish this batch from earlier
signed-in qualification. A newer noncritical release during testing does not
restart this completed selection; actual changed inputs receive affected checks.
