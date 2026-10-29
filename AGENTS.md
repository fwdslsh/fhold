# AGENTS.md — fhold

## Primary product rule — use the platforms, keep fhold minimal

fhold is primarily a prebuilt image that uses AKM and OpenCode to provide custom,
private AI assistants, with minimal tooling to make setup and maintenance easier
and repeatable. This is the primary rule for every design, implementation and
review decision in this repository; it takes precedence over conflicting older
policies, tests and documentation below or elsewhere.

Use existing AKM, OpenCode and other native platform features before adding
machinery. Remove duplicate implementations and refactor fhold integration to
use the owning platform. Do not impose additional fhold agent, tool, memory,
hook, skill-discovery or task restrictions inside Assistant; native features,
operator settings and native authorization/consent own that behavior.

Any machinery that does not directly support this product intent is suspect
and requires the product owner's explicit approval to add **or retain**. Its
presence in existing code, tests or documentation is not evidence of approval.
Identify such machinery and its owning upstream feature before proposing more
helpers, policy stores, adapters, services or frameworks. Routine minimal
integration that directly serves this intent and the user's authorized change
does not need a second approval.

fhold remains beta. Do not add or preserve historical configuration converters
or compatibility frameworks to emulate older beta behavior. Correct current
ownership and use native formats instead. Preserve operator-owned data,
credentials and explicit settings; do not confuse removal of fhold policy with
bypassing native consent or Guardian's actual external credential boundaries.

Keep the foundation small and the operator path clear.

Read `docs/technical/core-principles.md` for supporting product/security contracts;
resolve contradictions in favor of the primary product rule above.
Use `docs/technical/environment-and-mounts.md` for configuration and filesystem
contracts, `docs/assistant-recovery.md` for recovery, and
`docs/operations/release.md` for acceptance gates. Keep evidence honest:
running processes, mocked tests and source scans are not live readiness.

## Product boundaries

- Assistant is the only default container: OpenCode, AKM and supercronic.
- Guardian is optional authenticated MCP; Portal is one private Discord/Slack
  image whose adapters call Guardian. Keep exactly gateway, discord and slack
  Compose profiles.
- CLI owns local installation/lifecycle. Optional Admin uses the same library;
  it has no hosted server, chat, standalone background service or automatic window
  resizing. Admin's platform-native updater runs only while Admin is open; Stable is
  the default channel and updating Admin never upgrades containers or an operator CLI.
  Update feeds currently ship only for Linux; Windows/macOS preview packaging is
  native-tested, but public distribution/signing and update feeds remain unqualified.
  SSH automatically supplies this distribution's private content-addressed management
  executable; never depend on or replace a manually installed remote fhold CLI.
- Shared host-side hosting adapters manage existing local Docker, SSH-Docker and
  experimental ACA targets. Keep provider selection in the shared library,
  native SSH/Azure credentials on the management host, and remote paths/resources
  out of local FH_HOME. Unsupported actions must not fall back to local operations.
  No cloud provisioning, custom deployment editing or host-side recovery engine.
- Native Codex and Claude Code workers are experimental and image-baked.
  Both supervisors default on, waiting for native sign-in and consent.
  Explicit off choices remain off. Enabled workers start
  on every boot, even with scheduling off.
  Preserve native sign-in, consent, chosen isolation mode and user state;
  failure must not stop the Assistant or recurring work. Codex defaults to its
  workspace sandbox; only explicit `danger-full-access` uses outer container
  isolation instead. Task approvals follow supplied native system policy,
  defaulting to on-request; never automatically change policy after failure.
  Register built-in AKM/fhold hooks once through supported native integration.
  Preserve ordinary user, project and plugin hooks and their native consent;
  do not suppress them to compensate for duplicate built-in registration.
  See `docs/managed-harness-configuration.md`.
- No new ingress protocol, service, AI provider registry, scheduler or compatibility layer.
  The bounded CLI JSON machine envelope exists only over native SSH/stdin.
