# Native platform integration qualification

This change removes fhold's local agent allowlist, prompt filtering, direct
memory inference, restricted scheduled agent, discovery disables and duplicate
managed hook registration. AKM owns recall, tools, learning, proposals and task
dispatch; OpenCode, Claude and Codex own native permissions and hook consent.
Guardian's authenticated chat/read/full credential boundary remains in place.

## Required dependency update

The official npm `akm-cli@0.10.261015-beta` package retains the native child
environment fix required by this refactor. Its `dist/core/paths.js`
`childProcessEnv`/`akmLocations` and `dist/integrations/agent/spawn.js`
`buildChildEnv` preserve resolved AKM config, data, cache and state locations.
The earlier SDK engine dropped those locations in ordinary child dispatch.
Fresh fhold configuration uses the supported `harnesses.opencode` configuration
with `args: ["run", "--standalone"]`, reusing the installed OpenCode and its
native settings/authentication without a fhold launcher or first-use download.

The current plugin is `akm-opencode-v2@0.10.261013-beta`, whose exact CLI015
dependency matches the installed command without a version override. Its native
Claude and Codex marketplace is baked from the same immutable release. OpenCode
CLI/client/plugin SDK are aligned at **2.1.4**, with the required **Effect 4.0.1**.
No vendor source is patched. Published package integrity is recorded in `bun.lock`.

CLI015 acquires native runtime pieces outside its npm dependency tree. The image
build uses AKM's own acquisition code to populate its ordinary cache with its
pinned OpenCode runtime. Native `akm setup --yes --embedding local` also prepares
the ONNX binding and model on Linux x64. Only the cache is copied into the image;
build setup preferences never replace operator configuration. The immutable
assets stay under `/assistant-defaults/akm-cache`, outside Compose's writable
cache mount. Ordinary filesystem initialization copies only missing assets into
the native cache; existing operator files and symlinks win. No setup or network
download runs during initialization. Linux ARM64 follows
upstream's keyword/remote-embedding support. Fresh-instance smoke tests require
cache discovery and local embedding availability where supported with networking
disabled and the actual writable cache mount in place. No installer or
configuration writer is added to startup.
Upstream's `docs/reference/configuration.md`,
`dist/integrations/harnesses/opencode/agent-builder.js` and native session reader
own bounded model work and the `akm-model-work` recursion exclusion.

Dependency freshness was reviewed on October 27, 2026. The OpenCode 2.1
compatibility hold is removed; the former history metadata blocker was removed
in003. See [the upgrade record](../operations/dependency-refresh-2026-10-27.md)
for native continuation qualification and the unresolved upstream advisory
chains. Unrelated Claude, formatter and desktop packaging updates are deferred
to an intentional dependency batch.

## Executable evidence and limits

`scripts/smoke-akm-harnesses.mjs` runs the actual image's OpenCode model request
and all five AKM tools against a synthetic loopback provider. It also exercises
real Claude/Codex native hook registration, exactly-once recall, Codex's explicit
native trust consent and operator hook availability, without paid accounts.

`scripts/smoke-native-akm-policy.mjs` uses real native sessions for build, plan,
custom/default agents, subagent mode and mixed histories. It checks project
configuration/skill discovery, an unchanged benign token-budget prompt, ordinary
child catalog inheritance with nonstandard AKM directories, native reviewable
proposal extraction, automatic prompt learning/session extraction with native
triage and utility recursion prevention, explicit automatic-learning off, optional inference errors
and Guardian automatic-context scope including credential downgrade.

Source tests cover per-turn Guardian policy refresh, removed product file
retirement, whole-manifest symlink preflight, operator edits and archive
preservation. Native output retirement moves only known unchanged published
bytes into private hash-qualified archives; unknown/operator edits remain with
an explicit warning. Existing AKM configuration is preserved; operators use
native `akm migrate` and explicit harness selection as described in
[the upgrade instructions](../managed-harness-configuration.md#existing-beta-installations).

Local qualification uses Linux amd64, pinned Bun1.4.4 and a disposable candidate
image. Hosted ARM64/multiplatform jobs, signed-in remote-client behavior,
hours-long quiet turns and a real restore drill remain separate qualification;
these synthetic checks do not claim account or deployment coverage. No live
stack, recovery setting, release version or published artifact is changed.
