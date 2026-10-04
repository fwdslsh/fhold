# Release runbook

GitHub at https://github.com/fwdslsh/fhold is the canonical source and contribution
host. The latest qualified Linux artifacts and all three images are
`0.1.2610040221-alpha.2`; the [qualification summary](alpha-qualification.md)
records tested runtime/artifact evidence and remaining gates. Changed source
does not inherit those artifacts' qualification.

Current source candidate is `0.1.2610040547-alpha.3` (unreleased). Preparing and
publishing its source does not publish new binaries/images or establish passing
GitHub CI; record actual workflow results separately.

Public binary downloads, container image publishing and signing are not
configured. Keep the standalone CLI/source-build path and local `fhold/` image
namespace until public release gates are explicitly configured and verified.
No npm bootstrap package or cross-host publishing bridge is required.

The persisted literal `fhold` namespace is local-only: activation uses
`--pull never`, ordinary update defaults to no pull, and explicit update `--pull`
is rejected. Missing tags require reviewed local builds. Explicit nonlocal
registry intent retains its pull behavior; this is not a new configuration flag.

## Frozen version contract

Use `X.Y.yyMMddHHmm` in UTC (20yy), optionally `-alpha`, `-beta` or `-rc` and
a positive serial. Real dates/hours/minutes, canonical integers and numeric
precedence are enforced by `scripts/set-version.mjs`.
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
launch boundary. Alpha.2 passed those actual-binary checks and artifact gates;
subsequent source changes do not rebind its artifacts to another revision.

The Assistant image also fixes the distinct Bun helper/AKM workspace-preload
boundary with native `BUN_OPTIONS='--no-env-file --config=/dev/null'`. Verify
that hostile `/work/bunfig.toml` preloads do not execute through managed helpers
using the real-image/native-harness smoke. This is an image runtime option,
not a replacement launcher or configuration service.

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

## Reviewed build-tool advisory

Raw `bun audit` continues to report `GHSA-86w9-cpqp-85rv`: `node-forge` 1.4.0 is
an unpatched high-severity transitive dependency of the MCPB developer packer.
The [official advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) concerns
RSA signature verification and lists no patched version as of 2026-10-01.

The reviewed exception is limited to the standard **unsigned** MCPB pack path:
the packer eagerly imports signing code, but this path performs no certificate,
ASN.1 or signature processing. `node-forge` is absent from the three runtime
images and delivered stdio bridge. The quality gate may use
`bun audit --ignore GHSA-86w9-cpqp-85rv` with that explicit scope; this is not a
clean-audit claim or a blanket exclusion. Re-review before signing, certificate
processing, changing the packer path, or when an upstream patch becomes available.
Keep the useful bridge; do not introduce a custom crypto fork or packer.

## Public release gates

The GitHub CI/release workflows reuse `gates.yml` and only build Linux
targets. Read-only CI also runs in contributor forks. Release publishing requires
the exact repository/origin and stamped versions, and refuses live publication
unless explicitly configured. The workflows retain immutable image/tag
retry and upload checksum checks. Source hosting is canonical on GitHub; binary
and image publication is a separate operation. Before enabling release publication,
verify registry ownership, accounts, signing, real artifacts and qualified download
instructions. The CLI source/build workspace delivers a standalone Linux
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
