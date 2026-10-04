# Dependencies and development

The source workspaces share one root `bun.lock`. Host orchestration imports
`@fhold/lib`; the library has no runtime dependency. Standard MCP/platform SDKs
remain in their owning packages. The CLI source/build workspace produces a
standalone Linux executable; it is not an npm bootstrap package. GitHub is the
canonical source and release builder; Linux downloads are published there and
signed multi-architecture images are published to public Docker Hub.

Native Node.js 22.12 or newer is required for Electron developer/build tooling;
do not use a shell alias or compatibility shim in place of the native binary.

Exact tool versions belong in `package.json`, the image tools manifests and
Dockerfiles. Assistant/Guardian OpenCode pins must match. AKM native integration
is installed at image build, not startup; runtime trust stays explicit.

```bash
bun install --frozen-lockfile
bun run check
bun run test
bun run lint
bun run --cwd packages/cli build
bun run --cwd packages/electron bundle
bun run --cwd packages/claude-desktop pack
```

The six type-check gates remain separate. Shared strict/module defaults live in
the root TypeScript base; package targets/includes/environment types stay local.
CLI embedded archive and Admin staged resources use the same managed/seed-once
allowlists and an equality/bytes test. Generated output is not source and does
not grant permission to delete user state.

`scripts/dev-setup.sh` prepares a disposable development home using the same
installer. Set `FH_DEV_HOME` to an explicit scratch directory and use free ports.
The source-only `compose.dev.yml` adds build instructions without changing the
two-file installed runtime. No private homes, keys or ignored state are source inputs.

See [tests](testing-workflow.md), [release gates](../operations/release.md),
[configuration](environment-and-mounts.md) and [the MIT license](../../LICENSE).
