# f/hold

A home for your personal AI. **fhold** combines one persistent OpenCode agent,
AKM knowledge and recurring work in a single default Assistant container.

Canonical source: [fwdslsh/fhold on GitHub](https://github.com/fwdslsh/fhold).
Linux alpha: [0.1.2610040821-alpha.3](https://github.com/fwdslsh/fhold/releases/tag/0.1.2610040821-alpha.3).
Download a standalone CLI or optional Admin AppImage for x64 or ARM64.
Fresh installs use the matching public [Docker Hub images](https://hub.docker.com/r/fwdslsh/fhold-assistant)
automatically. No npm installation or Docker Hub account is required.
Windows and macOS packaging is deferred. See the [release notes](CHANGELOG.md)
and [reviewed dependency exceptions](docs/operations/release.md#reviewed-runtime-advisories)
for this alpha's limits.

Use [Installation](docs/installation.md) for downloads and first setup,
[Managing fhold](docs/managing-fhold.md) for lifecycle, knowledge and recovery,
and [the documentation map](docs/README.md) for connections and technical details.

Optional Guardian supplies authenticated, policy-scoped MCP. One Portal image
adds Discord and Slack. The local Admin utility manages setup and settings,
with a welcome/instance picker; it is not a chat server or background updater.
Trusted OpenCode and experimental native Codex/Claude workers bypass Guardian.
Both native supervisors start by default; either can be explicitly disabled.
Native sign-in, workspace trust and consent remain explicit user decisions.

New named homes live under `~/fhold/instances/<name>`, leaving `~/fhold` available
for backups, docs and other local files. The source CLI accepts
`fhold --instance personal-agent install` or an absolute instance path. Selection
is argument → optional `FH_HOME` → current directory, so one shell can manage
multiple instances without exporting variables. Admin's unnamed default is
`~/fhold/instances/default`; its folder picker still supports any custom location.
Published alpha.3 does not have the new selector yet; see [installation](docs/installation.md#select-an-instance).
Existing homes are never moved automatically. Different homes receive separate
Compose projects. Welcome can create another instance; name it, accept or change
the suggested folder, and setup chooses free ports. Manual port overrides are
under Advanced. `install --name` overrides the container/hostname identity,
not the selected directory. No second instance-name registry is introduced.
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
