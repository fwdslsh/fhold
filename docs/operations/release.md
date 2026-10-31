# Release runbook

For the contributor walkthrough, see
[update dependencies and make a release](updating-dependencies-and-releasing.md).

GitHub at https://github.com/fwdslsh/fhold is the canonical source and contribution
host. `.github/workflows/release.yml` builds Linux downloads and signed amd64/arm64
images on GitHub, verifies uploaded checksums and publishes the release. Public
Docker Hub repositories are `fwdslsh/fhold-assistant`, `fwdslsh/fhold-guardian`
and `fwdslsh/fhold-portal`. Fresh CLI/Admin installs select the latest published
runtime cohort pinned by their release, even when tooling has a newer version.
No Docker Hub account is needed to pull them.

Publishing uses the repository's Docker Hub credentials and the explicit
`FH_PUBLICATION_CONFIGURED=true` repository variable. Run the workflow from
`main` with the stamped version and `dry_run=false` to publish; the default
dry run builds and validates without publishing. No npm bootstrap package or
cross-host publishing bridge is required. Previous local qualification records
remain historical; each public release must pass its own workflow gates.

The persisted literal `fhold` namespace is local-only: activation uses
`--pull never`, ordinary update defaults to no pull, and explicit update `--pull`
is rejected. Missing tags require reviewed local builds. Explicit nonlocal
registry intent retains its pull behavior; this is not a new configuration flag.

## Candidate and published version contract

Develop and functionally validate candidates using their commit SHA and image
digests. Finish intentional dependency updates early; focused fixes need not
include unrelated upgrades. Reserve and stamp the release version near
publication, then qualify the final stamped SHA and artifacts. Do not repeat
completed qualification merely because a newer noncritical dependency appears.

### Tooling-only publication

Use `SCOPE=tools VERSION=<new-version> STAMP=true bun scripts/bump-release.mjs`
for CLI/Admin changes, then regenerate `bun.lock` with `bun install --lockfile-only`.
Only the root, library, CLI and Admin versions advance. The Skeleton version pins
the last published Assistant/Guardian/Portal cohort; the Claude Desktop package
version pins its last published extension. Fresh installs and updates never refer
to an unpublished image or extension tag.

The release workflow defaults to `scope=auto`: matching tooling/runtime versions
publish the full stack; different versions publish only Linux x64/arm64 CLI and
Admin downloads, standard `latest-linux.yml` / `latest-linux-arm64.yml` update
feeds, checksums and the asset manifest. Tooling releases run library,
CLI, Admin and release-helper checks and native artifact smokes. They do not build,
scan, sign or publish containers, build the unchanged extension, or move Docker
channel tags. Release notes disclose the retained runtime version.

PR CI shares the publication classifier, with a separate affected-check plan.
Changes to runtime sources, Skeleton,
plugins, seed inputs or dependency resolution select full gates; unknown inputs
also select full gates. Tooling workspace version/dependency declarations can
reuse already locked packages without full gates. Tooling-only package additions
and rehoisting also use tooling gates when every non-tooling consumer's resolved
dependency graph (including peer/optional edges and integrity) is unchanged.
Runtime resolution changes, unexplained changed lock records and unknown lock
formats still select full qualification.
As required by repository policy, docs/site and lockfile-only changes skip product
CI. This does not waive publication's runtime diff or final release qualification.
Portal source/Dockerfile changes run full source tests and the two native Portal jobs;
shared inputs and uncertain changes retain all six image jobs. CI orchestration
changes exercise native gates even when published runtime bytes are unchanged.
See the [check selection table](../technical/testing-workflow.md).
Publication compares runtime inputs with the pinned runtime release tag so a
tooling release cannot accidentally omit pending container changes. A full release
still uses the default `SCOPE=full` stamping and the complete existing gates.

