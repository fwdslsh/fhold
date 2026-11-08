# Patched AKM beta — draft release plan

Target **0.4.1102-beta**, subject to a final unused-counter check. This is an
unpublished draft: component versions and dependency pins have not been advanced.
The release is waiting for the patched upstream AKM beta.

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

## Pending upstream dependency update

[AKM PR #1510](https://github.com/itlackey/akm/pull/1510) addresses locks on
filesystems without hard links, such as SMB, and deletion of usage events whose
entry has been removed. Wait for the reviewed fixes to be merged and published;
do not vendor the patch or pin an unreleased commit.

The current published selections are CLI **0.10.261112-beta** and plugins
**0.10.261111-beta**. Replace these with the actual patched releases after
checking plugin CLI requirements and release notes. Update both OpenCode plugin
manifests, the root lockfile, and the native Claude/Codex marketplace archive
revision/checksum when their new release is available. All runtime pins remain
exact and image-baked.

The [same-day dependency review](dependency-refresh-2026-11-08.md) records the
other selected versions, explicit holds and audit exceptions. Recheck required
compatibility/security changes for the selected patch; unrelated upgrades remain
separate. Upstream injected-filesystem tests are not evidence of a real SMB or
Azure deployment test.

## Before merge and publication

- [ ] Verify the patched CLI and compatible plugins are published; record exact
  versions, provenance and the included upstream fixes.
- [ ] Apply the pins and regenerate the lockfile; run affected native regressions
  and review audit results.
- [ ] Confirm the release counter is unused, stamp every component, and write the
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

Publishing does not update running instances or change recovery settings.
