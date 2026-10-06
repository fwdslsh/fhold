# OpenCode 2 migration: AKM and akm-plugins agent handoff

Status: implementation brief, not a completed migration. Reviewed 2026-10-06.

## Objective and boundaries

Make AKM's OpenCode execution, history/config discovery and native plugin support
work with OpenCode 2 while preserving dispatch and history for users whose
primary OpenCode installation remains V1. Deliver generally usable upstream
packages for AKM and akm-plugins, independent of any consuming application or
deployment environment.

Work in [itlackey/akm](https://github.com/itlackey/akm) and
[itlackey/akm-plugins](https://github.com/itlackey/akm-plugins), on fresh feature
branches from their current release sources. The source paths below were checked
in available checkouts; revalidate them because those checkouts lag the published
packages. Read each repository's AGENTS.md and required architecture/persisted-data
guidance before changing implementation. AKM's current guidance includes
`docs/architecture/architecture.md` and
`docs/architecture/persisted-data-compat.md`.

Published baseline: `akm-cli@0.9.26` still depends on
`@opencode-ai/sdk@1.2.20`; `akm-opencode@0.9.26202610051302` uses the V1 plugin API.
The published [CLI manifest](https://registry.npmjs.org/akm-cli/0.9.26) and
[plugin manifest](https://registry.npmjs.org/akm-opencode/0.9.26202610051302)
are the baseline artifact references, not the older local branches.
The reviewed candidate is OpenCode `2.0.24`, with `@opencode/client` and
`@opencode/plugin`. Refresh versions and pin the qualification target first.

The upstream [V1 migration guide](https://opencode.ai/v2/docs/migrate-v1)
requires plugin and API ports, not wholesale replacement of supported file-based
definitions. Installing a new binary alone is insufficient.

Preserve AKM as a CLI, with plugins invoking its public commands rather than
importing internal implementation modules. Keep the five public plugin tools:
search, show, curate, feedback and remember. Do not add a plugin manager, server,
credential registry, new source adapter or startup installer. Native harnesses
continue to own approvals and permissions.

## Approved compatibility design

Retain one current, harness-independent AKM core. Make V2 the primary OpenCode
integration, with a lightweight V1 adapter in the existing per-harness integration
layer. V1 support is required, not an optional transition window. An AKM upgrade
must not force users to upgrade or replace their native OpenCode installation.

| Component | Responsibility |
| --- | --- |
| Shared AKM core | Knowledge commands, execution/results, indexing, proposals, configuration and persistence; no duplicated V1/V2 business logic. |
| V1 compatibility adapter | Native V1 dispatch/request/result translation and read-only history parsing into existing AKM contracts. |
| V2 integration | Native V2 dispatch and history translation into those same contracts. |
| `akm-opencode` | V1 native hooks/tools, using the current supported AKM CLI. |
| `akm-opencode-v2` | Separately published V2 native hooks/tools, using the same supported AKM CLI release. |

Reuse existing lifecycle, cancellation, environment isolation and history
normalization. Do not create a second engine framework, compatibility service or
new public engine IDs merely to distinguish majors. Keep legacy wire/schema code
at the adapter boundary. A scoped V1 SDK dependency may remain there if needed;
it does not justify retaining an older complete AKM runtime.

Resolve the configured OpenCode executable and detect its reported major before
dispatch. Preserve explicit binary selection and normal PATH resolution; do not
search for or install a replacement V2 binary. Where an existing dispatch path
attaches to a server, check that target's native version/capabilities. Do not add
a new remote-dispatch feature for this port. Authentication or
transport failures must not trigger fallback to another protocol or engine.
Select history readers from the actual dataset/schema, not just the installed
binary's major, so retained V1 history remains readable after a native upgrade.

## AKM CLI work

### Execution adapter

Start with:

- `package.json`
- `src/integrations/harnesses/opencode-sdk/sdk-runner.ts` and
  `src/integrations/harnesses/opencode-sdk/harness.ts`
- `src/integrations/harnesses/opencode/agent-builder.ts` and
  `src/integrations/harnesses/opencode/index.ts`
- `src/setup/detect.ts` and `src/setup/detected-engines.ts`

Isolate current V1 client assumptions in the compatibility adapter and implement
the selected V2 client contract alongside it. Cover managed-server creation,
session creation/prompting/deletion, directory scoping, model/agent selection,
tool permissions, output/usage decoding, errors and cancellation. Use the
[generated V2 API](https://opencode.ai/v2/docs/api)
instead of guessed endpoint aliases or response casts.

Keep common server/process ownership outside the version adapters. Preserve both
existing SDK-backed and CLI-backed dispatch on supported V1 installations; do
not silently route an SDK profile through a weaker CLI path or discard its
permission/output contract. Version-specific request, flag and response handling
belongs in small explicit adapters, not scattered major-version conditionals.

The existing runner detects a particular startup log prefix. Verify startup and
readiness independently for both majors; prefer a bounded native readiness check
if the prefix is unreliable.
Retain explicit child environments, per-workspace isolation, port ownership,
shared-server lifecycle, deadline handling and process cleanup. Failure must
not select another model, relax permissions or leave a server running. Do not
add another supervisor or rewrite unrelated harness dispatch.

Also test the ordinary CLI-backed OpenCode harness on both majors. SDK
compatibility does not prove native CLI argument lowering, tool invocation or
task output still works.
Select any changed attachment flags from the chosen binary's help, not from an
old fixture or package version label.

### Session history and discovery

Start with `src/integrations/harnesses/opencode/session-log.ts`. Keep its supported
V1 `opencode.db`/session/message/part reader as an isolated compatibility adapter.
Determine V2's location with native `opencode debug paths db` and inspect its
schema; do not require that V2-only discovery command to read a V1 installation.

Keep discovery read-only. An incompatible database or failed parse must not look
like an empty session history. Prefer supported native history interfaces where
they fit offline discovery; otherwise keep the smallest isolated reader needed
for the supported schemas. Do not auto-start servers or migrate user databases
just to list history. Preserve stable session/source identity, message ordering,
tool results and indexing provenance; reindexing must not create duplicate facts.

Test V1, native V2 and natively migrated V1 fixtures, including WAL content,
different projects, forks and incomplete historical calls. Capture explicit
unsupported/corrupt-state outcomes rather than swallowing database errors.

### Native configuration import and rendered assets

Start with:

- `src/integrations/harnesses/opencode/config-import.ts`
- `src/setup/harness-config-import.ts`
- `src/core/adapter/adapters/opencode-adapter.ts`

Recheck current JSON/JSONC locations and provider/model shapes. The inspected
older importer expects a provider array and selects its first entry; do not
carry that assumption into V2. Resolve the user's selected model/provider and
supported references explicitly. Do not silently pick another provider when the
selection is absent or unavailable.

Preserve V1 setup and rendered configuration when the selected harness is V1.
Native V2 changes must not be written into a V1 user's files during an AKM-only
upgrade. Share model/reference resolution while isolating differing native keys.

Handle supported legacy configuration and native V2 provider maps without
copying credentials into generated configuration, logs or test receipts. Preserve
environment/file references through existing AKM secret conventions; native OAuth
remains native. Apply established import rules to literals rather than adding
a second authentication system.

Verify existing bundle agents, commands, skills and relative supporting files in
the native harness. Change rendered syntax only where required; file renaming
and broad automatic configuration rewrites are not the goal.

## akm-plugins work

### Native plugin implementations

Start with `opencode/index.ts`, `opencode/fragment-context.ts`,
`opencode/package.json`, `opencode/tsconfig.json`, the applicable lockfile and
`opencode/README.md`.

Retain the V1 plugin entrypoint and add the separate V2 package/entrypoint. The
published V1 plugin currently pins its own AKM dependency and deep-imports
`akm-cli/dist/commands/read/...` for search/show/curation. Replace those internal
imports with supported CLI calls in both plugins, using shared invocation and
result-handling helpers. Both must work with the same current AKM release and
data stores, rather than freezing a legacy CLI inside the V1 plugin.

Keep automatic session extraction working through the existing public CLI flow
and version-aware history adapter. Native event/session identifiers may need
translation at the plugin boundary; database readers and knowledge processing
should not be duplicated into the plugins. Preserve automatic-recall ordering
and measure latency when replacing in-process calls.

Use the [native plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1):
a default `Plugin.define` entrypoint with a stable ID and native registration.
Review these mappings against the selected release:

| Existing responsibility | V2 native starting point |
| --- | --- |
| Prompt recall formerly in `chat.message` | Session prompt hooks |
| System context transformation | Session context hooks |
| Tool pre/post processing | Tool hooks/transforms |
| Session lifecycle events | Native event subscriptions with cleanup |
| Five AKM tools | Native tool registration and schemas/results |

Treat this as a semantic port. Establish when curation completes relative to
model execution, how context enters the request and how compaction, retries,
subagents and concurrent sessions behave. Test automatic recall without requiring
the user to remember a special command. Preserve reference provenance, deduping,
feedback behavior and existing consent/learning policy. Do not invent new
automatic memory writes.

Reuse existing CLI, reference, redaction and recall helpers. Shared helpers
currently live under `claude/shared/`, including `redaction.ts`, `recall-policy.ts`,
`curate-render.ts`, `state-files.ts` and `ref-extraction.ts`. Extract a small shared
core only if necessary; do not duplicate the large V1 entrypoint into a second
implementation. Check cancellation and temporary-file cleanup without deleting
user-owned assets.

Use the supported V2 logging channel and structured redacted diagnostics. Do not
print plugin diagnostics directly to terminal/stdout or assume the old native
logging API survives. A plugin load error must be visible, not disguised as
successful recall.

### Packaging and compatibility

Publish `akm-opencode` as the V1 package and `akm-opencode-v2` as the V2 package;
the latter name is an implementation target, not an already published artifact.
Declare the same tested current AKM CLI dependency for both and each host's
matching native plugin API. Install only the appropriate plugin in each host.
Keep the existing V1 package name and normal installation process working.
Document the supported minimum for each major; do not silently repoint the V1
package's default export or latest tag to V2 code. V1 support has no retirement
date in this handoff; any later removal requires a separate decision.

AKM/plugin dependencies must not install `opencode-ai` or `@opencode/cli`, or
replace the user's global `opencode` command. Versioned client/plugin libraries
can coexist as normal scoped dependencies without installing another native
binary. No startup downloads, custom binary shims or PATH repairs are permitted.

Update package exports/dependencies, build outputs and native installation
instructions consistently. Test the built package through standard installation,
not only its TypeScript source. Keep native Claude/Codex integrations intact;
they need regression tests, not an OpenCode-driven rewrite. AKM plugins must use
compatible declared CLI versions across harnesses without runtime downloads.

Preserve AKM's existing persisted-data contracts. Dependency isolation alone
does not isolate a plugin's AKM databases from the user's global CLI. Verify
upgrade/coexistence with the currently published V1 plugin and the updated V1
plugin; do not introduce an unrelated database format change for this port or
let an older dependency silently corrupt newer state. Document the plugin
update sequence and report an incompatible state explicitly.

Review `evals/tier2/harness/opencode.ts`: it currently exercises V1 hook shapes.
Update the evaluation adapter, but distinguish mocked hook evaluations from
native end-to-end evidence. Update repository instructions that describe V1-only
plugin contracts once the implementation actually changes them.

## Verification matrix

Use current repository check/build/integration commands and CI gates. Extend
existing tests rather than replacing valuable regression coverage.

| Surface | Required native evidence |
| --- | --- |
| AKM-only upgrade with OpenCode V1 | Latest candidate AKM works with the declared V1 minimum and `1.18.34`; native OpenCode version, executable selection, configuration, approvals and history remain unchanged. |
| OpenCode V1 plugin | Updated `akm-opencode` uses the current AKM CLI; all five tools, automatic recall and session extraction work through standard installation. |
| OpenCode V2 plugin | Built package installs normally; all five tools execute; automatic curation reaches the next model request with correct provenance. |
| SDK and CLI execution on both majors | Native prompts/tool execution, structured results, scoped environments, parallel workspaces, errors, deadlines and cancellation; no leaked children or weaker permission fallback. |
| History | Read-only V1/V2/migrated fixtures preserve content and identities; missing history differs from incompatible/corrupt state. Retained V1 data can be read with V2 on PATH without starting or migrating a server. |
| Configuration | Legacy/native JSONC, selected-model resolution, custom endpoint and secret-reference cases; no first-provider guessing or credential leakage. |
| Lifecycle | Reload/unload, idle, retries, compaction and subagents do not duplicate recall, feedback, learning or subscriptions. |
| Other harnesses | Standard Claude and Codex plugin installs retain tools, recall, native approvals and compatible CLI behavior. |
| Dependency and shared-state coexistence | Normal installs preserve the user's OpenCode executable; both updated plugins use the same AKM release. Global CLI/plugin version skew during upgrade produces no silent corruption or history loss. |

V1 dispatch/history/plugin failures block release, not merely an optional
compatibility warning. Test version selection with an explicitly configured
binary as well as PATH, and reject unknown majors/authentication failures clearly
without switching engines or returning empty history.

Useful AKM tests: `tests/opencode-sdk-runner.test.ts`,
`tests/opencode-sdk-managed-server.test.ts`, `tests/setup/detected-engines.test.ts`,
`tests/core/adapter/opencode-adapter.test.ts` and native fixtures under
`tests/fixtures/execution-contracts/native/opencode/`.

Useful plugin tests: `tests/opencode-plugin.test.ts`,
`tests/opencode-curate-floor.test.ts`, `tests/opencode-eval-harness.test.ts`,
`tests/claude-plugin.test.ts`, `tests/fake-akm-contract.test.ts`,
`tests/ref-resolver-contract.test.ts`, `tests/redaction.test.ts` and
`tests/recall-policy.test.ts`. Add missing native V2 and Codex coverage. Review
`.github/workflows/tests.yml`, `.github/workflows/evals.yml` and
`.github/workflows/release.yml` against the actual package outputs and
compatibility matrix.

Use disposable bundles, homes and test endpoints. Paid inference, real account
credentials and publishing require authorization. Test errors and denied actions
without relaxing policy to make a green result.

## Delivery and dependency order

Deliver source commits, normal package artifacts, updated compatibility/install
docs and redacted native test receipts. State exact CLI/plugin/OpenCode versions
and the tested V1/V2 support matrix; report untested paths as blockers. Preserve
V1 dispatch and history through the lightweight adapter as an acceptance condition.

When publication is approved, publish the qualified AKM CLI with both native
adapters first, then the V1 and V2 plugin artifacts declaring that CLI dependency.
Document exact package pins, native entrypoints, installation/update steps and
the both-major compatibility receipt for users and maintainers. Keep all changes
within AKM's existing execution, history, configuration and native plugin
boundaries; application-specific deployment behavior is outside this work.
