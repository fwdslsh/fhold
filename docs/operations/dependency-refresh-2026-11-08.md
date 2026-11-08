# AKM dependency refresh — November 8, 2026

## Follow-up for 0.4.1102-beta

The patched CLI **0.10.261113-beta** and plugins **0.10.261112-beta** are now
published on npm. The OpenCode plugin pins that CLI exactly; native Claude/Codex
hooks accept it under their existing minimum-version rule. The immutable native
marketplace is `52ebbec608fb33fb4fe19814db0ece5baa2674f2`, archive SHA256
`9e01dc88d80805d36f3584f27ac54dd366e8091e981f85ab5fcb43fca7806ea9`.
Both native manifests report 0.10.261112-beta. The SDK/Effect peer declarations
are unchanged, so the same native harness qualification remains required.

The published CLI contains AKM PR #1510's hard-link-free locking and orphaned
usage-event deletion fixes. It also includes native sync fixes, removes curate
reranking and read-time index rebuilding, and retains the build-time runtime
acquisition API. No fhold consumer of those removed internals was found.
The lockfile update changes only the selected AKM packages and workspace pins.
The raw audit still reports the same three approved source findings; the reviewed
audit passes. No exception is added or widened. The full review and unrelated
holds recorded below remain applicable; this follow-up is the awaited AKM patch.
See the [candidate plan](patched-akm-beta-plan.md) for qualification and release.

## Earlier 0.4.1101-beta review

Start from canonical main `907ceb9` (tooling 0.4.1002, runtime 0.4.1001).
The owner subsequently authorized full beta **0.4.1101-beta**. Stamp once before
final candidate qualification and promote its retained artifacts after merge.
No running installation, native consent or recovery setting is changed.

| Dependency | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.261022 stable | 0.10.261112-beta, npm `next` |
| OpenCode, Claude and Codex AKM plugins | 0.10.261020 stable | 0.10.261111-beta, npm `next` / matching native marketplace |
| npm | 12.2.1 | 12.2.2 stable |
| Trivy scanner | 0.76.1 | 0.76.2 security patch |

The owner previously authorized AKM betas as needed. `latest` still names the old
stable AKM pair; the selected releases are the newest published prereleases at
review. The [plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261111-beta)
requires exactly the selected [CLI release](https://github.com/itlackey/akm/releases/tag/v0.10.261112-beta).
The OpenCode plugin keeps its SDK2.1.4 / Effect4.0.1 peer declarations. fhold keeps
OpenCode2.2.1 and Effect4.0.1 and requires its real native harness checks; no
override or vendor change is introduced. Other tools/bases and unrelated package
updates are deferred to a separate dependency batch.

The full release review also covered all workspace/override resolutions,
image/compiler bases, workflow tools and docs inputs. Bun1.4.4, Node26.13.0 LTS,
Go1.27.3, Supercronic0.2.51 and docs Unify0.11.17 remain current selections.
Node27 alpha is not selected. Trivy0.76.2 fixes vulnerabilities in the scanner's
own dependencies, so all raw/reviewed scan stages move together to that patch.
Other CI action/publisher pins stay at the reviewed main versions.

Available updates deferred from this focused beta are Claude2.1.319,
Codex0.167.0, OpenCode2.2.6, Playwright1.65.0, discord.js14.28.1,
Electron45.2.3, Biome2.6.6 and Effect4.1.2. Effect stays at the selected SDK's
4.0.1 peer contract. JOSE6.2.15 fixes JWE decompression and negative option
validation; Guardian uses signed JWT verification with fixed native options,
not JWE decryption, and retains6.2.14 for this batch. These held selections are
not described as latest; compatible follow-up upgrades remain separate work.

Claude/Codex marketplace commit:
`2f81278c7e9acb7a83c4d50f733f19a2d0a2e587`.
Archive SHA256:
`e55933c47a7ee842ffbebbd9cc6861c462d8f2a79a87463b3370360cd91c1a07`.
Both native plugin manifests report 0.10.261111-beta. The URL, checksum and every
extraction prefix move together. The root lockfile changes only the selected
AKM packages and workspace pins.

## Native integration changes

The plugin now runs AKM in each session's working directory, allowing AKM to own
project selection, and supports AKM's path-based asset refs. The CLI drops the
deprecated `results` alias; fhold has no consumer of that alias. Build-time native
runtime acquisition and local-embedding APIs remain present. Startup continues
using AKM's own backed-up migrator before writers, preserving explicit settings
and native consent.

Upstream removed `akm ui` in favor of its standalone Desktop application. Admin
recognizes the native `UNKNOWN_COMMAND` response and reports that capability as
unavailable without waiting for its startup timeout or exposing private stderr.
It does not start a host-local AKM against a different library, add another API
service, or strip browser security. Existing instances that actually provide the
native UI retain their normal authenticated, session-owned route.

## Security review

Official npm12.2.2 bundles Undici6.29.1. GitHub's advisory records identify that
version as patched for GHSA-xjj6-f33q-929c, GHSA-2m5v-pch6-74hx and
GHSA-qrxm-fqhp-jwvm. Remove the three expired image exceptions rather than extend
them. Native npm/npx checks and unfiltered image scans still run in PR CI.

The raw source audit still reports the same approved independent MCPB Zod and
glob/minimatch findings. MCPB2.1.2 remains the published latest and still requires
Zod3. No source exception is broadened or a new review expiry invented. Keep
issue #63 open for supported parent-chain fixes; the previous November 6 source
review date is overdue and this review records the unchanged findings on
November 8. Final image, native harness and source validation results belong in
the PR; published artifacts require their own final stamped qualification later.
