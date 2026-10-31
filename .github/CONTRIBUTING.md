# Contributing to fhold

Read the primary product rule in [AGENTS.md](../AGENTS.md) and the supporting
[core principles](../docs/technical/core-principles.md) before changing the
runtime. Use native AKM/OpenCode features first; keep fhold's setup and
maintenance tooling minimal. Machinery outside that intent needs owner approval.

## Setup

```bash
git clone https://github.com/fwdslsh/fhold.git
cd fhold
bun install
./scripts/dev-setup.sh
```

Use a non-root account. Docker Compose v2 is required for stack work; native
Node.js 22.12+ is required for Electron packaging and its launcher. GitHub is the
canonical source and contribution host. Linux is supported through local builds;
public binary/image publishing and non-Linux packaging have separate release
gates. See [installation.md](../docs/installation.md).

## Active source

- `packages/lib`: host control plane
- `packages/cli`: primary lifecycle CLI
- `packages/guardian`: MCP security gateway
- `packages/portal`: unified Discord/Slack adapters
- `packages/electron`: optional static Admin
- `packages/skeleton`: selectively materialized runtime files
- `containers/*`: three image definitions

Every tracked package belongs to the active product surface.

## Develop

```bash
bun run guardian:dev
PORTAL_ADAPTER=discord bun run packages/portal/src/index.ts
bun run packages/cli/src/main.ts --help
bun run admin:dev
```

Prepare or build the local stack with:

```bash
bun run dev:setup
bun run dev:build
```

## Required checks

Before merging every PR, review dependency freshness using
[the dependency and release guide](../docs/operations/updating-dependencies-and-releasing.md).
Keep focused fixes focused: unrelated upgrades are not a merge requirement.
Handle urgent security fixes and required compatibility updates promptly; batch
other updates in explicit dependency work or early release preparation. Record
the review date/scope, changes, holds and deferred updates. Full release reviews
cover all workspaces, transitive resolutions, tools/base images, AKM's CLI and
three plugins, CI tools and docs dependencies. Finish intended updates before
qualification; do not restart it to chase a newer noncritical release. Changed
pins or lockfile content still require affected checks on the final commit.

Develop and test candidates using commit SHAs/image digests. Stamp a release
using `X.Y.YYMMNN` for 0.3; from 0.4 use `X.Y.MMNN` with monthly counter 01–99,
e.g. `0.4.1001`, `0.4.1002`, `0.4.1101` (January: `0.4.101`). Keep optional
alpha/beta/rc suffixes without a serial and use a new minor line at year rollover.
See the [version policy](../docs/operations/release.md#month-counter-versions-from-04).
Stamp the version near publication. Unpublished builds and dry runs can change without
consuming another monthly counter; regenerate their evidence and validate the
final stamped build. Public release tags, versioned registry images and release
downloads remain immutable, even after partial publication. CI artifacts are
candidate evidence. Stable releases use GitHub's latest release and the `latest`
image channel; preserve native updater consent and explicit channel choices.

```bash
bun run check
bun run test
bun run lint
bun run --cwd packages/cli build
bun run --cwd packages/claude-desktop pack
bun run --cwd packages/electron bundle
bash -n scripts/dev-setup.sh \
  scripts/smoke-image.sh \
  containers/assistant/entrypoint.sh \
  containers/assistant/healthcheck.sh \
  containers/guardian/entrypoint.sh
```

Also validate Compose with all profiles and build the affected image when Docker
is available. See [testing-workflow.md](../docs/technical/testing-workflow.md).

## Design rules

- Keep Assistant free of Docker/admin credentials.
- Put remote traffic through authenticated Guardian MCP.
- Preserve wildcard tool denial for the remote and moderator profiles.
- Keep credentials in file secrets, never environment values.
- Use argument arrays for Docker processes.
- Add no boot-time installers.
- Keep `state/stack.json` the sole intent schema.
- Keep one managed Compose file and one operator overlay.
- Preserve operator files and data on install/update.
- Prefer a standard external client or a custom Compose service over a new core
  UI, protocol, model service, or addon system.