- Compose host, agent, app and data ports in `hosting/provider.ts`. CLI/Admin use
  normalized observations and named typed operations; feature views must not
  branch on host names, fake a cloud StackConfig, acquire access on passive
  inspection or turn temporary setup cancellation into deployment changes.
- Host-specific deployment/qualification and external vendor installers are not
  product runtime features. Keep generic transports, runtime contracts, product
  tests and reusable image smokes here.

## Implementation quality

Use standard container practices, upstream-supported installation/configuration,
and native vendor flows. Do not patch vendor tools, add per-tool wrappers or
introduce environment/configuration workarounds that users must reproduce.
Fix the owning component rather than accumulating compensating startup logic.
Keep installed commands available through ordinary Linux executable locations.
Tests must exercise the shipped image through normal user interfaces; never
repair its PATH, settings or permissions inside a test to conceal a product bug.
Disposable fixtures may isolate accounts/data, not supply missing product behavior.
Prefer a small, maintainable solution over another helper, service or exception.
Default to logging, isolating an optional failure and reporting actionable degraded
state while the agent continues. Scheduling, knowledge hooks, keep-alive and
diagnostics must not become whole-container restart gates. Stop only when the
core cannot run or continuing is unsafe, including authentication, incomplete
restore and actual loss of exclusive recovery ownership.

## Ownership and data safety

New named homes live under `~/fhold/instances/<name>`; Admin's unnamed default
is `~/fhold/instances/default`. CLI selection is `--name`/`-n` (a directory
name under that root or an absolute path), then `FH_HOME`, then the current
directory. `FH_HOME` is optional. Admin's folder picker accepts custom locations.
Existing homes are never relocated automatically. Reserve `~/fhold` for instances
and other local directories such as backups/docs. Product-owned variables use `FH_*` only.
`state/stack.json` owns intent and must identify `product: "fhold"`.
Other products' or incompatible homes must be refused before writes.
Never adopt an unrelated installation or implicitly copy its runtime authority.
Explicit full-instance import is a same-instance continuation from a verified
stopped export into an empty folder, retaining the named identity and native state.

Managed `system/` files use an explicit allowlist. Updates replace release-owned
bytes and retire known, unchanged product files removed from the current release.
Preserve unknown or operator-modified files and report ownership conflicts;
never use whole-directory synchronization or deletion to enforce the allowlist.
Operator `config/` is seeded only when missing. Knowledge/workspace remain
user-owned. State/data are private runtime input, not portable user content.
Status reads must not mutate any of them. Necessary release-owned native
integration belongs under `system/`, not seed-once `config/`; this ownership
does not authorize fhold to impose additional agent policy. Native user settings,
AKM activation/custom engines, Guardian and custom Compose remain operator-owned.
Do not require custom policy mounts to regain ordinary native behavior. This
ownership contract needs no fhold historical configuration converter or merger.
After recovery and before native agent/task writers, Assistant invokes AKM's
native backed-up migrator. Native plugin commands refresh image-owned local
selections while preserving explicit off choices, custom marketplaces and consent.
Backup restore requires fhold's own verified manifest. Native history recovery
is separate, offline and explicitly mapped. Restored task definitions remain
inactive until reviewed for portable-content restore. Full-instance export/import
requires stopped writers, informed confirmation and an empty target, includes
sessions/credentials/active task intent, and leaves containers stopped. Never
run original/restored copies together or overwrite existing homes; external
sources/checkpoint authority need separate review. Incomplete imports block startup.
Opt-in same-instance runtime
recovery preserves reviewed future-only intent only when scheduling is explicitly
enabled. Normal updates preserve current authority and schedules.

Assistant-only ephemeral recovery is host-independent, not cloud administration.
Its timer is independent of `FH_SCHEDULER_ENABLED`. SQLite-native snapshots restore
before any writer/default seeding; live databases never use a network filesystem.
Directory destinations require coherent atomic creation/rename and refuse automatic
ownership takeover. Keep native trust/approval and sensitive recovery private.
Read `docs/assistant-recovery.md` before changing the recovery contract.

