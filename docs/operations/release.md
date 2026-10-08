# Release runbook

GitHub at https://github.com/fwdslsh/fhold is the canonical source and contribution
host. `.github/workflows/release.yml` builds Linux downloads and signed amd64/arm64
images on GitHub, verifies uploaded checksums and publishes the release. Public
Docker Hub repositories are `fwdslsh/fhold-assistant`, `fwdslsh/fhold-guardian`
and `fwdslsh/fhold-portal`. Fresh CLI/Admin installs select the matching pinned
images automatically. No Docker Hub account is needed to pull them.

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

## Frozen version contract

For the **0.1 release line**, use `X.Y.yyMMddHHmm` in UTC (20yy), optionally
`-alpha`, `-beta` or `-rc` and a positive serial. Real dates/hours/minutes,
canonical integers and numeric precedence are enforced by `scripts/set-version.mjs`.
Released candidate versions are frozen. An existing receipt permits an
identical source/content retry only. Changed source or artifact bytes require
a new version; unpublished candidates are not an exception.

Establish release intent once and carry it across all package manifests, CLI
version, image tags, Admin/MCPB manifests, filenames, checksums and receipt.
`releaseIntent` binds version to revision/content hash, rejects regressed
clocks/collisions and accepts retries only for the same identity.
At the same minute use a higher prerelease serial; stable collisions require
another minute.

`VERSION=<frozen-version> node scripts/bump-release.mjs` previews stamping;
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

### Planned patch format from 0.2

Starting with the **0.2 release line**, replace the hour/minute timestamp with
`X.Y.yyMMdd<build>`: two-digit year, month, day, then an unpadded positive daily
build number. Keep the date in UTC; start the build counter at `1` each day and
increment it for each new release build. Existing immutable-version and
identical-content retry rules still apply.

Examples: `0.2.2610081` is build 1 on October 8, 2026;
`0.3.2612225-beta.1` is build 5 on December 22, 2026, marked beta 1.
Alpha, beta and rc suffixes remain supported, including their optional positive
serials. No existing 0.1 versions, tags or artifacts will be renamed.

This is a planned change, **not implemented by the current 0.1 tooling**. Before
releasing 0.2, update version parsing/stamping, release-intent collision checks,
workflow inputs, artifact validation and their tests together. Parse date and
build separately for chronological comparison: with an unpadded counter,
`26100810` (October 8, build 10) is numerically larger than `2610091`
(October 9, build 1), so ordinary numeric patch ordering is not chronological.

## Linux acceptance

Run [the test gates](../technical/testing-workflow.md), CLI/Admin builds and
[rendered/packaged Admin verification](admin-setup-verification.md), all-profile
Compose, Guardian security, own-backup/history preservation and real-image tests.
Build Assistant/Guardian/Portal from locked dependencies for Linux amd64/arm64,
smoke/scans on native architecture, validate non-root/capability/mount boundaries,
and run real AKM checks in all three harnesses.

Required distribution is Linux x64/arm64 CLI and AppImage Admin, optional MCPB,
checksums and a versioned asset manifest. `validate-release-assets.mjs` rejects
missing/unexpected/empty/symlink/corrupt artifacts. A checksum set is not proof of
runtime readiness. Record live provider/schedule/MCP/portal results separately.

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

## Reviewed build-tool advisory

Raw `bun audit` continues to report `GHSA-86w9-cpqp-85rv`: `node-forge` 1.4.0 is
an unpatched high-severity transitive dependency of the MCPB developer packer.
The [official advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) concerns
RSA signature verification and lists no patched version as of 2026-10-04.

The reviewed exception is limited to the standard **unsigned** MCPB pack path:
the packer eagerly imports signing code, but this path performs no certificate,
ASN.1 or signature processing. `node-forge` is absent from the three runtime
images and delivered stdio bridge. The quality gate may use
`bun audit --ignore GHSA-86w9-cpqp-85rv` with that explicit scope; this is not a
clean-audit claim or a blanket exclusion. Re-review before signing, certificate
processing, changing the packer path, or when an upstream patch becomes available.
Keep the useful bridge; do not introduce a custom crypto fork or packer.

## Reviewed proxy-logger advisory

On October 6, 2026 the product owner approved the specific moderate advisory
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
in `sprintf-js` 1.1.3. It remains the latest published version with no patched
release; the standard `bun audit fix` reports no available correction.
It is reached through `global-agent` → `roarr` in Electron's download/build
tools and AKM's ONNX proxy dependency. Reviewed proxy-logger call sites use
fixed format strings with request/error data supplied separately; the finding
concerns attacker-controlled precision format strings. That reduces the observed
exposure, but is not a clean-audit claim or a guarantee for arbitrary extra apps.

The audit command ignores only this exact advisory and the separately reviewed
unsigned MCPB advisory. All other findings still fail. No dependency is patched,
replaced or removed. Re-review by November 6, 2026, when a supported upstream
fix is released, or before changing the caller/format-string boundary. Runtime
image scans and all other release gates remain enabled.

## Public release gates

The GitHub CI/release workflows reuse `gates.yml` and only build Linux
targets. Read-only CI also runs in contributor forks. Release publishing requires
the exact repository/origin and stamped versions, and refuses live publication
unless explicitly configured. The workflows retain immutable image/tag
retry and upload checksum checks. Source hosting is canonical on GitHub; binary
and image publication is a separate operation. Registry ownership and publishing
credentials must be configured before live publication. Verify signing, real
artifacts and download instructions for every release. The CLI delivers a standalone Linux
executable, not an npm bootstrap package.

Published bytes/tags must not be overwritten. Matching retries are no-write;
differing content requires a new version. Stable uses `latest`; alpha/beta/rc
use their explicit channels. Preserve release/checkpoint evidence and disclose
incomplete live/renderer/platform gates.

## Licensing

Owned product source and new image/extension metadata use MIT. Third-party
dependencies retain their original licenses. Existing immutable images and
artifact receipts are historical bytes; changing source licensing does not
rebuild, relabel or re-certify them. A new artifact build requires a new release
identity and its own verification.
