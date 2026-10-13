# Dependency refresh verification — October 13, 2026

This source refresh starts from canonical main
`fdc868f6e70192504c1d7612ec34dab7d2e18cf5`. Versions were checked against
official npm distribution tags and upstream GitHub releases on October 13.
Development images use unique local tags and `ci` metadata; this report does
not bind them to a new published release identity.

## Selected versions

| Component | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.26101002-alpha | 0.10.261004-beta (`next`) |
| AKM harness plugins | 0.10 alpha pins | 0.10.261003-beta |
| OpenCode CLI/client/plugin SDK | 2.0.26 | 2.0.28 |
| Codex | 0.160.0 | 0.162.1 |
| Claude Code | 2.1.289 | 2.1.296 |
| Bun and workspace types | 1.4.2 | 1.4.3 |
| Go scheduler compiler | 1.26.9 | 1.27.2 |
| MCP client/server SDKs | 2.3.0 | 2.3.1 |
| Electron | 44.5.1 | 44.7.1 |
| electron-builder | ^26.15.3 | ^26.17.0 (maintained `v26` tag) |
| axe-core | 4.13.0 | 4.14.0 |
| @types/node | ^26.6.4 | ^26.6.5 |
| Transformers override | 4.3.0 | 4.3.1 |
| Guardian Zod | 4.6.5 | 4.6.7 |
| Unify / docs template | 0.11.13 / 0.4.0 | 0.11.16 / 0.5.0 |
| Artifact upload/download actions | v7.0.1 / v8.0.1 | v7.0.2 / v8.0.2 |
| Playwright / matching Chromium | absent | 1.64.0 / upstream bundled browser |

The follow-up Assistant image also installs ripgrep, jq, Python/pip/venv,
SQLite, zip/unzip, Poppler PDF tools, file, less and process utilities through
Ubuntu packages. Playwright installs its browser and system libraries at build
time into an immutable shared cache. It requires no runtime installation, root
user or additional container capabilities. The initial image IDs and advisory
counts below describe the original toolchain refresh; final browser-image
qualification is recorded in the new candidate's CI and release runs.