For the historical **0.1 release line**, use `X.Y.yyMMddHHmm` in UTC (20yy), optionally
`-alpha`, `-beta` or `-rc` and a positive serial. Real dates/hours/minutes,
canonical integers and numeric precedence are enforced by `scripts/set-version.mjs`.
Unpublished local builds, nonpublishing dry runs and candidate receipts do not
consume a version or monthly counter. They can change under the same provisional
version. Keep evidence by SHA/digest and regenerate local checksums/manifests
after a rebuild; older evidence never qualifies changed content. A local
manifest can be regenerated with `validate-release-assets.mjs --write-manifest`.
CI/development artifact downloads are candidate evidence identified by SHA/digest,
not release publication, and do not reserve a counter.
Read-only validation still rejects stale or mismatched checksums.

A public release Git tag, versioned registry image or release-download asset freezes that version,
even if publication later fails before the GitHub release is visible. Never
overwrite those bytes. An exact-content image retry may reuse its public tag;
changed source or public artifact bytes require a new version. Do not reuse
public partial-publication counters as though they were local dry runs.

Establish final publication intent and carry it across the selected scope's package
manifests, artifacts, filenames, checksums and receipt. Full releases also advance
image and MCPB versions; tooling-only releases retain those published versions.
`releaseIntent` binds version to revision/content hash. Its `existing` input is
an immutable publication identity, not an unpublished candidate receipt; exact
publication retries must match it. Regenerate unpublished candidate intent from
the current revision/hash without treating old local evidence as a reservation.
For historical 0.1 releases, at the same minute use a higher prerelease serial;
stable collisions require another minute. Historical 0.2 releases use the daily
build counter below; current releases use the monthly counter.

`VERSION=<release-version> node scripts/bump-release.mjs` previews stamping;
`STAMP=true` explicitly writes. It must preflight every listed input first.
Regenerate the single root lockfile and rebuild all embedded assets after
manifest changes. No automatic release/schema migration registry is needed.

All three CLI build commands disable Bun's compiled dotenv and bunfig autoload
with `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig`.
Run the actual compiled-binary regression from a directory containing hostile
`.env` and `bunfig.toml` fixtures; source-level tests alone do not prove this
launch boundary. Earlier releases passed those actual-binary checks and artifact gates;
subsequent source changes do not rebind their artifacts to another revision.

The Assistant image also fixes the distinct Bun helper/AKM workspace-preload
boundary with native `BUN_OPTIONS='--no-env-file --config=/dev/null'`. Verify
that hostile `/work/bunfig.toml` preloads do not execute through managed helpers
using the real-image/native-harness smoke. This is an image runtime option,
not a replacement launcher or configuration service.

### Historical 0.2 date and daily build

The **0.2 release line** replaced the hour/minute timestamp with
`X.Y.yyMMdd<build>`: two-digit year, month, day, then an unpadded positive daily
build number. Keep the date in UTC; start the build counter at `1` each day and
increment it for each new release build. Existing immutable-version and
identical-content retry rules still apply.

Examples: `0.2.2610081` is build 1 on October 8, 2026;
`0.2.2612225-beta.1` is build 5 on December 22, 2026, marked beta 1.
Alpha, beta and rc suffixes remain supported, including their optional positive
serials. No existing 0.1 versions, tags or artifacts will be renamed.

The shared release parser, stamping, intent checks and artifact validator support
this format and retain historical 0.1 timestamps. Release comparisons parse date
and build separately: with an unpadded counter,
`26100810` (October 8, build 10) is numerically larger than `2610091`
(October 9, build 1), so ordinary numeric patch ordering is not chronological.
Do not use an ordinary SemVer patch comparison to select the newest daily build.
Changing the minor version from 0.1 to 0.2 on the same UTC date is valid; the
shorter patch is not a clock regression. Publication does not rewrite existing
tags, recovery formats or instance identities.

### Monthly versions from 0.3

For the **0.3 release line**, use `X.Y.YYMMNN[-alpha|-beta|-rc]`, with UTC year/month
and a two-digit monthly counter `NN`. The first October 2026 release is
`0.3.261000-beta`. There is no additional prerelease serial. The patch is a
canonical SemVer integer (no leading zero); this calendar format covers 2010–2099.
Month must be 01–12, and counter must be exactly 00–99.

