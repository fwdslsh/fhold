# AKM and Admin beta refresh

Reviewed October 27, 2026 for a full release containing Admin PR #72 and all
three container images. AKM is the deliberate update scope. All workspace
dependencies and image/runtime/CI pins were reviewed against the previous full
release's inventory; unrelated compatibility decisions are deferred.

| Component | Previous | Selected |
| --- | --- | --- |
| AKM CLI (`next`) | 0.10.261015-beta | 0.10.261016-beta |
| All three AKM plugins | 0.10.261013-beta | 0.10.261014-beta |
| OpenCode CLI/client/plugin SDK | 2.1.4 | 2.1.4 (plugin's exact peer) |
| Effect | 4.0.1 | 4.0.1 (plugin's exact peer) |

[AKM's release](https://github.com/itlackey/akm/releases/tag/v0.10.261016-beta)
adopts supported Zod 4 and improves native cache acquisition and health checks.
The installed CLI resolves Zod 4.6.7; its scoped image exception is removed.
MCPB's independent Zod 3 source-audit exception remains. MSAL, npm's bundled
Undici and Debian Brotli retain their existing exact, owner-approved exceptions
and November 6 review/expiry; raw source and image reports remain mandatory.

[Plugin release014](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261014-beta)
requires CLI016. The OpenCode package pins that version exactly. Both native
marketplaces use commit `01052177a4fa78662015a76cef1807e3ce98d2d1`, archive SHA256
`acb84dccf756820b5735b3174234f3aaa6640fff42abc3539f582f126f2f38b3`.
The native manifest is version014; no vendor patch or dependency override is used.

The recursive workspace review found newer OpenCode 2.2.0, Effect 4.0.6,
Claude Code 2.1.311, Biome 2.6.3 and Electron 45. OpenCode/Effect stay at the
new plugin's exact peer pair. The other noncritical updates remain a separate
batch. Codex 0.164.0, Playwright 1.64.1, Bun 1.4.4, npm 12.2.1, Azure Identity
4.14.0, updater 6.8.11 and docs renderer 0.11.16 remain their selected channels'
current releases. Native platform packaging and Linux ARM64 GUI qualification
limitations remain documented in the release runbook.

Official release inventories also confirm Node 24.22.1 on the selected LTS line,
Go 1.27.3, Supercronic 0.2.51, Trivy 0.76.1 and cosign 3.1.4. CI action versions,
the docs template and other image bases retain the reviewed beta008 pins; this
update does not refresh unrelated transitive resolutions. The lockfile diff is
limited to the AKM pair, removal of AKM's nested Zod 3, and release metadata.

Admin's Open OpenCode action uses native authenticated POST /api/pair and a
single-use browser link. It retains the existing credentials and SSH route
ownership without exposing the server password or temporary link to renderer
state. Publishing this release does not upgrade running instances.

Final source, native image and publication evidence is recorded in the release
PR and its canonical main CI run. Source tests alone do not qualify images.

Local Linux amd64 checks passed: 1,063 source tests (7 opt-in cases skipped),
type checks, lint, CLI/Admin builds, docs checks/tests, and the stamped CLI's
fresh install and beta008 upgrade preserving 24 operator files and ownership
settings. Real Chromium native browser sign-in and 306 renderer assertions pass.
The built image's native smoke exercises all three harnesses and five AKM tools.
Its unfiltered Trivy 0.76.1 high/critical scan reports only the existing MSAL and
npm Undici findings, with no Zod finding or criticals. Hosted native gates and
public artifact verification are still required; local evidence is not ARM64
execution or live-account qualification.
