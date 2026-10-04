# Native plugins and keep-alive verification

Local Linux x64 branch verification on 2026-10-04. These are development images,
not published releases or evidence of GitHub CI/cloud autoscaler qualification.

The Assistant candidate is `fhold/assistant:dev-harness-plugins-2610040650`
(manifest `sha256:95d36e1e960cca5f0f2c7fb3484b3acea0d303fe673a1ee948ccc3abe0ab7c0b`).
Guardian and Portal used `dev-harness-plugins-2610040624`.
All three image startup/security smokes passed. The Assistant smoke verified
native AKM recall and fhold activity hooks in OpenCode, Claude Code and Codex,
native Codex hook approval boundaries, `/home/fhold`, username `user`, skill
discovery, and failed attempts to create, overwrite or chmod `/fhold-bundle`.

`node scripts/smoke-keepalive.mjs <assistant-image>` passed with networking
disabled: a real OpenCode shell task ran for 45 seconds while the existing
Supercronic process sent two authenticated HTTP requests to a local receiver.
The idle periods sent zero requests. User task scheduling remained disabled.
This test uses the shipped plugin, scheduler and API; it does not inject
activity markers or supply missing product configuration.

The full repository suite passed 487 tests, including image-backed native
history recovery, before the final reporting-error and Compose-audit checks.
After those additions, all 28 focused keep-alive, approval and audit tests,
and all nine Assistant runtime/scheduler tests passed. Native AKM activation,
pause, resume and removal preserved the heartbeat cron entry.
Type checks, lint, compiled CLI build, Admin bundle, changed-shell syntax and
all-profile Compose validation passed. The rendered Compose keep-alive overlay
also passed the product security audit. Host checks used Bun 1.4.1 and Node
24.19.0; image checks verified the pinned Bun 1.4.2 and Node 24.21.0.

`FH_RECOVERY_TEST_IMAGE=fhold/assistant:dev-harness-plugins-2610040634 node
scripts/smoke-recovery.mjs` passed on the preceding candidate with the same
home/bundle layout. It verified periodic and graceful checkpoints, empty-layer
replacement, native SQLite/history and synthetic account/trust restoration,
with user scheduling disabled. The final candidate additionally contains
non-blocking OpenCode reporting-error handling, checked by its native smoke.

No real model-provider request, signed-in Claude/Codex remote session, ARM64
runtime, rendered Admin, live cloud scale-in or deployment was qualified here.
Native startup/recall tests use disposable accounts and intentionally unavailable
model endpoints. The conditional heartbeat remains best-effort activity
signaling; the host owns its autoscaling and shutdown policy.
