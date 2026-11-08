# Patched AKM beta — release plan

Target **0.4.1102-beta**. Public Git tags, GitHub releases and all three Docker
Hub image repositories were checked on November 8; counter 02 was unused.
Qualification and publication remain separate steps below.

## Included fhold changes

This release branch includes [PR #101](https://github.com/fwdslsh/fhold/pull/101):

- Leave native plugin settings in charge when memory hooks are on; preserve
  explicit off intent for managed writers and explicit native environment choices.
- Delegate ordinary task reference resolution to AKM, including bundle-qualified
  refs. Keep preserved removal and paused adoption of restored task files.
- Document native project routing and the scope of managed plugin memory hooks.

Workspace API/Admin integration is excluded. Supported headless learning controls,
index-cache recovery and offline pinned-plugin refresh are requested upstream in
[AKM #1506](https://github.com/itlackey/akm/issues/1506),
[#1507](https://github.com/itlackey/akm/issues/1507), and
[#1508](https://github.com/itlackey/akm/issues/1508).

## Published upstream dependency update

[AKM PR #1510](https://github.com/itlackey/akm/pull/1510) addresses locks on
filesystems without hard links, such as SMB, and deletion of usage events whose
entry has been removed. Both implementations were verified in the published
CLI tarball, rather than relying only on its release tag.

The selected npm releases are CLI **0.10.261113-beta** and plugins
**0.10.261112-beta**. OpenCode's plugin requires exactly that CLI. Native
Claude/Codex plugins accept it under their 0.10.261111 minimum-version rule.
Both OpenCode plugin manifests, the root lockfile and the native marketplace
archive are updated together. All runtime pins remain exact and image-baked.

Native marketplace commit: `52ebbec608fb33fb4fe19814db0ece5baa2674f2`.
Archive SHA256: `9e01dc88d80805d36f3584f27ac54dd366e8091e981f85ab5fcb43fca7806ea9`.
Both native manifests report 0.10.261112-beta. The release also includes native
bundle-sync fixes and removal of curate reranking and the index freshness walker;
fhold does not recreate that removed machinery. AKM still bootstraps missing or
uninitialized indexes and indexes for a different stash on first use, and owns
incremental index writes.

The [same-day dependency review](dependency-refresh-2026-11-08.md) records the
other selected versions, explicit holds and audit exceptions. Recheck required
compatibility/security changes for the selected patch; unrelated upgrades remain
separate. Upstream injected-filesystem tests are not evidence of a real SMB or
Azure deployment test.

## Before merge and publication

- [x] Verify the patched CLI and compatible plugins are published; record exact
  versions, provenance and the included upstream fixes.
- [x] Apply the pins and regenerate the lockfile; run affected native regressions
  and review audit results.
- [x] Confirm the release counter is unused, stamp every component, and write the
  final changelog entry and dependency review.
- [ ] Push the final candidate in a commit without a CI-skip marker. Run the full
  canonical release-branch qualification once, including all six images and
  retained final CLI/Admin/MCPB artifacts. Review the final diff and PR checks.
- [ ] Mark the release PR ready and merge with PR #101's commits preserved. Verify
  both PRs' merged state and that main contains the qualified release tree.
- [ ] Publish the exact qualified candidate using the existing release workflow;
  reuse its retained artifacts instead of rebuilding them.
- [ ] Verify public downloads/checksums/feeds, signatures, both image architectures
  and beta aliases, plus fresh install and upgrade preservation in disposable
  stopped homes using the published CLI.

PR #101's development checks passed on `35a946a8ea669ce021ed6877b7f3108c6a6af150`:
1,228 local tests, all six hosted image jobs, native Assistant suites on both
architectures, docs, Linux AppImage and Windows/macOS checks. That evidence does
not qualify future dependency changes or a new release stamp. Draft preparation
skips duplicate CI while the upstream release is unavailable; final qualification
is required before merge and publication.

With the new AKM pair installed, local development validation passed 1,236 tests
(nine opt-in image tests skipped), type checks, lint, documentation checks and
the reviewed audit. The raw audit retains the three approved findings. Final
candidate CI must supply the six native image jobs, provider/scheduler/history/
recovery checks, security scans and retained final CLI/Admin/MCPB artifacts.
The PR records the exact final SHA and successful run; this document does not
predeclare that qualification or publication succeeded.

Publishing does not update running instances or change recovery settings.
