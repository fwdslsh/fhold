# OpenCode 2 migration: fhold agent handoff

Status: implementation and qualification in progress on `codex/opencode-v2`.
Updated 2026-10-10. Native live settings and plugin watching are qualified on
Linux x64; the complete migration is not yet qualified or released. Published
AKM 0.10 prerelease artifacts are now available; the upstream dependency is no
longer waiting for publication.

## Objective and starting point

Move fhold to a pinned OpenCode 2 release without losing sessions, knowledge,
scheduled work, native configuration or working app connections. Keep the
single-container Assistant and current optional Guardian/Portal architecture.
Work on a feature branch; this brief does not authorize changing live instances
or publishing a release.

The published baseline is fhold `0.2.2610102-beta.5`, still on OpenCode V1,
with `akm-cli@0.10.26101002-alpha` and native harness plugins
`0.10.26101001-alpha`. The implementation candidate pins `2.0.26` for
`@opencode/cli`, `@opencode/client` and `@opencode/plugin`, with
`akm-opencode-v2@0.10.26101001-alpha`. Refresh upstream versions, release status
and contracts before changing those pins.
The existing `@opencode-ai/sdk/v2` import is a namespace in the old SDK, not proof
of OpenCode 2 compatibility.

This is not a dependency-only update. Upstream identifies incompatible plugin
and server interfaces, while retaining supported configuration, agents, commands
and skills. See the [native migration guide](https://opencode.ai/v2/docs/migrate-v1).
The prerequisite AKM work has a separate
[agent handoff](akm-opencode-v2-migration-handoff.md).

The upstream dependency is tracked in
[itlackey/akm#1049](https://github.com/itlackey/akm/issues/1049). Before qualifying
or releasing this migration, obtain the published compatible AKM CLI and
OpenCode 2 plugin artifacts, their exact pins and the native V1/V2 compatibility
receipt. That upstream work includes required V1 dispatch/history support and
separate V1/V2 plugin artifacts sharing the current AKM core. Do not bypass this
dependency with a downstream plugin fork, vendor patch or startup install.

Read [AGENTS.md](../../AGENTS.md), [core principles](core-principles.md),
[recovery](../assistant-recovery.md) and [release gates](../operations/release.md)
before implementing.

## Qualified live settings and plugin behavior

OpenCode 2.0.26 has a settings read API and a narrowly scoped write API:
`GET /api/config` reads normalized documents; `PATCH /api/experimental/config`
supports `shell`, not arbitrary provider/model/plugin updates. Do not send the
old generic global-config PATCH or add a proxy to recreate it. The normal
native file watcher is sufficient for these preferences.

The image-backed regression uses the published native client and a normal
CLI-created managed Compose install. It also runs against a standalone
Assistant. Ordinary atomic saves are used throughout, not inode-preserving
test repairs. These checks passed with the same OpenCode PID and container,
without calling reload/dispose or restarting:

| Change | Verified native outcome |
| --- | --- |
| Add/edit a provider, endpoint and model; choose a default | Both global and workspace inventories update; explicit response tests use the selected model and edited endpoint. |
| Change shell, agent instructions and command definitions | Native configuration, agent and command reads show the new values. |
| Change permission rules | A session created before the edit changes from deny to allow through native permission evaluation. |
| Add a local plugin | Native registration becomes active and its agent transformation is visible. |
| Atomically replace plugin source | Its transformation changes and the previous registration's cleanup executes. |
| Edit a plugin's native options | Its transformation uses the new option and the previous registration is cleaned up. |
| Remove the plugin | Its registration disappears and its cleanup executes. |
| Restart normally afterward | The chosen model, endpoint preferences and native credentials persist. |

The managed installation now mounts `config/assistant/` as a normal writable
native user-config directory. `OPENCODE_CONFIG` selects its existing preferred
file. Image-baked plugins under `/etc/opencode` and operator policy remain
read-only. A single writable file nested in a read-only directory cannot
support ordinary atomic editor saves reliably; that old bind pattern has been
removed, not worked around.

Admin saves narrow JSONC-preserving native preference edits and confirms the
effective result through native read APIs. It does not trigger a location
reload. Saved-but-unconfirmed edits are reported without restoring an old
client snapshot. Native integration/credential APIs still own account secrets.
The first explicit response test waits briefly for native model activation,
then makes one tool-free generation request; a billed failure is not retried.

Restart boundaries remain explicit: selecting a different `OPENCODE_CONFIG`
filename, changing container environment/mounts/ports, upgrading the image-baked
OpenCode/AKM/plugins or replacing read-only operator policy requires managed
activation. Editing the already-selected user settings file, a local user
plugin or its options does not. Hot application does not promise
to undo a running tool or retroactively change a request already submitted.

Repeat with a CLI built from this branch and its freshly built candidate image:

```bash
bun run --cwd packages/cli build
FH_NATIVE_PROVIDER_TESTS=1 \
FH_NATIVE_PROVIDER_CLI=/absolute/path/to/packages/cli/dist/fhold-cli \
FH_NATIVE_PROVIDER_IMAGE=namespace/fhold-assistant:locked-candidate-tag \
  bun test scripts/provider-settings-native.test.ts
```

The test invokes `scripts/smoke-opencode-v2-live.mjs` inside the untouched image,
uses synthetic credentials and a controlled OpenAI-compatible endpoint, and
retains a redacted report under its printed disposable home. It makes no vendor
requests and changes no live instance. This proves native settings/transport
behavior, not vendor OAuth entitlement, every plugin package's behavior or the
remaining full migration gates below.

## Constraints

- Use upstream installation, APIs and plugin registration. No vendor patches,
  new services, compatibility proxy, startup installs or test-only environment
  repairs. Keep native commands available through the ordinary image PATH.
- Preserve native approvals, provider ownership, managed harness policy and
  explicit off choices. Codex/Claude remain experimental; do not redesign their
  account or remote-worker flows for this migration.
- Preserve Guardian authentication, moderation, credential policy, session
  ownership and secret/path boundaries. A changed native API must not weaken them.
- Keep operator configuration seed-once and release-owned assets allowlisted.
  Convert only configuration that actually needs conversion.
- Use disposable homes and synthetic history first. Real accounts, paid model
  requests and live cutover require the owner's authorization. Never run V1
  against migrated state or automatically downgrade a migrated database.

## Code ownership map

Paths are relative to the fhold repository. Revalidate them on the chosen branch.

| Area | Starting files | Required outcome |
| --- | --- | --- |
| Dependencies and image | `containers/assistant/tools/package.json`, `packages/guardian/package.json`, `containers/assistant/Dockerfile` | New native packages, platform binaries and plugin dependency cache are pinned and installed at build time. |
| Startup and health | `containers/assistant/entrypoint.sh`, `containers/assistant/opencode-run.sh`, `containers/assistant/healthcheck.sh`, `containers/assistant/fhold-recovery.mjs` | Foreground launch, authentication and readiness work through the selected V2 contracts. |
| Guardian adapter | `packages/guardian/src/assistant-client.ts`, `packages/guardian/src/gateway-service.ts`, `packages/guardian/src/conversation.ts`, `packages/guardian/src/mcp-agent.ts` | Native API changes stay behind the existing domain boundary; MCP ownership and policy remain enforceable. |
| Provider/Admin operations | `packages/lib/src/control-plane/opencode.ts`, `packages/electron/src/` | Native sign-in, discovery, configuration and model verification remain usable. |
| AKM and memory | `packages/skeleton/system/assistant/plugins/akm.js`, `packages/skeleton/system/assistant/lib/memory.js` | Released V2 AKM integration plus trusted-only, redacted memory behavior. |
| Native activity | `plugins/fhold/opencode.js`, `plugins/fhold/scripts/activity.mjs`, `packages/skeleton/system/assistant/plugins/fhold.js` | Actual turn/tool/subagent activity still drives the existing keep-alive mechanism. |
| Recurring work | `packages/skeleton/config/akm/config.json`, `containers/assistant/fhold-task.mjs` | Native invocation and the scheduled profile still produce durable results. |
| History and recovery | `packages/lib/src/control-plane/history.ts`, `packages/lib/src/control-plane/instance-backup.ts`, `packages/lib/src/control-plane/restore.ts`, `containers/assistant/recovery/catalog.mjs` | Native history conversion and database snapshots preserve user state. |
| Managed installation | `packages/lib/src/control-plane/seed-manifest.ts` | CLI/Admin and standalone image receive the same supported assets. |

## Implementation order

### 1. Establish a reproducible native baseline

Record the selected binary/client/plugin versions and upstream commit. Inspect
the candidate CLI help, generated client types, authentication and event
contracts. Start an isolated native server and capture redacted contract fixtures
before adapting callers. Track unresolved differences explicitly rather than
catching errors and falling back to old endpoints.

OpenCode's foreground `serve` command remains available; qualify it in the shipped
image rather than inventing a supervisor replacement. Verify native package
selection on Linux x64 and ARM64, executable links, read-only managed directories,
configuration isolation and first boot without dependency downloads.

### 2. Integrate the released AKM port and fhold hooks

Obtain the exact compatible CLI/plugin artifacts and test receipt from the AKM
handoff. Update immutable pins and lockfiles using normal package tooling. Remove
assumptions about old platform-package names and the old plugin SDK cache.

Port fhold's AKM wrapper, memory helper and activity plugin using the
[native plugin migration contract](https://opencode.ai/v2/docs/build/plugins/migrate-v1).
Adapt their registrations to actual V2 lifecycle semantics, not only hook names.
Preserve trusted build/plan recall and memory restrictions; guarded and scheduled
requests must not gain implicit memory writes. Subscriptions must clean up on
reload, with no duplicate recall, memory capture or activity records.

### 3. Adapt native API consumers

Use the released `@opencode/client` and
[generated API reference](https://opencode.ai/v2/docs/api) to map each operation.
Health probing changes from `/global/health` to the candidate's `/api/info`
contract; verify its response rather than accepting any HTTP 200.

Cover session lifecycle and ownership metadata, asynchronous prompts, message
and status reads, forks, aborts, diffs, permissions, questions/forms and
workspace search. Preserve public MCP operations where feasible; validate the
new native representations before trusting identity or interaction handles.
Prove that per-request chat/read/full and scheduled restrictions still take
effect in the native engine, including changed permission actions and agent
selection. Server acceptance of old-looking input is not proof of enforcement.

V2 does not provide native LSP/symbol search or task/TODO lists. The owner
approved removing MCP symbol search and the session TODO-list resource rather
than advertising endpoints that cannot report new progress. Retain file/text
search, tool activity, session history and diffs. Document both capability
changes; never return fabricated empty results or add another runtime service
to conceal the gap.

For Admin, adapt the existing shared control-plane functions, not the page design.
Cover provider/integration/credential boundaries, OAuth binding, endpoint model
discovery, targeted watched native config writes and effective readback. A response
test stays on the same page and does not change the chosen model; only explicit
Use does. Filter by native text/tool capabilities rather than model-name guesses.
Account listings must not imply that imported credentials work.

### 4. Qualify recurring work and persistence

Check the selected CLI's server-attachment arguments before updating the current
`run --attach ... --agent scheduled` definition. Verify permissions, task results,
failure history, future-only restart behavior and independent keep-alive/recovery
timers with scheduling disabled.

Determine the candidate database location with native `opencode debug paths db`;
do not guess a new filename. Inspect its schema and upstream V1 migration on
copies. Adapt fhold's offline history reader/importer and recovery catalog only
where their current V1 database/export assumptions fail. Keep consistent
SQLite-native snapshots including WAL content; never copy live database files
or put active SQLite databases on network mounts.

Keep these contracts distinct:

- Full-instance export/import is a stopped, same-instance archive of the home.
- Portable content does not claim to include complete runtime history.
- Ephemeral recovery restores a consistent same-instance checkpoint before
  writers start, including selected databases and native account/plugin state.

Preserve original homes and verified cold exports. Compare identifiers and
content, not only session counts: messages, parts, tool results, timestamps,
attachments, parent/fork relationships and project/workspace association. An
unfinished historical tool call must not be rerun or silently omitted. Any
required conversion to interrupted history needs explicit review and a receipt.
Rollback means restoring the untouched V1 home/export with its matching image,
not pointing an old binary at the converted database.

## Acceptance gates

- [ ] `bun run check`, `bun run test`, `bun run lint`, CLI build, Admin bundle,
  changed shell syntax and Compose validation for all three profiles pass.
- [ ] Fresh image boots non-root, exposes the existing authenticated native
  interface, loads managed policy and requires no startup installs on both
  supported Linux architectures. Cross-build alone is not native execution.
- [ ] Direct OpenCode browser/client access and Discord/Slack adapter smokes
  work through their normal interfaces; missing or incorrect native credentials
  cannot access protected operations.
- [ ] Guardian security tests plus image-backed MCP lifecycle, real tool use,
  permission/question handling and cross-credential denial pass. Symbol-search
  behavior is explicitly resolved.
- [ ] Admin can add/test/use/edit/disable/remove applicable native services,
  including custom OpenAI-compatible endpoints. OAuth, model capabilities,
  credential privacy and persistent native configuration are verified.
- [ ] All AKM/fhold plugins work in OpenCode; existing Claude/Codex native
  integrations and consent are regression-tested. A listed plugin is not proof.
- [ ] Real curation, five AKM tools, trusted memory, scheduled execution and
  keep-alive activity are exercised through normal interfaces. Cancellation,
  subagents, idle transitions and reload do not leak activity or duplicate hooks.
- [ ] Synthetic V1 history converts faithfully and remains usable. Native V2
  export/import, full-instance restore and directory/Blob-emulator checkpoint
  restore preserve sessions, configuration and custom path/database selections.
  SIGTERM, cold resume and failed/incomplete restore are covered.
- [ ] Existing recovery and plugin smokes pass, including
  `scripts/smoke-akm-harnesses.mjs`, `scripts/smoke-keepalive.mjs`,
  `scripts/smoke-recovery.mjs` and `scripts/smoke-blob-recovery.mjs`.
  Real hosting qualification stays outside the product repository.

## Required delivery

Deliver reviewed commits, updated user/architecture/release documentation, exact
dependency pins, redacted native test evidence and a history-preservation report.
List any unverified capability as a release blocker. Use
[harness verification](../operations/harness-plugins-verification.md) and the
[release checklist](../operations/release.md) for the final receipt. Do not claim
readiness from mock hooks, a running process or a successful build alone.

A live upgrade or release is a separate, explicitly approved step after these
gates pass. Do not change the current runtime documentation to say V2 is supported
before implementation and qualification are complete.
