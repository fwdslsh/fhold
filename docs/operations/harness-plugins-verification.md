# Native plugins and keep-alive verification

## OpenCode v2 and final 0.10 next pins — 2026-10-10

The new candidate uses OpenCode `2.0.26`, AKM CLI and all three harness plugins
`0.10.26101002-alpha`. Native v2 recall and all five AKM tools, trusted automatic
memory, scheduled task execution, operator policy and activity reporting are
covered by the [v2 qualification](opencode-v2-qualification.md).
The earlier sections below describe historical V1 candidates, not current
engine APIs or a claim of upstream AKM stable readiness.

## AKM 0.10 next-channel refresh — 2026-10-10

The official npm `next` tags select
[CLI 0.10.26101002-alpha](https://github.com/itlackey/akm/releases/tag/v0.10.26101002-alpha)
and [plugins 0.10.26101001-alpha](https://github.com/itlackey/akm-plugins/tree/f1ec39c0ebae38b6567b52434d64381ddc257efc).
All three harnesses use that plugin release and the same CLI. Its published V1
OpenCode plugin supports the unchanged OpenCode 1.18.34 and exact-pins that CLI;
the obsolete AKM dependency override is removed. Claude/Codex installation still
uses the standard native marketplace managers and an immutable checksum-verified
archive. No vendor code or plugin hooks are patched.

The real native session/prompt recall smoke passed in OpenCode, Claude and Codex.
Native managed policy passed for all three. Real Supercronic keep-alive sent two
requests during native work and zero while idle, with user scheduling disabled.
Directory recovery upgraded the published beta.5 image with both empty storage
and a surviving home/receipt. Sessions, SQLite, knowledge, custom paths, newer
surviving files and synthetic account/trust state survived; all three recalls
passed after restore and the upgraded checkpoint survived another restart.

The initial scheduler regression exposed AKM 0.10's removal of `task list` and
`task validate`. fhold now delegates listing to `search --type task` and validates
paused adoption through native, read-only `task explain`. Its small prompt-only
check parses YAML through Bun instead of matching source text with regexes.
The regression covers listing, quoted YAML, pause/resume, paused adoption,
unsupported source/engine/target rejection, preserved source files and keep-alive
cron preservation. Recovery evidence reads actual runtime files and versions,
not upstream private source-module paths that changed in 0.10.

The complete automated suite passed with socket tests enabled, alongside
typechecking, documentation tests and lint (existing warnings only). CLI, Admin
and MCPB builds passed. The separate real-engine provider check passed: native
settings apply without restarting the container and survive a normal restart.
The separate native history tests passed all four cases, including WAL export,
authority stripping, preservation of target sessions and retry recovery. Those
two opt-in image checks were run separately rather than counted as full-suite
coverage. Fresh CLI installation and all three Compose profiles also validated.

These local Linux x64 development checks use synthetic isolated data, not live
accounts or instances. They do not qualify vendor sign-in, OpenCode V2, ARM64,
or cloud autoscaling. Public images and downloads require the separate GitHub
release gates. April and other user instances were not changed.

## AKM 0.9 patch refresh — 2026-10-10

The latest stable 0.9 releases were checked against the official npm registry
and GitHub releases: [CLI 0.9.31](https://github.com/itlackey/akm/releases/tag/v0.9.31)
and [plugins 0.9.30202610090106](https://github.com/itlackey/akm-plugins/releases/tag/v0.9.30202610090106).
All three plugins were already current. The CLI pin and standard workspace
dependency override now select 0.9.31, including OpenCode's in-process copy.
No vendor code, hook definitions or native installation process changed.

Local Linux x64 image `fhold/fhold-assistant:akm-0.9.31-test`, built from
`21e2780`, passed the standard Assistant smoke: real OpenCode, Claude and Codex
session/prompt recall, matching resolved AKM versions, preserved customized
native settings and actionable optional-failure warnings. Managed-policy checks
passed. Real cron-driven keep-alive sent two requests during native work and
none while idle, with user scheduling disabled.

The repository suite passed **742 tests, zero failures and eight opt-in skips**.
The separately enabled image-backed native-history suite passed all four tests.
Type checks, lint (39 existing warnings), reviewed dependency audit, CLI/Admin
builds, disposable CLI installation, all-profile Compose and local docs links
passed. Directory recovery upgraded the published beta.4 image into both empty
storage and a surviving home, preserving sessions, SQLite, custom paths and
synthetic account/trust state; all three native recalls also passed after restore.

This is an unpublished local development image, not a new release, live
vendor-account qualification or a lab-instance upgrade. AKM 0.10 prereleases and
OpenCode V2 remain outside this dependency refresh.

## 0.2.2610081-beta.1 local candidate — 2026-10-08

The local Linux x64 Assistant candidate
`fhold/assistant:release-0.2.2610081-beta.1` passed the standard image smoke.
Real OpenCode, Claude and Codex session/prompt hooks recalled the same fixture
knowledge with AKM **0.9.30** and plugin **0.9.30202610090106**. The image uses
the normal pinned OpenCode package and native Claude/Codex marketplace installers;
no startup installation or replacement harness loader was used.

The full local suite passed **710 tests, zero failures, one opt-in skip**, with
image-backed native history enabled. The skipped controlled native-provider
test then passed separately using the current compiled CLI, the same image bytes
under a standard local-build tag, and a local HTTP model fixture. It verified
native AI settings take effect without restarting the container and survive a
normal restart; it does not qualify a vendor account or real model inference.
Type checks, lint (39 existing warnings), locked dependency audit with its two
previously reviewed exceptions, CLI/Admin/MCPB builds, shell syntax, disposable
CLI installation/all-profile Compose, and docs build/check/tests passed.

`smoke-recovery.mjs` upgraded the published **0.1.2610081904-beta.2** image to
the candidate with both an empty ephemeral layer and a surviving native home/
receipt. Native sessions, knowledge, synthetic account/trust files, custom
paths, SQLite snapshots and independent mounted data survived, including the
next candidate restart. `smoke-blob-recovery.mjs` passed against Azurite; this is
emulator semantics, not live cloud identity/autoscaling qualification.
The recovery scripts now keep warning stderr separate from machine-readable
stdout through Node's standard subprocess API; an initial combined-stream parse
failure and its successful rerun are not evidence of lost data.

The native managed-policy smoke passed for all three harnesses. The real
OpenCode/cron keep-alive smoke observed three requests during work and zero
while idle, with unsigned-in default-on workers waiting and user scheduling off.
Both remote integrations remain experimental. These are local development-image
results; public multi-architecture images and Linux downloads require their own
GitHub workflow, signing and checksum verification. No live user instance was
changed by this qualification.

## beta.2 unsigned-in lifecycle regression — 2026-10-08

The standard Assistant image smoke now leaves both remote supervisors at their
default-on setting. Their installed native CLIs report missing sign-in; both
supervisors wait in `sign-in-needed` without starting accountless workers.
The offline keep-alive image smoke verified a real OpenCode shell task generated
two cron-driven authenticated requests, with zero requests during the idle periods
before and after. No synthetic activity markers or worker-disable workaround was
used. The local full suite passed 704 tests, with three opt-in skips.

Native OpenCode, Claude and Codex AKM recall passed independently of account
sign-in. CLI/Admin builds and type/lint checks passed. These local Linux x64
development-image checks do not qualify cloud autoscaling, native vendor-account
validity or a signed-in remote client; those remain separate from the repository's
native amd64/arm64 CI and published artifact checks.

## Earlier local development qualification — 2026-10-04

Local Linux x64 branch verification on 2026-10-04. These are development images,
not published releases or evidence of GitHub CI/cloud autoscaler qualification.

The combined dependency-refresh / harness-plugins candidate is
`fhold/assistant:0.1.2610040740-alpha.3`
(manifest `sha256:df80b309163cdd39ff41587260c689529d2cbb32916c065544338da2db57dfc1`).
Guardian and Portal used the same candidate version.
All three image startup/security smokes passed. The Assistant smoke verified
native AKM recall and fhold activity hooks in OpenCode, Claude Code and Codex,
native Codex hook approval boundaries, `/home/fhold`, username `user`, skill
discovery, and failed attempts to create, overwrite or chmod `/fhold-bundle`.
It also restarted with an older AKM catalog lacking the optional built-in
source, verified that catalog remained byte-for-byte unchanged, and verified
the native API and built-in skills still worked. Native fhold plugin cache
versions now track the release through the existing release manifest/stamper.

`node scripts/smoke-keepalive.mjs <assistant-image>` passed with networking
disabled: a real OpenCode shell task ran for 45 seconds while the existing
Supercronic process sent three authenticated HTTP requests to a local receiver.
The idle periods sent zero requests. User task scheduling remained disabled.
This test uses the shipped plugin, scheduler and API; it does not inject
activity markers or supply missing product configuration. An append-only
`noReply` API message was also verified not to leave the instance busy.

The full combined repository suite passed **496 tests, zero failures and zero
skips**, including image-backed native history recovery. New regressions cover
OpenCode append-only messages, failed/overlapping tools and session deletion,
Claude batch-completed denied/cancelled tools, and parent background-work
completion after a subagent stops. Native AKM activation,
pause, resume and removal preserved the heartbeat cron entry.
Type checks, lint, compiled CLI build, Admin bundle, changed-shell syntax and
all-profile Compose validation passed. The rendered Compose keep-alive overlay
also passed the product security audit. Host checks used Bun 1.4.2 and Node
24.18.0; image checks verified Bun 1.4.2, Node 24.21.0, npm 12.2.0, AKM 0.9.24
and all three AKM plugins at 0.9.21202610040615.

Both `scripts/smoke-recovery.mjs` and `scripts/smoke-blob-recovery.mjs` passed
with `FH_RECOVERY_TEST_IMAGE=fhold/assistant:0.1.2610040740-alpha.3`.
They verified periodic and graceful checkpoints, empty-layer replacement,
custom paths/SQLite, native history and synthetic account/trust restoration,
with user scheduling disabled. Blob qualification used Azurite 3.37.0; its API
version check is disabled for the SDK's newer API, so this is emulator semantics
coverage, not Azure service qualification.

Trivy 0.75.0 reported no critical vulnerabilities in this Assistant candidate.
The fixable-high gate still reports three bundled npm dependency advisories:
`CVE-2026-102276`, `CVE-2026-102278` (brace-expansion 5.0.9) and
`CVE-2026-19534` (undici 6.28.0). npm is already the stable 12.2.0 release.
No vendor dependency patch or security exception was part of this earlier
candidate's verification. The subsequent public alpha includes the owner's
explicitly approved [narrow release exceptions](release.md#reviewed-runtime-advisories);
that approval does not change this candidate's raw scan results.

No real model-provider request, signed-in Claude/Codex remote session, ARM64
runtime, rendered Admin, live cloud scale-in or deployment was qualified here.
Native startup/recall tests use disposable accounts and intentionally unavailable
model endpoints. The conditional heartbeat remains best-effort activity
signaling; the host owns its autoscaling and shutdown policy.