For each major/minor line, start at `00` each UTC month and increment for every
public release, sharing the counter across alpha, beta, rc and stable. Promoting
`0.3.261000-beta` therefore consumes `0.3.261001-rc` or `0.3.261001`;
do not reuse a public counter for another channel. Abandoned unpublished
candidates do not consume a counter; an abandoned partial public publication
does. Check public tags, releases and versioned images before choosing the next
unused counter. Local candidate receipts do not reserve versions. Gaps are
allowed; public counter reuse is not.
After 99, refuse further candidates in that month: wait for the next UTC month
or explicitly review a new minor line. Never widen/wrap the counter or change
the date to evade overflow. A new month/year resets the counter to 00.

Comparison uses major/minor, UTC month, counter, then channel
`alpha < beta < rc < stable`. Channel ordering remains defined even though new
public release intent requires advancing the counter. Exact publication retries
retain the public version, revision and content identity; changed public bytes
require another counter. Unpublished rebuilds use fresh SHA/digest evidence
without consuming another counter.
Historical 0.1 timestamps and 0.2 daily builds remain readable and immutable.
Cross-format clock checks use shared month precision, so moving from an October
21 daily release to October's monthly line is valid. Moving to a prior month
is refused, including across minor lines.

### Month-counter versions from 0.4

Starting with **0.4**, drop the `YY` year prefix and use
`X.Y.MMNN[-alpha|-beta|-rc]`. Month selection remains UTC. `NN` starts at `01`
each month and runs through `99`, shared by all channels. Examples:
`0.4.1001`, `0.4.1002`, `0.4.1101`, or `0.4.1001-beta`. Promotions consume the
next counter; `0.4.1001-beta` promotes to `0.4.1002-rc` or `0.4.1002`, never a
different channel under the same public counter. No prerelease serial is allowed.

Keep the patch a canonical SemVer integer. For January through September, omit
the leading zero from the complete patch: January counter 01 is **`0.4.101`**,
not `0.4.0101`; September counter 99 is `0.4.999`. The two counter digits stay
present. Counter00, invalid months, `NN=100`, and year-prefixed 0.4 patches are
rejected. Counter gaps are allowed; published counter reuse is not.

Comparison uses major/minor, numeric month/counter, then channel. The year is
not encoded and the parser does not invent one. At December-to-January rollover,
start a new minor line, for example **`0.4.1299` → `0.5.101`**. January on the
same minor line would be a SemVer downgrade and is refused. After counter 99,
wait for the next UTC month or explicitly review a new minor line; never widen
or wrap the counter. A new minor line takes normal SemVer precedence even when
its patch is numerically smaller. This also permits `0.3.261013-beta` to advance
to `0.4.1001-beta` without interpreting the shorter patch as a clock regression.

The first stable release is **0.4.1001**. The 0.3 format and all published
historical versions remain unchanged. Existing
immutable publication identity, unused-counter checks, SHA/digest development
candidates and rebuild/retry rules apply unchanged to the new format.

All stamping, release workflow and artifact validation use the shared parser.
CLI/Admin derive their own, runtime and MCPB versions from the owning manifests;
updates advance only previously managed image defaults, preserving explicit pins.
Download names, native plugin manifests, Compose defaults and release asset
receipts retain the exact release string. No native database, recovery schema,
credentials, instance identity or checkpoint authority changes with this naming
transition.

## Linux acceptance

Run [the test gates](../technical/testing-workflow.md), CLI/Admin builds and
[rendered/packaged Admin verification](admin-setup-verification.md), all-profile
Compose, Guardian security, own-backup/history preservation and real-image tests.
Build Assistant/Guardian/Portal from locked dependencies for Linux amd64/arm64,
smoke/scans on native architecture, validate non-root/capability/mount boundaries,
and run real AKM checks in all three harnesses.

