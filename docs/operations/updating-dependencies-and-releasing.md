# Update dependencies and make a release

Contributors update the source pins and root lockfile, qualify the resulting
artifacts, then prepare a separately reviewed release. Container dependencies
are installed at image build time. Changing a running container with a global
package upgrade does not update fhold's reproducible build.

Use a clean branch from canonical [main](https://github.com/fwdslsh/fhold).
Read [the product contract](../technical/core-principles.md),
[testing workflow](../technical/testing-workflow.md) and
[release runbook](release.md) before changing runtime versions. Keep a record of
old/new versions, upstream release notes, image source revision, exact commands,
results and skipped gates in the PR.

## Find and review updates

Review dependency freshness before **every PR merge**, but scope updates to the
work. A focused fix does not have to absorb unrelated upgrades. Apply urgent
security fixes and required compatibility updates promptly. Batch other updates
in explicit dependency PRs or early release preparation, reviewing the full
inventory below and selecting supported compatible versions deliberately.

Record the date, review scope, release channels, changed versions, compatibility
holds and deferred updates in the PR. Finish intended updates before final
qualification. A newer noncritical upstream release appearing during testing
does not restart that work; record it for the next batch. Do not call a held
dependency the latest release. Changed pins or resolutions still require the
affected checks on the final SHA; earlier CI cannot qualify changed inputs.
Reuse eligible successful final-SHA CI for publication. Use the PR template to
record the review rather than repeatedly refreshing the entire dependency tree.

Use the Bun version declared by the root `packageManager` and a native Node
binary compatible with the pinned Node image. A shell shim that runs Node
programs through Bun does not qualify Electron or npm tooling.

```sh
bun --version
node --version
bun install --frozen-lockfile
bun outdated --recursive
npm view akm-cli dist-tags --json
npm view akm-cli@latest version engines --json
npm view akm-opencode-v2@latest version dependencies peerDependencies --json
npm view @opencode/cli@latest version engines --json
npm view @opencode/client@latest version --json
npm view @opencode/plugin@latest version dependencies --json
npm view @anthropic-ai/claude-code@latest version engines --json
npm view @openai/codex@latest version engines --json
```

Check upstream changelogs and supported engines, including every intervening
breaking change. Prefer the current supported stable line for ordinary tools.
AKM's npm `latest` is stable; `next` carries newer prereleases. The current pins
deliberately use the matching beta pair for the native plugin-health fix; see the
[October 30 review](dependency-refresh-2026-10-30.md). Select channels explicitly.
Resolve the plugin's required CLI version before choosing that pin.
Compare actual release provenance and published tags,
not just numeric patches: upstream AKM has changed its prerelease naming.
Write exact resolved versions into runtime manifests, never moving dist-tags.

Check peer dependencies as well as direct pins. An OpenCode upgrade can change
the Effect version and native plugin APIs. Keep fhold's Effect dependency aligned
with its chosen OpenCode plugin SDK; check whether AKM's published plugin still
declares an older SDK/Effect pair. Multiple installed SDK versions require actual
native-harness verification. Do not patch vendor packages or conceal a failed
integration with a test-only loader or runtime workaround.

Also review MCP SDKs, Azure SDKs, Electron and its packager, accessibility tooling,
TypeScript/types, library dependencies and root security overrides. Check the
official [Bun](https://github.com/oven-sh/bun/releases),
[Node](https://nodejs.org/en/about/previous-releases),
[Go](https://go.dev/dl/) and
[Supercronic](https://github.com/aptible/supercronic/releases) releases,
GitHub Actions, Trivy, and the docs renderer/template. A new major version is a
compatibility decision, not an automatic `--latest` bulk update.

## Update every owning pin

| Dependency | Source of truth and matching inputs |
| --- | --- |
| AKM CLI and OpenCode 2 plugin | `containers/assistant/tools/package.json`; matching `akm-opencode-v2` in `plugins/fhold/package.json` |
| Claude/Codex AKM plugins | Immutable archive commit, SHA-256 and extraction paths in `containers/assistant/Dockerfile` |
| OpenCode | Assistant's `@opencode/cli`, `@opencode/client`, `@opencode/plugin`; Guardian client; fhold plugin SDK and Effect dependency |
| Claude Code and Codex | Assistant tools manifest |
| Bun | Root `packageManager`, all Bun Docker stages, all workflow `bun-version` values, workspace `bun-types` |
| Node/npm | Assistant Node stage and `NPM_VERSION`; Portal Node base; docs workflow's supported Node line |
| Scheduler/compiler | Assistant `SUPERCRONIC_VERSION` and Go build stage |
| Application/build dependencies | Owning workspace manifests; root overrides; one root `bun.lock` |
| Documentation | `website/package.json` renderer and `website/unify.yaml` template version |
| CI tools | Versioned `uses:` declarations and Trivy version in `.github/workflows/` |

For the native AKM marketplace, resolve the published plugin release tag to its
immutable commit. Its Claude and Codex manifest versions should agree with the
selected OpenCode AKM plugin release.

```sh
# Substitute the selected upstream release tag.
AKM_PLUGIN_TAG=v0.10.261003-beta
AKM_PLUGIN_COMMIT=$(gh api "repos/itlackey/akm-plugins/commits/$AKM_PLUGIN_TAG" --jq .sha)
curl --fail --location --output /tmp/fhold-akm-plugins.tar.gz \
  "https://codeload.github.com/itlackey/akm-plugins/tar.gz/$AKM_PLUGIN_COMMIT"
sha256sum /tmp/fhold-akm-plugins.tar.gz
tar -tzf /tmp/fhold-akm-plugins.tar.gz
```

Update the Dockerfile's archive URL, `ADD --checksum`, `plugin_root` and all
archive extraction prefixes together. Inspect the manifests and hook source
inside the archive. The native plugin installers run at build time against that
baked marketplace; do not copy its hooks into a second registration path.
Personal plugin updates or a `git pull` in an unrelated AKM checkout do not
change this image.

After editing the owning manifests, run `bun install` with the selected Bun to
regenerate the single lockfile. For an intentional full dependency batch, run
`bun update --recursive --no-cache` to refresh transitive resolutions within the
reviewed manifest constraints. A targeted update need not refresh unrelated
resolutions. The root-only outdated command can miss workspace updates; neither form checks the
native marketplace archive, Docker bases, scanner or workflow pins. Review the
lockfile diff and resolved transitive versions,
then verify `bun install --frozen-lockfile`. Do not edit integrity records by hand
or add a second container lockfile. Leave historical qualification reports and
old release entries intact; update current-facing documentation and add new
verification evidence.

## Qualify the dependency change

```sh
bun run check
FH_SOCKET_TESTS=1 bun run test
bun run lint
bun audit
bun run audit
bun run --cwd packages/cli build
bun run --cwd packages/electron bundle
bun test scripts/packaged-assets.test.ts
bun run --cwd packages/claude-desktop pack
bun run docs:test
bun run docs:check
bun run docs:build
bash -n scripts/dev-setup.sh scripts/smoke-image.sh \
  containers/assistant/entrypoint.sh containers/assistant/healthcheck.sh \
  containers/guardian/entrypoint.sh
```

The raw audit intentionally reports the narrowly reviewed advisories described
in [the release runbook](release.md). Recheck whether upstream has fixed them.
Only the existing approved scope may be ignored; new findings require resolution
or an explicit review. Runtime image scans remain separate.

Build all three images from the changed lockfile. Use unique local tags and
`ci` metadata for development qualification; published version tags are immutable.

```sh
docker build --pull -f containers/assistant/Dockerfile \
  --build-arg PLATFORM_VERSION=ci -t fhold/assistant:dependency-check .
docker build --pull -f containers/guardian/Dockerfile \
  --build-arg GUARDIAN_VERSION=ci -t fhold/guardian:dependency-check .
docker build --pull -f containers/portal/Dockerfile \
  --build-arg PLATFORM_VERSION=ci -t fhold/portal:dependency-check .
bash scripts/smoke-image.sh fhold/assistant:dependency-check assistant
bash scripts/smoke-image.sh fhold/guardian:dependency-check guardian
bash scripts/smoke-image.sh fhold/portal:dependency-check portal
node scripts/smoke-keepalive.mjs fhold/assistant:dependency-check
node scripts/smoke-workload-environment.mjs fhold/assistant:dependency-check
node scripts/smoke-managed-policy.mjs fhold/assistant:dependency-check
docker tag fhold/assistant:dependency-check fhold/fhold-assistant:dependency-check
FH_NATIVE_PROVIDER_TESTS=1 \
  FH_NATIVE_PROVIDER_CLI="$PWD/packages/cli/dist/fhold-cli" \
  FH_NATIVE_PROVIDER_IMAGE=fhold/fhold-assistant:dependency-check \
  bun test scripts/provider-settings-native.test.ts
FH_RECOVERY_TEST_IMAGE=fhold/assistant:dependency-check node scripts/smoke-recovery.mjs
```

The Assistant startup smoke runs `smoke-akm-harnesses.mjs` inside the image
and verifies real recall in OpenCode, Claude and Codex. Passing a build or
`--version` alone does not establish native tool/plugin compatibility.
Run the native-provider and history cases described in
[the scripts guide](../../scripts/README.md) with the newly built Assistant,
and exercise upgrade/recovery from the previously published runtime using
private copies. Use disposable accounts/data and explicit free ports.
Materialize an isolated home with `install --no-start` and validate Compose
with all three profiles: `gateway`, `discord`, `slack`.
Use focused local regressions while developing; do not automatically repeat the
complete native matrix locally and in CI. Before freezing the candidate, map the
required checks to eligible evidence. The native provider case checks normalized
API fields, live editing, restart preservation, provider disable/re-enable,
Guardian and scheduled execution; a successful hook smoke alone does not cover
those boundaries. Canonical candidate CI supplies the shared native gate evidence.

The reusable [.github/workflows/gates.yml](../../.github/workflows/gates.yml)
is the full gate inventory, including raw/reviewed image scans, native x64 and
ARM64 execution, security, real scheduler/provider behavior and recovery.
Cross-building ARM64 is build evidence only. Record unrun gates honestly;
successful unit tests do not waive image or release gates.

## Prepare a full runtime release

Dependency changes that affect containers require a **full** release. A
tooling-only release retains the existing published runtime and cannot ship
pending container or dependency-resolution changes.

From 0.3, choose an unused UTC version using `X.Y.YYMMNN-beta` (or alpha/rc/stable).
Use commit SHAs and image digests while developing and functionally validating
candidates. Choose and stamp the public version near publication. Start the
monthly counter at 00 and advance it for each public release, including channel
promotion. No prerelease serial is used. Check public tags, releases and images
for used counters; local candidate receipts and nonpublishing dry runs do not
reserve one. See the
[monthly version policy](release.md#monthly-versions-from-03) for retries,
overflow and historical 0.1/0.2 compatibility:

```sh
git fetch origin --tags
gh release list --repo fwdslsh/fhold --limit 20
# Example only: select an unused month/counter/channel for the actual candidate.
VERSION=0.3.261000-beta
SCOPE=full VERSION="$VERSION" bun scripts/bump-release.mjs
SCOPE=full VERSION="$VERSION" STAMP=true bun scripts/bump-release.mjs
bun install --lockfile-only
```

Review every manifest and Compose default listed in
[.github/release-manifest.json](../../.github/release-manifest.json), the
lockfile, changelog and download instructions. Stamp once before the final
candidate build: it rebuilds embedded/staged assets and runs the affected gates.
An unpublished candidate can change
under the same provisional version; discard stale local output or regenerate its
checksums and manifest, and qualify the changed build. A candidate receipt is
evidence for its recorded SHA/digests, not a permanent version reservation.
Once a release Git tag, versioned registry image or release download becomes
public, even in a partial publication, its version and bytes are immutable and
changed content requires a new counter. CI/development artifacts remain candidate
evidence identified by SHA/digest; they do not reserve counters. Native data-schema compatibility is owned by the vendor tools,
not the product release number.

Submit the reviewed change through a PR and retain its validation evidence.
Push the stamped candidate to a canonical `release/*` branch and wait for that
exact commit's GitHub CI to pass. Release validation can reuse this canonical
push run for 24 hours, checking the SHA, workflow, successful quality job,
all six native image jobs, final CLI/Admin jobs and complete candidate artifacts.
Those images require successful quality and run
under the same full-scope condition as the source tests. Their complete success
also proves full scope when GitHub omits reusable-job step metadata. Tooling
reuse needs explicit tooling-test evidence, or a complete full candidate with
the successful Admin renderer check; version-only root stamps commonly select
that full candidate. Fork/PR runs, different commits, stale runs,
missing jobs/artifacts or failed checks cannot qualify a release. If exact-commit
CI is still running, publication waits for it instead of starting duplicate gates.
An unavailable lookup fails without starting another build. If no eligible
candidate exists, the release workflow prepares one with the shared gates.

Use one stamped `release/*` candidate for the release PR and publication. A
release-authorized fix should receive its final stamp before final PR qualification;
do not qualify and merge the fix, then create a version-only PR that repeats the
entire native matrix. Complete functional validation first, then qualify once.
A same-repository release PR reuses its successful exact-head candidate instead of
starting another native matrix or Linux AppImage preview. This requires that the
PR's current base commit is already in its head; a changed base, base retarget,
fork, failed candidate or missing artifacts retains normal PR validation. Native
Windows/macOS previews remain separate because Linux release packaging does not
cover them. Product CI does not run again after merging to `main`. Direct `main`
pushes also do not trigger product CI; use a PR for pre-merge checks. Publication
of a different merge SHA still requires its own exact-SHA candidate qualification.

Candidate mode retains final-version OCI archives with SBOM/provenance and the
actual final CLI/Admin/MCPB files. Native tests run the image from the same build;
its OCI graph and rootfs are checked before qualification. Publication downloads
immutable artifact IDs from the selected run/attempt, verifies receipts/hashes,
copies the exact OCI manifests and attestations, and signs the combined index.
It uploads the retained binaries without rebuilding. Ordinary PR checks keep
their existing fast image path. Only explicit `release/*` candidate
pushes and release-workflow fallback gates pay that cost. Partial component CI
cannot qualify a full release.
Caches only accelerate builds and never substitute for qualified artifacts.

Keep development regression, final candidate qualification and publication
integrity checks distinct. Reuse eligible successful evidence unless relevant
inputs changed or a concrete failure requires a rerun; preserve owner-approved
coverage exclusions. Once the published-artifact checklist below passes, finish
and report. Optional diagnostics do not add blockers or prolong release closeout.

A separate nonpublishing run is optional when artifact inspection is needed:

```sh
gh workflow run release.yml --repo fwdslsh/fhold --ref release/your-candidate \
  -f version="$VERSION" -f scope=full -f dry_run=true
gh run list --repo fwdslsh/fhold --workflow release.yml --limit 5
```

Inspect the chosen release run: both native architectures, CLI/AppImages, extension,
container scans/smokes, checksums and asset manifest must pass. Include the
rendered/packaged Admin and any live-provider qualification required by
[the release runbook](release.md). A workflow dispatch is not proof it passed.

## Publish and verify

Publication is a separate maintainer decision after reviewing the concrete
candidate and its evidence. The canonical repository needs its Docker Hub
credentials and `FH_PUBLICATION_CONFIGURED=true`. With publication authorized:

```sh
gh workflow run release.yml --repo fwdslsh/fhold --ref main \
  -f version="$VERSION" -f scope=full -f dry_run=false
```

For a publication-only workflow repair, dispatch the reviewed workflow with
`-f candidate_sha=<full-qualified-SHA>`. This selects the existing source and
artifacts while retaining the actual workflow revision in the run record. An
explicit source requires eligible retained qualification and fails instead of
starting a fallback build. Receipts, OCI labels and the release tag remain bound
to that source SHA.

Verify the exact successful run, GitHub release/download inventory, uploaded
checksums, versioned asset manifest, signed image digests and appropriate channel
tags. The workflow signs images and verifies publication; never overwrite
published tags or artifact bytes. Download the new standalone CLI and verify its
version, then qualify a fresh disposable install and an upgrade of a disposable
copy using the new CLI. Keep runtime accounts, database migrations and recovery
evidence private. Existing running instances change only through their normal
explicit update path; publishing does not upgrade them.
