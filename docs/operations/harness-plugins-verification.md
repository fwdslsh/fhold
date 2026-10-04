# Native plugins and keep-alive verification

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
No vendor dependency patch or security exception was added. The source branch
is not a release-security qualification; merge/release approval remains pending
resolution of that gate.

No real model-provider request, signed-in Claude/Codex remote session, ARM64
runtime, rendered Admin, live cloud scale-in or deployment was qualified here.
Native startup/recall tests use disposable accounts and intentionally unavailable
model endpoints. The conditional heartbeat remains best-effort activity
signaling; the host owns its autoscaling and shutdown policy.