Required distribution is Linux x64/arm64 CLI and AppImage Admin, both architecture
update feeds, optional MCPB, checksums and a versioned asset manifest.
`validate-admin-update-feeds.mjs` verifies the exact version, architecture-specific
filename, size and SHA-512 of each generated feed before and after upload.
`validate-release-assets.mjs` rejects
missing/unexpected/empty/symlink/corrupt artifacts. A checksum set is not proof of
runtime readiness. Record live provider/schedule/MCP/portal results separately.

Electron-builder generates GitHub feed metadata but never publishes directly:
packaging commands use `--publish never`; only this release workflow uploads.
GitHub uses `latest-linux*.yml` even for prereleases; electron-updater resolves the
selected release by channel and falls back to that release's standard feed.
Stable is the Admin default regardless of the installed build's suffix. Beta
includes stable; Alpha includes beta and stable. RC remains a valid product tag,
but is not an Admin update channel and is not offered by these preview channels.
PR AppImages carry `fholdPreview: true` build metadata and do not self-update away
from the reviewed PR. Existing updater-free versions require one manual install
of an updater-enabled release. Never add feeds to or replace older public tags.

The separate `admin-desktop-native.yml` workflow produces Windows/macOS previews
without container jobs or release publication. It exercises the NSIS Start menu
shortcut/taskbar ID, macOS bundle/Dock icon, packaged resources and actual renderer
startup on native runners. macOS CI uses ad-hoc preview signing only. Native preview
checks are not public release qualification: signed/notarized distribution, native
update feeds and supported hosting workflows must be verified before adding these
platforms to the required release asset inventory.

The retained local alpha may be qualified for the actual Linux x64 host while
ARM64 runtime qualification remains deferred without native hardware. Cross-build
evidence must verify the extracted ARM64 ELF architecture and be labeled
build-only, not a startup smoke. Future public asset validation still requires
the complete declared Linux inventory before publication.

## Reviewed runtime advisories