Never delete or overwrite existing user data, secrets, homes, backups or unrelated
work. Deletion of user-owned paths needs path-specific approval. Do not change
existing stacks during tests; create isolated homes/projects with explicit ports.
Do not log credential values or include them in artifacts, commits or test reports.

Assistant receives neither Docker socket nor ingress credentials. Keep non-root
containers, no extra capabilities, safe argument-array subprocesses and the
Guardian authentication/moderation/ownership/path containment protections.
These are shipped defaults and release-test expectations, not a policy imposed
on an operator's Docker host. Compose policy comparisons belong in optional
`fhold doctor` diagnostics, never start/restart/update or offline-recovery gates.
Keep native Compose parsing, instance targeting, lifecycle locks and actual
restore integrity/ownership checks; do not reintroduce a policy bypass flag.

## Development and verification

Review dependency freshness before every PR merge, with changes scoped to the
work. Focused fixes do not require unrelated dependency upgrades. Apply urgent
security fixes and required compatibility updates promptly; batch other upgrades
in explicit dependency work or early release preparation. A full release review
covers all workspaces/overrides, image tools/marketplaces, runtime/compiler bases,
CI tools and docs dependencies. Check AKM's required CLI and all three plugin
installations together. Record the review date, scope, changes, holds and deferred
updates in the PR. Do not call a held dependency the latest release.
Finish intended updates before qualification; a newer noncritical upstream
release does not restart completed qualification. Changed dependencies still
require the affected checks on the final SHA. Follow
`docs/operations/updating-dependencies-and-releasing.md`. Keep runtime pins exact
and image-baked rather than floating versions or startup upgrades.

Identify development candidates by commit SHA and image digest. Choose and stamp
the release version near publication, after functional validation. Unpublished
local builds, dry runs and candidate receipts do not consume monthly counters;
they may be rebuilt under the same provisional version with fresh evidence.
Once a release Git tag, versioned registry image or release-download asset is
public, its version and bytes are immutable, including partial publication.
CI/development artifacts identified by SHA/digest are candidate evidence, not
release publication. Qualify the final stamped
SHA and artifacts; reusing a version never makes earlier checks cover changed
content. During prerelease, retain the temporary beta-as-latest recommendation;
do not invent stable releases or change native updater consent/channel choices.

Before final candidate qualification, identify the required checks and the eligible
evidence that satisfies each. Separate development regression, final candidate
qualification and publication integrity checks; satisfy each requirement once.
Reuse successful eligible evidence unless relevant inputs changed or a concrete
failure requires another run. Preserve owner-approved coverage exclusions; do
not invent extra release blockers. After the bounded published-artifact checklist
passes, finish and report immediately. Optional investigation does not delay
release closeout or become a new acceptance gate.

Docs and website-only changes use the documentation workflow rather than the
full container matrix. Lockfile-only changes also skip product CI. Keep this
separation when editing CI; root manifests and runtime Markdown skills/prompts
still require full CI.

Use AKM curate/show before inventing a workflow or unfamiliar configuration;
record useful feedback. Use strict TypeScript, Web/Node/Bun built-ins and the
private shared library rather than duplicating domain operations. Edit with
apply_patch; do not interpolate shell commands. Preserve meaningful tests.

Run `bun run check`, `bun run test`, `bun run lint`, CLI build and Admin bundle.
Validate all Compose profiles and changed shell scripts. Runtime changes require
image-backed security, scheduler, provider and AKM harness verification.
Use disposable native-history and backup/restore fixtures; never test rollback
by downgrading engines against live databases.

GitHub at https://github.com/fwdslsh/fhold is the canonical source and contribution
host. Linux is supported; ARM64 cross-build evidence is not native execution.
GitHub builds the standalone CLI/AppImages and publishes signed multi-architecture
images to `fwdslsh/fhold-{assistant,guardian,portal}` on Docker Hub. Fresh installs
use those pinned public images; the explicitly selected `fhold` namespace remains
local-build-only. Do not add an npm bootstrap or cross-host publishing bridge.