The Assistant runtime uses supported Ubuntu 24.04 LTS, retaining the same pinned
Bun and Node binaries. Debian 13's required browser graphics stack pulled in
libxml2 with CVE-2026-6653 and failed the unchanged critical gate. Ubuntu provides
the vendor fix in 2.9.14+dfsg-1.3ubuntu3.8 and later; see the
[Ubuntu advisory](https://ubuntu.com/security/CVE-2026-6653). No new scan exception
or vendor patch was added. Guardian and Portal retain their existing base images.

The local Ubuntu browser image passes real offline JavaScript, theme/mobile,
hover, screenshot, PDF and Python-venv checks under non-root, cap-drop-all and
no-new-privileges. Its raw Trivy scan reports zero critical and four high
findings; the unchanged critical and fixable-high gates pass with only the
existing npm exceptions. The release workflow also validates recent canonical
CI for the exact SHA/scope and imports native build caches. Artifact and
publication verification remain mandatory.

Node 24.21.0 is the newest patch of the existing LTS line; npm 12.2.0 and
Supercronic v0.2.49 remain their current releases. Azure SDKs, TypeScript,
Biome, Discord/Slack libraries, MCPB, tar/JSONC/JOSE, existing security overrides
and remaining CI/scan tools were also checked and retain their selected supported
releases. fhold's Effect pin advances to 4.0.1, matching OpenCode 2.0.28's SDK,
rather than independently selecting Effect's newer 4.0.4.

The [AKM CLI release](https://github.com/itlackey/akm/releases/tag/v0.10.261004-beta)
and [plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261003-beta)
were published October 13 despite their smaller numeric patch strings.
AKM's stable `latest` remains 0.9.32; the OpenCode 2 plugin requires the selected
0.10 beta CLI exactly. Both fhold manifests now select one OpenCode AKM plugin
release. Claude/Codex use that same release from commit
`14351e74c717aa4df781108a32a2be3787b12ba8`, archive SHA-256
`0e0e68095ea9139ec02a7cdfd5aef279fa824376fb8eb85bb979eef89a6861be`.

The upstream AKM plugin still declares OpenCode 2.0.26 / Effect rc.112 peers.
Its older SDKs remain upstream-owned nested dependencies. No peer override or
vendor patch was added. Real recall, all five AKM tools, native task execution
and managed permission checks passed in the newly built OpenCode 2.0.28 image.
Recheck this boundary on the next upgrade.

## Local Linux x64 evidence

Host checks used isolated Bun 1.4.3 and native Node 24.18.0. Images verify Bun
1.4.3, Node 24.21.0 and each exact installed tool pin. All fixtures used
disposable homes, synthetic accounts and controlled local provider responses.

- Frozen install, all six type checks, lint and shell syntax: passed.
- Source suites: 831 tests passed initially; the sole failed action-inventory
  assertion was updated to the verified patch releases and its suite reran
  successfully (41/41). Five opt-in image cases were skipped in that source run
  and subsequently passed separately: provider settings 1/1, native history 4/4.
- Standalone CLI build, Admin bundle and unsigned MCPB pack: passed.
- All-profile Compose validation from a fresh compiled-CLI install: passed.
- Strict docs check/build and docs tests 2/2: passed, including the new contributor
  guide through the native Unify 0.5 template.
- Real Chromium Admin account controls: 1/1 passed; updated Electron x64 AppImage
  packaging and fresh packaged renderer/native-bridge startup: passed.
- Assistant, Guardian and Portal image builds/startup/security smokes: passed.
- All three native AKM harnesses: actual recall passed; OpenCode completed all
  five real AKM tools. Managed hooks ran without personal approval records.
- Managed permissions, workspace environment boundaries, and restricted native
  provider/task behavior: passed.
- Real Supercronic conditional heartbeat: two active requests, zero idle requests;
  unsigned remote workers permitted idle and user schedules remained disabled.
- Native history preservation/retry, v1-to-v2 migration, explicit interrupted
  history archival and runtime-root selection: 4/4 passed.
- Directory recovery, mount boundaries and independent final checkpoint: passed.
  Upgrade from published runtime 0.2.2610112-beta.8 passed with both empty storage
  and a surviving receipted home; native AKM recall passed after each restore.

Local image identities:

| Image | Local tag suffix | Image ID |
| --- | --- | --- |
| Assistant | toolchain-refresh-20261013 | sha256:1b2ca755a407038b63324bce86744ba30d6d0d67b36877952f4aa3e0627b8f34 |
| Guardian | toolchain-refresh-20261013 | sha256:b13c6b525f3a812b10064befb81c843ca183b7082d807fd7d1cf537a093bd0ad |
| Portal | toolchain-refresh-20261013 | sha256:a75fc23713f5868837b717b7531d7dbfaf394bbfb8f546d3ccf5dbe87b7fea98 |

## Advisory and release limits

Raw Bun audit reports the two existing reviewed developer/proxy-logger
advisories; the scoped audit passes with exactly those two exclusions.
Trivy 0.75.0's raw high/critical scans report 67 high findings in Assistant and
51 each in Guardian/Portal, with zero critical findings. Most are unfixed
distribution packages. The only fixable high findings are the three previously
approved npm-bundle findings documented in [the release runbook](release.md).
The latest supported npm bundle also retains an unfixed HTTP-cache finding.
All images pass the unchanged critical and fixable-high gates using the existing
exact-path/version npm exceptions. No exceptions were added, extended or widened;
these are not clean-scan claims.

These local results qualify native Linux x64 and controlled transports.
Native ARM64, complete Admin journeys and real vendor/provider entitlement
remain separate gates; this report does not claim those passed. CI must run on
the final committed revision. Publishing requires a new full release identity
and its normal artifact/signing/architecture gates. Follow
[the contributor guide](updating-dependencies-and-releasing.md).
