# Dependency review — October 15, 2026

Review all tracked workspace dependencies/overrides, transitive resolutions,
container tools and bases, native AKM marketplace archives, workflow actions,
scanner/signing tools and the documentation renderer/template before merging
[PR #41](https://github.com/fwdslsh/fhold/pull/41).
The refreshed full candidate is `0.2.2610154-beta.12`; it supersedes the earlier
unpublished builds 2 and 3. Their CI does not qualify changed inputs.

## Updated pins

| Component | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.261004-beta | 0.10.261005-beta (`next`) |
| OpenCode/Claude/Codex AKM plugins | 0.10.261003-beta | 0.10.261004-beta |
| OpenCode CLI/client/plugin SDK | 2.0.28 | 2.0.29 |
| Claude Code | 2.1.296 | 2.1.300 (`latest`) |
| Node LTS | 24.21.0 | 24.22.0 |
| Azure Identity | 4.13.3 | 4.14.0 |
| Playwright and matching browser | 1.64.0 | 1.64.1 |
| Electron | 44.7.1 | 44.7.2 |
| Trivy | 0.75.0 | 0.76.0 |

The [AKM release](https://github.com/itlackey/akm/releases/tag/v0.10.261005-beta)
and [plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261004-beta)
were published October 14. The OpenCode 2 plugin's published dependency selects
AKM CLI `0.10.261005-beta`; `akm-cli@latest` still points to the incompatible 0.9
line. Claude and Codex manifest versions agree with the selected OpenCode plugin.
Their immutable marketplace commit is
`3461257250277f25f2a17c1701aa6ed468541851`, archive SHA-256
`b448332d9c237aa36d89d3cef03c13f60a1649a81cd29ab511601d0e0b251193`.
The source URL, checksum and all extraction prefixes advance together.

`bun update --recursive --no-cache` refreshes the root lockfile within the reviewed
manifest constraints, including AWS credential providers, Azure MSAL and Electron
build dependencies. No integrity records or vendor dependencies are hand-edited.

## Current releases and compatibility holds

Codex 0.162.1, Bun/types 1.4.3, Go 1.27.2, npm 12.2.0, Supercronic v0.2.49,
MCP SDKs 2.3.1, Azure Storage Blob 12.34.0, TypeScript 7.0.2, Biome 2.5.15,
Slack/Discord SDKs, accessibility tooling, tar/JSONC/JOSE/Zod, root security
overrides, all pinned GitHub Actions and cosign remain current on their selected
supported channels. The docs renderer/template remain 0.11.16/0.5.0.

Effect remains **4.0.1**, the exact dependency/peer version of OpenCode 2.0.29's
SDK, while Effect's standalone latest is 4.0.5. AKM's plugin still declares older
OpenCode 2.0.26 / Effect rc.112 peers; those are upstream-owned nested packages.
Keep the native-harness qualification and do not conceal this boundary with a
peer override or vendor patch. electron-builder remains **26.17.0**, the maintained
`v26` release, ahead of its lagging `latest` tag (26.15.3); 27 is still a preview.
Ordinary tools use supported stable releases rather than canary/alpha/beta tags.
Node stays on the supported 24 LTS line; Ubuntu stays on supported 24.04 LTS,
which is the shipped Playwright/browser compatibility target.

## Qualification and merge practice

The dependency audit passes with the two existing reviewed exclusions. Image
critical/fixable-high gates retain the same policy and exact npm exceptions;
no exception is added or widened. The final candidate must pass source checks,
builds and native amd64/arm64 image/harness/recovery gates after these changes.
CI results are recorded on the PR; do not reuse an earlier build's result.

Build 3's native CI exposed OpenCode 2.0.29's promotion of `experimental.policies`
to top-level `policies`: the engine correctly applied provider disable rules, but
fhold checked the former normalized response field and refused confirmation.
This reproduced on both architectures and locally. Build 4 updates the owning
provider-settings reader, uses the current native field for new preferences, and
preserves the supported legacy form in existing files. Regressions cover both
input formats and retention of unrelated denial rules and credentials. The full
native provider test now passes live edits, restart preservation, disable/re-enable,
Guardian interactions and scheduled execution. No vendor package or policy is patched.

Local Linux x64 checks passed on the refreshed dependency set:

- Frozen install, six package type checks, lint and shell syntax.
- Full source suite: 855 passed, zero failed. Five opt-in provider/history cases
  are skipped in this source invocation and must run against CI's native images.
- CLI build, Admin bundle, unsigned MCPB pack, docs tests (2/2), strict docs check
  and docs build. A fresh compiled-CLI installation validates all Compose profiles.
- All three container builds/startup smokes and Trivy 0.76.0 critical/fixable-high
  gates, retaining only the existing exact npm exceptions.
- Actual installed AKM/plugin versions and native recall in OpenCode, Claude and
  Codex; Codex initial coverage/replacement; non-root offline browser screenshot,
  PDF, mobile/theme/hover and Python checks; native optional-failure isolation.
- Real Supercronic conditional keepalive: active requests continue during native
  work, idle requests stop and user scheduling remains disabled.
- Electron 44.7.2 x64 AppImage packaging and actual packaged renderer/native-bridge
  startup with a disposable home.
- Native OpenCode 2.0.29 provider/Guardian/scheduler integration: 1/1 passed after
  the normalized-policy update, using the existing disposable integration test.

Local image tags are `fhold/{assistant,guardian,portal}:beta12-deps-dev`, with
`ci`/`development` metadata, not public release identities. Final native amd64/arm64
CI must pass on the frozen candidate SHA. Live vendor-client/Slack/Discord account
qualification and native ARM64 Admin startup remain separate disclosed limits;
this refresh does not claim publication, a fleet update or new live-account tests.

Dependency review is now required by `AGENTS.md`, the contributor guide and the
PR template. Check every workspace, the native marketplace archive and external
tool pins against current upstream releases, record intentional compatibility
holds, refresh transitive resolutions, and qualify the final SHA before merge.
Containers continue installing exact reviewed dependencies at image build time;
no startup update or floating runtime dependency is introduced.
