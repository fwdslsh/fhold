# Azure management qualification

Checked October 22, 2026 UTC on `codex/azure-management`, based on main
`ec42455`. This is host-side management of existing Container Apps, not a new
Assistant image or a provisioning/deployment system.

## Evidence

- Full regression run: 938 passed, five opt-in native-image tests skipped.
  All package type checks, CLI build, Admin bundle, the focused Chromium UI test
  (137 assertions), documentation checks and all-profile Compose validation
  passed. Lint passed with warnings; the existing two reviewed audit exceptions
  remain unchanged. No dependencies or runtime pins changed.
- Native Azure CLI 2.91.0 with Container Apps extension 1.3.0b4: account and
  resource-group checks, discovery of seven existing fhold apps, revision status,
  zero-replica observation, system logs and subscription/resource-group choices.
  Queries projected metadata only; no environment, secret or storage values were
  read. No agent HTTP request was made and no app was started, stopped or changed.
- Actual bundled Electron 44.9.3 Admin and compiled Linux x64 CLI: a private
  connection profile, automatic discovery, instance selection, native platform
  status/logs, connection editing and scope loading. The selected scope survived
  refresh. Window geometry stayed 1120 × 780 throughout the walkthrough. No
  renderer/preload API was replaced for this live walkthrough.
- Adapter/CLI tests cover native argument arrays, no global account change,
  recognition/scope boundaries, malformed responses, partial diagnostics,
  confirmation, stale/multiple revision selection, no mutation replay, log
  target selection, console invocation and preservation of unknown native logs.
  Renderer tests cover setup choices, native-only setup and refresh behavior.

Live checks found and corrected two issues in the previous adapter: system logs
require `--format json` (JSONL), whereas console logs support text; and Azure
reports `ScaledToZero`, not only the older `ScaledTo0` spelling. An absent replica
count now remains unknown rather than being presented as zero.

## Limits

Existing sign-in was used; a new browser sign-in, interactive cloud console,
Start/Stop/restart, vendor reconnect, recovery checkpoint and real writer drain
were **not** exercised against these existing apps. Mutating calls are covered
by adapter tests and the documented native commands, not claimed as live Azure
qualification. Request acceptance remains separate from readiness/completion.

No resources, images, scale settings, mounts, credentials, user data or recovery
owners were changed. Container/native-runtime acceptance remains a separate gate;
this change does not rebuild or requalify those images. Docker's full instance
settings/import/export are not emulated for ACA. Use the agent's native interface
and your existing deployment tooling for operations outside the adapter's scope.

See [hosted management](../hosting.md#azure-container-apps-experimental) for the
normal CLI/Admin path and [provider architecture](../technical/hosting-provider-architecture.md)
for the extension boundary.
