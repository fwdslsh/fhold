# OpenCode v2 qualification

Implementation: `codex/opencode-v2`, October 10, 2026. Local execution is Linux
x64; public release builds and native ARM64 qualification run separately in
GitHub Actions. No live user instance is changed by this qualification.

## Pinned upstream packages

- OpenCode CLI, client and plugin API: `2.0.26`.
- AKM CLI: `0.10.26101002-alpha` (`next`).
- OpenCode v2, Claude and Codex AKM plugins: `0.10.26101002-alpha`.
- Native marketplace source: `ce90781946050d123d345d2aaf5ce053a31cd9b5`,
  archive SHA-256 `ded41c05b543017fdb3166b326a0d541f018299f9b535349ec5002293c2eea67`.

The final plugin refresh changes release metadata only relative to the earlier
qualified alpha. Native installation and hooks are unchanged; image tests still
verify the final exact versions. AKM's upstream stable-v1/v2 real-model matrix
remains tracked in [AKM #1049](https://github.com/itlackey/akm/issues/1049).
This beta intentionally uses the requested prerelease line, not a claim that
AKM 0.10 stable is released.

## Reproducible checks

| Check | Evidence and scope |
|---|---|
| Repository gates | `bun run check`, `bun run test`, `bun run lint`, reviewed `bun run audit`; CLI/Admin builds; shell syntax and all-profile Compose. Lint retains warnings; audit uses the existing documented exceptions. |
| Native configuration | `scripts/provider-settings-native.test.ts` uses an ordinary compiled-CLI install and controlled OpenAI-compatible server. Provider/model/agent/command/permission changes and plugin add/edit/remove become effective with unchanged PID/container and no reload. Atomic saves and restart persistence are covered. |
| Native Guardian | Same opt-in fixture exercises real MCP two-turn conversations, cross-credential denial, native chat/read policy, form label/value replies/cancellation, permission once/reject, and tool-free moderation without creating sessions. |
| Scheduler | Same fixture runs a real scheduled task through the native server, verifies completed AKM history and the saved result, and checks upgrade of the formerly shipped engine arguments without changing other settings. |
| Admin provider controls | `packages/electron/src/admin-providers-browser.test.ts` runs the actual renderer modules in headless Chromium (107 assertions); it is not vendor sign-in evidence. |
| Native harness plugins | `scripts/smoke-akm-harnesses.mjs` exercises real recalled context in OpenCode and executes all five AKM tools. Claude/Codex native recall and managed-hook registration are also exercised. |
| Native policy | `scripts/smoke-managed-policy.mjs` tests actual permission evaluation against conflicting settings, not configuration text alone. OpenCode uses native resource denials; no extra enforcement plugin. |
| Image lifecycle | `scripts/smoke-image.sh` checks native skills, non-root/managed mounts, authentication, restart persistence, optional failures and an operator catalog without the optional fhold source. Guardian and Portal startup smokes also pass. |
| Keep-alive | `scripts/smoke-keepalive.mjs` observes actual long-running native shell work and zero requests after idle. Scheduling is disabled independently. |
| Native transfer | `scripts/native-transfer.test.ts` covers 205-message pagination, parent/child transcripts, target preservation, retry after subsequent work, collision checks, v1 conversion, opt-in interrupted history and provider key/OAuth export/import without MCP credentials. |
| Recovery | `scripts/smoke-recovery.mjs` exercises directory checkpoints and v1-to-v2 replacement with both empty storage and a surviving home, then another restart. `scripts/smoke-blob-recovery.mjs` verifies Blob-emulator transport. Session/SQLite/custom path data, native state, exclusion rules and owner release are checked. |

Native provider and plugin tests use controlled local model responses and
synthetic credentials. They prove shipped native integration, not vendor
entitlement, live browser OAuth or current Discord/Slack bot delivery. Claude
and Codex remote connections remain experimental. Platform-specific ACA Stop,
revision deactivation and scale-to-zero tests belong in the deployment harness;
the product lifecycle regression does not claim those platform operations were
retested here. See [issue #21](https://github.com/fwdslsh/fhold/issues/21).

## Fixes found by qualification

- Defer periodic SQLite recovery capture until native API readiness. Lease
  renewal and final shutdown remain independent; startup migration no longer
  races a periodic snapshot for the database lock.
- Use v2 native permission actions and resource policies. Ordinary permission
  defaults are not an operator ceiling. Preserve existing files and document
  review of old mandatory-denial configuration.
- Replace the old scheduled `--attach` argument with `--server`; update only the
  exact previously shipped persisted engine automatically.
- Unwrap native response envelopes in memory capture, use the native Basic
  username, follow session/history cursors, and track shell lifecycle events.
- Exclude native MCP OAuth integrations from the AI-account picker.
- Wait for native asynchronous graph activation in qualification checks rather
  than treating an initially empty skill/agent inventory as final.
- Preserve unfinished history explicitly; native export otherwise omits it.
  The import receipt discloses native fork/revert/snapshot transfer limits.

## Simplification

Guardian no longer embeds/runs OpenCode or carries a provider credential copy.
Its classification uses native tool-free generation. Obsolete moderator assets
and the unused memory agent are removed. Native offline APIs replace direct
vendor-schema writes for history and provider credentials. One JSONC reader
serves native preferences. Unsupported symbol/TODO endpoints and v1-specific
fixtures are removed; meaningful behavior is covered by v2 native tests.
