# Managed harness policy verification

## Initial branch qualification

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

## Integration review against main

The branch was reviewed against main `61ebba7` on 2026-10-04, preserving the
single `--name`/`-n` instance selector. The review retained native managed files
and standard plugin installation; no vendor patches, cloud adapters, startup
installs or alternative permission store were added.

Review changes and checks:

- An incompatible old image could lose all its hooks when given the new
  managed-only policies. This was reproduced with the published alpha.3 image.
  CLI/Admin now check the image's managed-policy capability before activation;
  active updates check before replacing managed files. A real compiled-CLI
  attempt rejected alpha.3 without starting containers. Missing-image handling
  preserves local-build and explicit no-pull behavior.
- A fresh compiled-CLI installation with the matching candidate reached healthy
  status and was stopped with the CLI. Its temporary container/network were
  removed; no existing instance was changed.
- Operator-defined Codex and Claude hooks were supplied through ordinary native
  policy mounts and executed alongside the built-ins. The expanded policy smoke
  also checked Guardian chat/read and scheduled-agent restrictions under a broad
  global OpenCode permission, including protected knowledge paths.
- Upgrade regression tests seed missing policy files, preserve edits and leave
  native account preferences alone. Portable backups now explicitly name the
  excluded operator policies. The guide explains custom-hook behavior, plugin
  coexistence, image compatibility and how to reapply deployment policy.
- Managed recall that is not fully enabled no longer claims verification success
  or presents personal approval as a remedy. CLI/Admin point to instance policy.
- Hook registration tests preserve native arguments, literal shell data,
  matchers/timeouts and Codex plugin-data paths; unsupported handler formats fail
  the build rather than silently losing an integration.

Host checks used Bun 1.4.2 and Node 24.18.0: type/lint checks, CLI/Admin builds,
523 passing suite tests with socket cases enabled, and all four native-history
tests separately. The two conditional history cases in the suite are included
in that separate image-backed run. All Compose profiles and shell syntax passed.

`fhold/assistant:policy-review-20261004` passed the full startup/security/harness
smoke and the compiled-CLI installation. Its final local image identity was
`sha256:a4501ef371c02abf1ef7ad1ab16a8ad7e469cd5dc0a4ef4275e5776865477dba`.
The native-policy, ephemeral-recovery, history and real keep-alive tests passed
against the same runtime filesystem; the final rebuild added only the capability
label. Keep-alive produced two requests during active work and none while idle.

This remains local, credential-free qualification, not a new release or a claim
of live provider authentication, remote pairing, cloud scaling or ARM64 execution.
The reusable GitHub gates also run the native-policy smoke for each architecture.
