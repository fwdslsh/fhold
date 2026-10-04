# AGENTS.md — fhold

fhold is a single-install home for a personal OpenCode agent: persistent
knowledge, recurring work and standards-based access without requiring users
to manage model endpoints. Keep the foundation small and the operator path clear.

Read `docs/technical/core-principles.md` for the active product/security contract.
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
  it has no hosted server, chat, background updater or automatic window resizing.
- Native Codex and Claude Code workers are experimental and image-baked.
  Both supervisors default on, waiting for native sign-in and consent.
  Explicit off choices remain off. Enabled workers start
  on every boot, even with scheduling off.
  Preserve native sign-in, trust, chosen isolation mode and hook approval;
  failure must not stop the Assistant or recurring work. Codex defaults to its
  workspace sandbox; only explicit `danger-full-access` uses outer container
  isolation instead. Keep on-request approvals; never automatically fall back.
- No new protocol, service, provider registry, scheduler or compatibility layer.
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

## Ownership and data safety

`FH_HOME` defaults to `~/.fhold`. Product-owned variables use `FH_*` only.
`state/stack.json` owns intent and must identify `product: "fhold"`.
Other products' or incompatible homes must be refused before writes.
Never adopt an existing installation or copy its runtime authority.

Managed `system/` files use an explicit allowlist. Operator `config/` is seeded
only when missing. Knowledge/workspace remain user-owned. State/data are private
runtime input, not portable user content. Status reads must not mutate any of them.
Backup restore requires fhold's own verified manifest. Native history recovery
is separate, offline and explicitly mapped. Restored task definitions remain
inactive until reviewed for portable/manual restore. Opt-in same-instance runtime
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

## Development and verification

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
