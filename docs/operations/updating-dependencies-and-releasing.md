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

Use the Bun version declared by the root `packageManager` and a native Node
binary compatible with the pinned Node image. A shell shim that runs Node
programs through Bun does not qualify Electron or npm tooling.

```sh
bun --version
node --version
bun install --frozen-lockfile
bun outdated
npm view akm-cli dist-tags --json
npm view akm-cli@next version engines --json
npm view akm-opencode-v2@latest version dependencies peerDependencies --json
npm view @opencode/cli@latest version engines --json
npm view @opencode/client@latest version --json
npm view @opencode/plugin@latest version dependencies --json
npm view @anthropic-ai/claude-code@latest version engines --json
npm view @openai/codex@latest version engines --json
```

Check upstream changelogs and supported engines, including every intervening
breaking change. Prefer the current supported stable line for ordinary tools.
The OpenCode 2 integration currently needs AKM 0.10's prerelease channel;
`akm-cli@latest` still selects 0.9. Resolve the plugin's required CLI version
before choosing that pin. Compare actual release provenance and published tags,
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
inside the archive; `scripts/bake-managed-hooks.mjs` consumes those definitions.
The vendor installers still run at build time against that baked marketplace.
Personal plugin updates or a `git pull` in an unrelated AKM checkout do not
change this image.

After editing the owning manifests, run `bun install` with the selected Bun to
regenerate the single lockfile. Review its diff and resolved transitive versions,
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
  containers/assistant/opencode-run.sh containers/guardian/entrypoint.sh
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

The reusable [.github/workflows/gates.yml](../../.github/workflows/gates.yml)
is the full gate inventory, including raw/reviewed image scans, native x64 and
ARM64 execution, security, real scheduler/provider behavior and recovery.
Cross-building ARM64 is build evidence only. Record unrun gates honestly;
successful unit tests do not waive image or release gates.

## Prepare a full runtime release

Dependency changes that affect containers require a **full** release. A
tooling-only release retains the existing published runtime and cannot ship
pending container or dependency-resolution changes.

Choose an unused UTC version using `X.Y.yyMMdd<build>-beta.<serial>` (or the
explicit alpha/rc/stable channel). Start the daily build at 1 and increment it
for each new candidate. Check existing tags/releases first:

```sh
git fetch origin --tags
gh release list --repo fwdslsh/fhold --limit 20
# Example only: select an unused date/build/channel for the actual candidate.
VERSION=0.2.2610131-beta.11
SCOPE=full VERSION="$VERSION" bun scripts/bump-release.mjs
SCOPE=full VERSION="$VERSION" STAMP=true bun scripts/bump-release.mjs
bun install --lockfile-only
```

Review every manifest and Compose default listed in
[.github/release-manifest.json](../../.github/release-manifest.json), the
lockfile, changelog and download instructions. Rebuild embedded/staged assets
and rerun the affected gates after stamping. Frozen versions bind source and
artifact bytes: any changed candidate content requires a new version, even if
the earlier candidate was not published. Native data-schema compatibility is
owned by the vendor tools, not the product release number.

Submit the reviewed change through a PR and retain its validation evidence.
After the stamped candidate reaches the intended release branch, start the
nonpublishing workflow:

```sh
gh workflow run release.yml --repo fwdslsh/fhold --ref main \
  -f version="$VERSION" -f scope=full -f dry_run=true
gh run list --repo fwdslsh/fhold --workflow release.yml --limit 5
```

Inspect that exact run: both native architectures, CLI/AppImages, extension,
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

Verify the exact successful run, GitHub release/download inventory, uploaded
checksums, versioned asset manifest, signed image digests and appropriate channel
tags. The workflow signs images and verifies publication; never overwrite
published tags or artifact bytes. Download the new standalone CLI and verify its
version, then qualify a fresh disposable install and an upgrade of a disposable
copy using the new CLI. Keep runtime accounts, database migrations and recovery
evidence private. Existing running instances change only through their normal
explicit update path; publishing does not upgrade them.
