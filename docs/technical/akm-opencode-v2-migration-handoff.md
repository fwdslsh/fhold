# OpenCode 2 migration: AKM and akm-plugins agent handoff

Status: implementation brief, not a completed migration. Reviewed 2026-10-06.

## Objective and boundaries

Make AKM's OpenCode execution, history/config discovery and native plugin support
work with OpenCode 2. Deliver generally usable upstream packages, not a
fhold-specific integration. The downstream consumer is covered by the
[fhold handoff](opencode-v2-migration-handoff.md).

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

## AKM CLI work

### Execution adapter

Start with:

- `package.json`
- `src/integrations/harnesses/opencode-sdk/sdk-runner.ts` and
  `src/integrations/harnesses/opencode-sdk/harness.ts`
- `src/integrations/harnesses/opencode/agent-builder.ts` and
  `src/integrations/harnesses/opencode/index.ts`
- `src/setup/detect.ts` and `src/setup/detected-engines.ts`

Replace V1 client assumptions in the SDK runner with the selected native client
contract. Cover managed-server creation, session creation/prompting/deletion,
directory scoping, model/agent selection, tool permissions, output/usage decoding,
errors and cancellation. Use the [generated V2 API](https://opencode.ai/v2/docs/api)
instead of guessed endpoint aliases or response casts.

The existing runner detects a particular startup log prefix. Verify actual V2
startup; prefer a bounded native readiness check if the prefix is unreliable.
Retain explicit child environments, per-workspace isolation, port ownership,
shared-server lifecycle, deadline handling and process cleanup. Failure must
not select another model, relax permissions or leave a server running. Do not
add another supervisor or rewrite unrelated harness dispatch.

Also test the ordinary CLI-backed OpenCode harness: SDK compatibility does not
prove native CLI argument lowering, tool invocation or task output still works.
Select any changed attachment flags from the chosen binary's help, not from an
old fixture or package version label.

### Session history and discovery

Start with `src/integrations/harnesses/opencode/session-log.ts`. It assumes the
V1 `opencode.db` location and session/message/part tables. Determine the new
location with native `opencode debug paths db` and inspect the selected schema.

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

Handle supported legacy configuration and native V2 provider maps without
copying credentials into generated configuration, logs or test receipts. Preserve
environment/file references through existing AKM secret conventions; native OAuth
remains native. Apply established import rules to literals rather than adding
a second authentication system.

Verify existing bundle agents, commands, skills and relative supporting files in
the native harness. Change rendered syntax only where required; file renaming
and broad automatic configuration rewrites are not the goal.

## akm-plugins work

### Native V2 implementation

Start with `opencode/index.ts`, `opencode/fragment-context.ts`,
`opencode/package.json`, `opencode/tsconfig.json`, the applicable lockfile and
`opencode/README.md`.

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

Choose and document the minimum supported OpenCode/AKM versions. Do not replace a
V1 entrypoint with incompatible V2 code under a routine patch release and break
existing V1 users silently. Use an explicit release boundary or documented native
entrypoints, sharing logic if a short V1 support window is necessary. Avoid an
indefinite dual-platform framework or reflective runtime fallback maze.

Update package exports/dependencies, build outputs and native installation
instructions consistently. Test the built package through standard installation,
not only its TypeScript source. Keep native Claude/Codex integrations intact;
they need regression tests, not an OpenCode-driven rewrite. AKM/fhold must use
compatible declared CLI versions across harnesses without runtime downloads.

Review `evals/tier2/harness/opencode.ts`: it currently exercises V1 hook shapes.
Update the evaluation adapter, but distinguish mocked hook evaluations from
native end-to-end evidence. Update repository instructions that describe V1-only
plugin contracts once the implementation actually changes them.

## Verification matrix

Use current repository check/build/integration commands and CI gates. Extend
existing tests rather than replacing valuable regression coverage.

| Surface | Required native evidence |
| --- | --- |
| OpenCode V2 plugin | Built package installs normally; all five tools execute; automatic curation reaches the next model request with correct provenance. |
| SDK and CLI execution | Real prompts/tool execution, structured results, scoped environments, parallel workspaces, errors, deadlines and cancellation; no leaked children. |
| History | Read-only V1/V2/migrated fixtures preserve content and identities; missing history differs from incompatible/corrupt state. |
| Configuration | Legacy/native JSONC, selected-model resolution, custom endpoint and secret-reference cases; no first-provider guessing or credential leakage. |
| Lifecycle | Reload/unload, idle, retries, compaction and subagents do not duplicate recall, feedback, learning or subscriptions. |
| Other harnesses | Standard Claude and Codex plugin installs retain tools, recall, native approvals and compatible CLI behavior. |
| Declared V1 support | Supported V1 artifact/entrypoint still works on the published minimum and fhold's `1.18.34`; otherwise communicate an explicit breaking release. |

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
and whether V1 support is retained; report untested paths as blockers.

When publication is approved, publish the qualified AKM CLI changes first, then
the plugin artifact that declares that CLI dependency. Send the exact pins,
entrypoint and compatibility receipt to the fhold implementer. fhold then owns
its memory wrapper, activity/keep-alive integration, Guardian/Admin adapters and
container recovery qualification. AKM must not embed those product-specific
behaviors merely to make downstream tests pass.