The first [public GitHub CI run](https://github.com/fwdslsh/fhold/actions/runs/37181359928)
passed the quality gate and both native architectures for Guardian and Portal,
but the Assistant's fixable-HIGH image scan failed on seven advisories in npm's
bundled dependencies.

The Assistant now installs pinned upstream npm 12.2.0 through the standard
global upgrade during the Node build stage. Its published bundle updates
`ip-address` and `tar` and removes four of those findings. Three remain:

| Bundled dependency | Version | Remaining advisory | Required fix |
| --- | --- | --- | --- |
| `brace-expansion` | 5.0.9 | CVE-2026-102276, CVE-2026-102278 | 5.0.11 or later |
| `undici` | 6.28.0 | CVE-2026-19534 | 6.28.1 or later in the 6.x line |

The rebuilt Linux x64 image was scanned with Trivy 0.75.0 and confirms exactly
these three fixable high findings, with no critical findings. Guardian and Portal
have neither critical nor fixable high findings. The standard runtime and recovery
smokes passed separately; they do not waive vulnerability gates. See the
[dependency-refresh verification](alpha-qualification.md#dependency-refresh-verification).

The [published npm 12.2.0 bundle](https://registry.npmjs.org/npm/-/npm-12.2.0.tgz)
retains these versions as checked on October 4, 2026. npm 12.2.0 supports
the pinned Node 24 runtime. Use [npm's supported upgrade process](https://docs.npmjs.com/try-the-latest-stable-version-of-npm/);
do not modify its internal bundle or remove npm/npx functionality.

On October 4, 2026 the product owner explicitly approved publishing this alpha
with these three npm-bundled denial-of-service findings. The exception file
`.github/trivy-ignore.yaml` matches only the exact advisory IDs, installed npm
bundle paths and affected package versions, and expires November 4, 2026.
The unfiltered high/critical report stays visible. All critical findings and all
other fixable high findings still fail the gate. This is a disclosed exception,
not a clean-scan claim. Remove the entries when a supported npm release fixes
them; re-review before expiry. Existing running instances are not updated by a
source or release publication.

The [published npm 12.2.1 bundle](https://registry.npmjs.org/npm/-/npm-12.2.1.tgz)
contains `brace-expansion` 5.0.12 and `undici` 6.29.0, which fix all three
approved findings. The Assistant now pins npm 12.2.1, and those npm exceptions
have been removed. Releases before the change still contain the npm 12.2.0 bundle.

### Brotli security update (October 28, 2026)

The October 23 owner-approved exception for
[CVE-2026-111497](https://security-tracker.debian.org/tracker/CVE-2026-111497)
covered Guardian and Portal's Debian `libbrotli1` **1.1.0-2+b7** while no patched
Debian package was available. Debian now provides **1.1.0-2+deb13u1** for both
amd64 and arm64 through [DSA-6582-1](https://security-tracker.debian.org/tracker/DSA-6582-1).

Both images install `libbrotli1` through their existing APT build step and refuse
a package older than that security update. The exact Brotli scan exception is
removed. Unfiltered scans and native architecture startup/security checks remain
required. No bundled library is patched or replaced, and publication does not
update already installed instances.

## Scheduler build provenance

The October 9, 2026 image scan found CVE-2026-78667 and CVE-2026-97031
in the Go 1.26.6 runtime of the latest upstream Supercronic v0.2.49 binary.
The Assistant now builds that same pinned source using the standard versioned
`go install` command in an official Go 1.26.9 build stage. The compiler and build
dependencies stay out of the final image. No scheduler source, dependencies or
runtime configuration are patched, and no scan exception is added.
See [Supercronic's releases](https://github.com/aptible/supercronic/releases/tag/v0.2.49)
and the [Go release history](https://go.dev/doc/devel/release#go1.26.0).

## MCPB build-tool security update (October 28, 2026)

The root lockfile now resolves `node-forge` **1.4.2**, within MCPB 2.1.2's existing
`^1.3.2` dependency range. The
[maintainer advisory](https://github.com/digitalbazaar/forge/security/advisories/GHSA-2g46-22mc-6gwp)
identifies CVE-2026-85393 (also tracked as GHSA-86w9-cpqp-85rv) as fixed in 1.4.1.
Version 1.4.2 retains that RSA verification fix and corrects a PEM Buffer-input
regression from 1.4.1. The obsolete node-forge audit ignore is removed.

The standard unsigned MCPB pack and validation remain required qualification.
`node-forge` is absent from the three runtime images and delivered stdio bridge.
No dependency override, custom crypto fork or packer is introduced. The separate
MCPB Zod exception below remains; filtered audit success is not a claim
of a clean raw audit.

## Reviewed proxy-logger advisory

On October 6, 2026 the product owner approved the specific moderate advisory
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
in `sprintf-js` 1.1.3. It was reached through `global-agent` → `roarr` in
download/build tools and AKM's former ONNX proxy dependency. Reviewed call sites used
fixed format strings with request/error data supplied separately; the finding
concerns attacker-controlled precision format strings. That reduces the observed
exposure, but is not a clean-audit claim or a guarantee for arbitrary extra apps.

The advisory was withdrawn on October22, 2026, so its obsolete audit ignore is
removed. AKM's former ONNX branch is gone, but Electron's independent
`@electron/get` → `global-agent` → `roarr` → `sprintf-js` chain remains in the
resolved workspace. The other individually reviewed
exceptions below remain. Runtime image scans and all other release gates remain
enabled.

## Upstream MSAL fix and remaining Zod exception

On October 23, 2026 (October 24 UTC), the product owner approved these two exact
exceptions pending supported upstream fixes. Track removal in
[issue #63](https://github.com/fwdslsh/fhold/issues/63):

- [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5): MSAL Node
  authentication-code parameter disclosure, fixed in 7.1.0. On October 30,
  Azure Identity 4.14.1 supplied the supported `^7.1.0` dependency range; this
  release resolves MSAL Node 7.1.2. The source and image exceptions are removed.
  Blob recovery qualification remains required for this dependency update.
- [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): Zod memory
  exhaustion from oversized invalid collections, fixed in 4.6.6. Direct fhold Zod
  and AKM CLI 0.10.261016-beta now resolve patched Zod 4.6.7. The AKM image
  exception has been removed. MCPB 2.1.2 independently still requires Zod 3
  (latest 3.25.76), so its source-audit exception remains. MCPB packs
  repository-owned manifests; do not describe this remaining exposure as patched.

`bun run audit` excludes the remaining Zod advisory and the two explicitly
approved glob/minimatch findings below; raw `bun audit` still reports them.
No global major-version override, vendor patch, severity-wide exclusion or
disabled audit is introduced. Source checks run before the mandatory audit, so
an advisory cannot hide unrelated test failures. The separately approved Assistant
image scope is documented below.
Re-review with the next AKM update, before any release, and no later than
**November 6, 2026**. Remove each exception as soon as its supported dependency
chain is patched (including the separate MCPB and Azure chains), and qualify AKM
or Blob behavior when updating those dependencies. This is not a clean-audit claim.

## Temporary glob and minimatch source-audit exceptions

On October 31, 2026, the product owner approved these exact advisory exceptions
for PR #95. Raw audit against untouched main and the AKM update reports the same
findings through OpenCode's SDK/util dependencies and Electron's packaging chain:

- [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4):
  moderate glob cancellation bypass. An aborted walk can continue filesystem
  traversal after its caller times out, consuming I/O and CPU. Patched in 14.0.2.
- [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249):
  moderate minimatch glob-pattern amplification, potentially exhausting CPU and
  memory with hostile patterns. Patched in 11.0.1.

These are acceptance of unresolved findings, not fixes or unreachable-code
claims. The root audit command ignores only their exact IDs, alongside the
existing MCPB Zod ID. The mandatory audit still gates images and catches all
other advisories; raw reports remain unfiltered. No image exception, unsupported
major override or installed vendor edit is added. Adopt supported parent-chain
fixes and remove each ignore when its affected chains are patched. Re-review
before the next release and by the existing **November 6, 2026** review deadline.

## Temporary Assistant image exceptions (October 26, 2026)

On October 26, 2026 (October 27 UTC), the product owner explicitly approved
three identified PR #67 Assistant findings until **November 6, 2026**. The AKM
Zod entry was removed with CLI 0.10.261016-beta; the MSAL entry was removed with
Azure Identity 4.14.1 on October 30. On October 28, the owner
reaffirmed the upstream-package exceptions for PR #75/#76, including the two
additional findings in the same npm-owned Undici bundle. These entries retain
the existing **November 6, 2026** expiry:

| Trivy ID / exact GitHub alias | Package/version | Exact image package path |
| --- | --- | --- |
| CVE-2026-109869 / GHSA-xjj6-f33q-929c | `undici@6.29.0` | `usr/local/lib/node_modules/npm/node_modules/undici/package.json` |
| CVE-2026-109383 / GHSA-2m5v-pch6-74hx | `undici@6.29.0` | `usr/local/lib/node_modules/npm/node_modules/undici/package.json` |
| CVE-2026-87018 / GHSA-qrxm-fqhp-jwvm | `undici@6.29.0` | `usr/local/lib/node_modules/npm/node_modules/undici/package.json` |

Trivy0.76.1 applies the path and exact package/version PURL together; there are
no directory globs or severity-wide exclusions. The unfiltered high/critical
report remains visible. Other critical/fixable-high findings still fail, and
native expiry stops these entries applying after the deadline. The npm
entries permit its bundled HTTP client's unhandled-error denial of service
from excessive content-encodings, TLS certificate-validation bypass via dropped
Agent TLS options, and denial of service during TLS renegotiation with a
mismatched certificate. These accepted findings do not block otherwise-verified
PR merges while the exceptions apply; they remain unresolved upstream defects.
Official npm12.2.1 and maintained
11.21.1 tarballs both still contain undici6.29.0; no vendor tree is modified.

[Issue #63](https://github.com/fwdslsh/fhold/issues/63) tracks removal of the
remaining entries. The supported AKM upgrade fixes its Zod chain independently
of Azure/MSAL, MCPB and npm. The supported Azure chain is now selected; qualify
Blob behavior with it. Adopt a supported patched npm release and qualify npm/npx
before removing its entries. Preserve
[issue #63](https://github.com/fwdslsh/fhold/issues/63)'s separate MCPB and npm
tracking. Re-review before publication, when a supported fix appears, or by
November 6; remove each exception as soon as its own chain is patched. Approval
does not authorize disabling scans, major vendor overrides or skipping runtime
qualification, and green filtered scans are not clean raw scans.

## Public release gates

The GitHub CI/release workflows reuse `gates.yml` and only build Linux
targets. Release validation reuses a successful canonical `release/*` push CI run for the
exact SHA and scope only while it is less than 24 hours old. It verifies
the successful quality job, all six native image jobs and final native CLI/Admin
artifact jobs for a full release, plus the complete immutable candidate artifact set.
Same-repository release PRs reuse that exact-head candidate for native checks and
Linux Admin packaging only when their current base is already in the head.
Base retargets and divergent bases retain PR merge-result validation. Product CI
runs on PRs and `release/*` pushes, not on `main` pushes after merge. Direct pushes
to `main` also do not run product CI; use a PR for pre-merge checks. Publication
still requires exact-SHA candidate qualification, including for a new merge SHA.
Their shared workflow conditions prove full source testing even when GitHub
omits reusable-job step metadata. Tooling reuse needs explicit tooling-test evidence,
or a complete full candidate with successful Admin renderer evidence.
Partial image matrices, skipped docs/lock-only CI and PR runs cannot qualify a
full release. Exact-commit CI in progress is awaited instead of duplicated;
lookup failure stops publication. Absent or invalid candidate evidence runs the
shared gates in candidate mode. Candidate images include the final version,
revision, SBOM and provenance, and their OCI graph/rootfs must match the native
tested image. Final CLI/Admin startup checks run before those files are retained.
Publication selects exact run/attempt artifact IDs, verifies receipts and hashes,
promotes unchanged OCI manifests/attestations, signs the combined index and uploads
the qualified final binaries. It does not rebuild images or application artifacts.
Checksum, feed, signature and download verification remain publication checks.
A separate dry run is optional. Stamp once before final candidate qualification;
changed stamped bytes require new evidence, while successful eligible checks are
reused. Preserve owner-approved coverage exclusions and close the release as soon
as the bounded public-artifact checklist passes, without adding optional probes.
Read-only CI also runs in contributor forks. Release publishing requires
the exact repository/origin and stamped versions, and refuses live publication
unless explicitly configured. The workflows retain immutable image/tag
retry and upload checksum checks. Source hosting is canonical on GitHub; binary
and image publication is a separate operation. Registry ownership and publishing
credentials must be configured before live publication. Verify signing, real
artifacts and download instructions for every release. The CLI delivers a standalone Linux
executable, not an npm bootstrap package.

Published bytes/tags must not be overwritten. Matching retries are no-write;
differing content requires a new version. Stable uses `latest`; alpha/beta/rc
use their explicit channels. Starting with **0.4.1001**, the recommended release
is stable and GitHub's `releases/latest` endpoint selects it. The temporary
beta-as-latest recommendation is retired. Preserve an operator's native updater
channel choice; Stable still excludes prereleases. Preserve release/checkpoint evidence and
disclose incomplete live/renderer/platform gates.

## Licensing

Owned product source and new image/extension metadata use MIT. Third-party
dependencies retain their original licenses. Existing immutable images and
artifact receipts are historical bytes; changing source licensing does not
rebuild, relabel or re-certify them. A new artifact build requires a new release
identity and its own verification.
