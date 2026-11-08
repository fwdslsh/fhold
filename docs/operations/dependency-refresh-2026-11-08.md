# AKM dependency refresh — November 8, 2026

Start from canonical main `907ceb9` (tooling 0.4.1002, runtime 0.4.1001).
The owner subsequently authorized full beta **0.4.1101-beta**. Stamp once before
final candidate qualification and promote its retained artifacts after merge.
No running installation, native consent or recovery setting is changed.

| Dependency | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.261022 stable | 0.10.261112-beta, npm `next` |
| OpenCode, Claude and Codex AKM plugins | 0.10.261020 stable | 0.10.261111-beta, npm `next` / matching native marketplace |
| npm | 12.2.1 | 12.2.2 stable |

The owner previously authorized AKM betas as needed. `latest` still names the old
stable AKM pair; the selected releases are the newest published prereleases at
review. The [plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261111-beta)
requires exactly the selected [CLI release](https://github.com/itlackey/akm/releases/tag/v0.10.261112-beta).
The OpenCode plugin keeps its SDK2.1.4 / Effect4.0.1 peer declarations. fhold keeps
OpenCode2.2.1 and Effect4.0.1 and requires its real native harness checks; no
override or vendor change is introduced. Other tools/bases and unrelated package
updates are deferred to a separate dependency batch.

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
