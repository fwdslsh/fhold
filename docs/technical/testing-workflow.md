# Testing workflow

Run from a fresh locked checkout and use disposable explicit fhold homes.
Never select an existing user installation for a test.

Compiled CLI tests invoke the normal shipping build, including the embedded
Skeleton, before exercising installation and multi-instance selection with a
private operator home. They do not require artifacts from an earlier local build
or inject a repository-assets fallback into the installed CLI.

```bash
bun install --frozen-lockfile
bun run check
FH_SOCKET_TESTS=1 bun run test
bun run lint
bun audit # Raw report; the MSAL and MCPB Zod advisories remain.
bun run audit # Exact reviewed MSAL/Zod exceptions; not a clean-audit claim.
bun run --cwd packages/cli build
bun run --cwd packages/electron bundle
bun test scripts/packaged-assets.test.ts
bun run --cwd packages/claude-desktop pack
bash -n scripts/dev-setup.sh containers/assistant/entrypoint.sh
```

The shared `.github/workflows/gates.yml` retains check/test/lint, artifact builds,
all-profile Compose validation, native architecture image builds, vulnerability
gates and startup/security smoke. GitHub is the canonical CI host; record actual
workflow results before claiming a candidate passed GitHub gates.

`scripts/ci-scope.mjs` selects verification from the PR merge-base (pushes use
their before/after commits). Missing or unreadable diffs select all checks.

| Changed inputs | Source checks | Native container checks | Admin packages |
| --- | --- | --- | --- |
| Docs/site or lockfile only | Separate docs workflow where applicable | None (repository policy) | None |
| Admin, CLI or shared management library | Tooling checks | None, except runtime seed-manifest changes | Linux preview and Windows/macOS desktop checks |
| Portal source/Dockerfile only, optionally docs | Full source checks | Portal on amd64 and arm64 | None |
| Runtime/shared dependency, Skeleton, root manifest, security/harness/orchestration or unknown inputs | Full source checks | All three images on both native architectures | When Admin or shared/unknown build inputs change |

Mixed lock changes use the dependency graph, including workspace, peer, optional
and integrity edges; runtime changes select all images. CI validation scope is
separate from publication scope: editing orchestration exercises the native gates
without requiring publication of unchanged container bytes. A full release still
requires all six native image jobs on its exact final SHA. Partial or skipped CI
cannot qualify it; the release workflow runs missing full qualification itself.

Assistant verification uses two lanes with separate disposable fixtures. Startup,
security and native harness coverage runs once, with additional small explicit-on
and explicit-off startup assertions. Keepalive and quiet-work observation periods
are unchanged. The remaining workload, policy, history, provider/Guardian/scheduler,
directory/Blob recovery and both upgrade cases remain required. Each suite gets a
log and timing; failures wait for the other lane and make the job fail. Cancellation
terminates the process groups; GitHub disposes the isolated runner and its Docker
fixtures. Failed/cancelled jobs never qualify a release. Local runs should use a
disposable Docker host if interruption could prevent suite cleanup.

## Download a PR's Admin for manual testing

PRs targeting `main` with affected Admin inputs get an independent **PR Admin
AppImage** build, including drafts. Admin inputs include its shared library, CLI
management helpers, embedded Skeleton and build/install configuration. Docs and
unrelated Portal source changes skip the build. Opening, reopening, updating
commits or retargeting a PR recomputes that scope; title/body edits do not rebuild
or cancel the current build. The preview uses the exact head commit. New commits
cancel an older build still in progress for that PR.

On the PR, open **Checks → Download Linux AppImage (x86_64) → Details**. The run's
summary has a **Download the Linux x86_64 AppImage** link; the same file is listed
under **Artifacts**. Sign in to GitHub to download it. Downloads are retained for
14 days and are named `fhold-admin-pr-<number>-<commit>-x86_64-linux.AppImage`,
so different PRs/updates are distinguishable. This is a direct AppImage download,
not a ZIP; mark it executable and launch it:

```bash
chmod +x fhold-admin-pr-<number>-<commit>-x86_64-linux.AppImage
./fhold-admin-pr-<number>-<commit>-x86_64-linux.AppImage
```

The workflow uses the normal locked Admin build and packaged renderer/bridge
startup smoke, without waiting for container CI. It publishes no release,
container image or version tag. Preview Admin builds retain the published runtime
image defaults; they do not include unpublished container changes from the PR.
Use a disposable instance when testing. This check is not full release qualification.
Fork PRs use the same read-only workflow without secrets; GitHub may first require
maintainer approval for a new contributor's workflow run.

## Local integration coverage

Materialize a disposable `FH_HOME` with `install --no-start`, then use
`docker compose` with its managed stack, operator overlay and derived env.
Validate `--profile gateway --profile discord --profile slack config --quiet`
even when no Docker daemon is available.

Required behavior coverage includes instance isolation, read-only inspection,
credential-scoped MCP/handles, path/descriptor escape refusal, moderation fail-closed,
portal default-deny, own-backup manifest/hash/conflict/partial-retry preservation,
native-history WAL/collision checks, restricted tasks, memory and native trust.
Guardian's real HTTP MCP regression waits through thirteen seconds of unchanged
progress and verifies one submission with a delivered final answer. Portal tests
cover reconnecting to the same job, lost initial responses, bounded failed
recovery, partial answers, terminal/native/authentication rejection and explicit
approval/cancellation without replay. Slack tests preserve native Markdown after
Stop cleanup and exercise explicit unsupported-block fallback. Assistant launch
fixtures verify exact environment aliases, ordinary tool-child inheritance,
clean scheduler/remote launches and optional-error isolation without logging values.

The Assistant's conditional heartbeat has a separate offline image check:
`node scripts/smoke-keepalive.mjs fhold/assistant:<candidate>` starts a native
OpenCode shell task and observes real Supercronic HTTP requests while work is
active, then verifies requests stop when idle. It also checks that user tasks
remain disabled. This qualifies local activity signaling, not a cloud autoscaler.

Admin's lightweight DOM suite checks CSP, masking, IPC, preview invalidation,
accessibility decisions and unchanged window size. The rendered E2E checks real
Chromium/OpenCode links, MCP details, keyboard focus and setup/backup journey,
including Welcome's explicit new-instance path, duplicate-name refusal and two
healthy named agents at once with matching OS hostnames and separate ports.
It also checks the sidebar's named recent-instance picker, its Welcome route,
Overview's home/status details, and automatic status recovery without a footer
or manual Refresh button. Background checks must preserve unsaved forms and
transient keys and pause while the window is hidden or an operation is active.
A passing bundle/static suite does not prove rendered or packaged startup.
See [Admin verification](../operations/admin-setup-verification.md).

Image-backed history tests require the newly built Assistant image:
`FH_NATIVE_TEST_IMAGE=fhold/fhold-assistant:<frozen-version> bun test scripts/native-transfer.test.ts`.
Set `FH_HISTORY_SOURCE_IMAGE` to a cached v1 Assistant image to additionally
verify upstream v1-to-v2 history and credential migration on private copies.
Release gates must run image cases, not silently skip them. Real provider,
MCP/portal, scheduling and all three AKM harness checks are separate integration
evidence; mocked tests cannot certify them. Record exact commands/results,
skips and prerequisites. Windows/macOS native packaging remains deferred.
