# Managed harness policy verification

Local Linux x64 verification on 2026-10-04, branch
`codex/managed-harness-policy`, based on public main `c6c5487`.
This is a development change, not a published release or GitHub CI result.

The local image is `fhold/assistant:managed-policy-20261004`. The final startup
and restart smoke used image ID
`sha256:d6de8f2298fbaf33b08e0a9bba2355eda39a1c2b75d3312a93742f09918a4ebf`.
The permission, recovery and keep-alive checks also passed for this runtime
implementation; the final image refresh changed only bundled setup guidance.

## Passed checks

- `bun run check`, `bun run lint`, compiled CLI build and Admin bundle.
- `FH_SOCKET_TESTS=1 bun run test`: 514 passed. Its two conditional native-history
  cases were run separately with `FH_HISTORY_TEST_IMAGE` set to the candidate:
  all four history tests passed, including both previously skipped cases.
- A final focused CLI/Admin/assets run: 62 passed after the guidance changes.
- Fresh `install --no-start` and Compose validation with gateway, discord and
  slack profiles together; changed shell syntax and Git whitespace checks.
- `bash scripts/smoke-image.sh <image> assistant`: normal authenticated startup,
  non-root runtime, native SDK/dependencies, built-in skills, read-only bundle,
  all three real harnesses, restart preservation and older AKM catalog support.
- `node scripts/smoke-managed-policy.mjs <image>`: read-only system policy files;
  supplied Codex default and enforced effective session policy despite a
  conflicting user default; OpenCode managed permissions overriding conflicting
  inline values; Claude managed mode/deny overriding conflicting user settings.
- Real Codex reports all 11 built-in hooks as system-managed; all expected AKM
  and fhold handlers are enabled without `trusted_hash` records. Unmanaged hooks
  are suppressed; personal approve/disable requests are refused. Real Claude and
  Codex prompt recall execute once, with no duplicate plugin handler execution.
- `FH_RECOVERY_TEST_IMAGE=<image> node scripts/smoke-recovery.mjs`: periodic and
  graceful checkpoints, fresh-layer replacement, custom paths/SQLite, synthetic
  account/trust state, native data integrity and real AKM harness recall.
- `node scripts/smoke-keepalive.mjs <image>`: native OpenCode work drives actual
  Supercronic HTTP requests; two requests while active and zero while idle,
  with user schedules disabled.

Host tests used Bun 1.4.1 and real Node 24.19.0. Image tests verified its pinned
Bun 1.4.2 and native harness versions (OpenCode 1.18.34, Codex 0.160.0,
Claude Code 2.1.289). The host's Bun-backed `node` shim was excluded from tests
that require real Node; the product image already supplies real Node.

These tests use disposable instances and synthetic account data. They prove
native loading, permissions, recovery and local activity signaling without
claiming real account sign-in, provider/model responses, remote-client pairing,
Azure scaling behavior, ARM64 execution or a release vulnerability scan.
No live deployment, published image or vendor-specific provisioner was changed.
