# Beta.12 reliability qualification

Candidate `0.2.2610152-beta.12` addresses
[Codex startup activity coverage (#38)](https://github.com/fwdslsh/fhold/issues/38)
and [Portal restart recovery (#39)](https://github.com/fwdslsh/fhold/issues/39).
The source starts from canonical main
`32e0bafa3f86830379c3b468225a15d729cc5c74`.
This report records local Linux x64 evidence collected October 15, 2026;
the PR's canonical push CI must additionally qualify its final commit.
The subsequent [dependency review](dependency-refresh-2026-10-15.md) advances the
candidate to build 3 and records qualification of the refreshed dependency set.

## Codex startup coverage

The existing supervisor connects to the running native Codex 0.162.1 app-server's
private Unix WebSocket. It verifies the image's exact managed activity hooks
through `hooks/list`, then requires a complete empty `thread/loaded/list` response
and a still-running worker before establishing initial coverage. A failed,
incomplete, unmanaged or nonempty observation stays conservative. No session,
trust record, approval, native configuration change or second server is created.

The image-backed AKM harness smoke starts and replaces the actual unsigned native
app-server using a disposable profile. Both starts establish managed hook coverage
without creating a thread or fabricating SessionStart. Existing real native recall
checks pass for OpenCode, Claude Code and Codex. Focused regressions also exercise
the native Unix WebSocket transport, timeout/abort, loaded threads, partial inventory,
unmanaged hooks and a worker exiting during inspection.

Real OpenCode shell work still drives conditional Supercronic keepalive: two active
requests and zero idle requests were observed, with user schedules disabled and
unsigned remotes permitting idle. This does not certify a signed-in vendor-client
reconnect, hosted autoscaling, or an hours-long quiet Codex turn. Perform those
account-dependent checks separately; observation failure must continue sending
keepalive and busy work must never expire merely because it is quiet.

## Portal replacement

Private SQLite receipts preserve submission intent, accepted job handles, final
answers and acknowledged platform messages. Reopened adapters inspect the same
job and edit known messages; current identity, credential fingerprint and access
rules are checked before delivery. Refreshed controls require the original requester
and call Guardian's native interaction API. Approval decisions are never saved.

The Portal suites pass 70 tests, including adapter replacement for Slack and
Discord, recovery of pending permission and Stop controls, cached final delivery,
repeated replacement, access revocation, expired handles and uncertain sends or
submissions. A native Node process is killed with SIGKILL after its synchronized
SQLite checkpoint; a fresh SQLite connection reads the accepted job and message receipt.
The built Portal also passes its native Node SQLite, controlled Slack heartbeat,
mention/acknowledgment and automatic reconnect smoke.

These use controlled transports and SDK fixtures, not new live Slack/Discord
account conversations. Qualify real bot replacement during running work, a question,
a permission decision and final delivery separately. See
[the recovery contract](../portals/restart-recovery.md) for bounded deduplication,
blocked ambiguous outcomes, private data retention and required operator follow-up.
The original Guardian job must remain valid; simultaneous Guardian replacement is
not recovered by resubmitting work. Let beta.11 Portal jobs finish before upgrading,
because older versions did not write these receipts. Existing conversation mappings
and native history remain intact.

## Local candidate checks

- Six package type checks and full source suite: 854 passed, zero failed.
  Five opt-in native provider/history cases are skipped in that source invocation;
  the canonical full CI runs them separately against its built Assistant.
- Lint: passed with warnings; strict docs check and docs build: passed.
- Standalone CLI build, Admin bundle and unsigned MCPB pack: passed. Compiled CLI
  reports the candidate version; all Compose profiles validate from a fresh,
  disposable compiled-CLI installation.
- Assistant and Portal development images: built and startup/security smokes passed.
  Native AKM harness and conditional keepalive checks passed as described above.
- Both images pass the unchanged critical and fixable-high Trivy gates with the
  existing reviewed npm exceptions. The dependency audit passes with its two
  existing scoped exceptions. No exception or dependency was added or widened.

Local image tags are `fhold/assistant:beta12-fixes-dev` and
`fhold/portal:beta12-fixes-dev`, with `ci`/`development` build metadata. They exercise
the changed runtime but are not published release identities. GitHub must build
and qualify native amd64/arm64 images on the frozen candidate SHA; publication
then reuses eligible successful exact-SHA CI rather than repeating full validation.
Normal artifact, checksum, signing and publication gates still apply.

No existing stack, account credential or user conversation was used for destructive
tests. No fleet update or release publication is claimed here. Native ARM64 Admin
startup remains a separate unqualified item tracked by
[issue #40](https://github.com/fwdslsh/fhold/issues/40).

The first unpublished build, `0.2.2610151-beta.12`, was superseded before completing
CI when final review found a shorter-prompt recovery edge case. Build 2 adds Slack
and Discord regressions proving surplus old controls are closed and the current
message owns the new controls. The earlier run is not qualification for build 2.
