# f/hold

A home for your personal AI. **fhold** combines one persistent OpenCode agent,
AKM knowledge and recurring work in a single default Assistant container.

Canonical source: [fwdslsh/fhold on GitHub](https://github.com/fwdslsh/fhold).
Current source candidate: `0.1.2610040637-alpha.3` (unreleased).
Linux is supported through local source builds. Public binary downloads and
container image publishing are not configured; the CLI is a standalone executable,
not an npm bootstrap package. Windows and macOS packaging is deferred.
Release qualification is currently blocked by [upstream npm dependency
advisories](docs/operations/release.md#runtime-release-blockers).
The latest qualified Linux artifacts and all three images are
`0.1.2610040221-alpha.2`. The [qualification record](docs/operations/alpha-qualification.md)
separates that evidence from changed source and documents ARM64 build-only limits.

Use [Installation](docs/installation.md) for a local build and first setup,
[Managing fhold](docs/managing-fhold.md) for lifecycle, knowledge and recovery,
and [the documentation map](docs/README.md) for connections and technical details.

Optional Guardian supplies authenticated, policy-scoped MCP. One Portal image
adds Discord and Slack. The local Admin utility manages setup and settings,
with a welcome/instance picker; it is not a chat server or background updater.
Trusted OpenCode and experimental native Codex/Claude workers bypass Guardian.
Both native supervisors start by default; either can be explicitly disabled.
Native sign-in, workspace trust and consent remain explicit user decisions.

All instance data lives below `FH_HOME` (default `~/.fhold`). Different homes
receive separate Compose projects. Welcome can create another instance in a
chosen folder; name it and setup chooses available ports automatically.
Manual port overrides are under Advanced. CLI supports
`fhold install --name personal-agent`. The name sets container naming and the
Assistant's hostname without another configuration layer.
Never point fhold at a foreign or unrelated nonempty home. Supported portable
restore requires fhold's own backup manifest; no old-product import is provided.

For externally managed ephemeral containers, opt-in [Assistant recovery](docs/assistant-recovery.md)
uses directory or Blob destinations while working SQLite stays local. Its
independent backup timer keeps running when user scheduling is disabled. It
adds no cloud management tools, mandatory sidecars or Admin settings.

## Develop

```bash
bun install --frozen-lockfile
bun run check
bun run test
bun run lint
bun run --cwd packages/cli build
bun run --cwd packages/electron bundle
```

See [testing](docs/technical/testing-workflow.md), [release gates](docs/operations/release.md),
and [architecture/security](docs/technical/core-principles.md). Exact tool pins
live in package manifests and the single lockfile, not this README.

Owned source is licensed under MIT; see [LICENSE](LICENSE). Third-party tools
and dependencies retain their own licenses.
