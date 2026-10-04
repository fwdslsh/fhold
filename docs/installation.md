# Installation

Use a non-root Linux account with Docker Engine and Compose v2. Download the
matching x64 or ARM64 CLI or Admin AppImage from the
[GitHub release](https://github.com/fwdslsh/fhold/releases/tag/0.1.2610040821-alpha.3).
The release includes checksums and an asset manifest. The CLI is a standalone
executable; installed releases do not require Bun, Node.js or npm on the host.

For example, on Linux x64:

```bash
curl -fL -o fhold https://github.com/fwdslsh/fhold/releases/download/0.1.2610040821-alpha.3/fhold-cli-linux-x64
chmod +x fhold
./fhold install --name personal-agent
./fhold setup
```

Use `fhold-cli-linux-arm64` on ARM64. CLI and Admin pull the matching pinned
`fwdslsh/fhold-assistant` image from public Docker Hub; Guardian and Portal images
are pulled only when enabled. A Docker Hub login is not required. For Admin,
make the downloaded `.AppImage` executable and launch it, then choose **Create
new instance**. Keep the CLI somewhere on your PATH to use the shorter commands
below. An AI provider supported by OpenCode is required for assistant responses.

## Optional source build

Use a non-root Linux account, Docker Engine with Compose v2, Bun for source
builds, native Node.js 22.12+ for Electron tooling, and an AI provider supported
by OpenCode. Exact versions are declared
in manifests and the root lockfile.

```bash
git clone https://github.com/fwdslsh/fhold.git
cd fhold
bun install --frozen-lockfile
bun run --cwd packages/cli build
fhold_build_version="$(node -p 'require("./package.json").version')"
fhold_build_revision="$(git rev-parse HEAD)"
fhold_build_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker build --build-arg PLATFORM_VERSION="$fhold_build_version" --build-arg VCS_REF="$fhold_build_revision" --build-arg BUILD_DATE="$fhold_build_date" -f containers/assistant/Dockerfile -t "fhold/fhold-assistant:$fhold_build_version" .
docker build --build-arg GUARDIAN_VERSION="$fhold_build_version" --build-arg VCS_REF="$fhold_build_revision" --build-arg BUILD_DATE="$fhold_build_date" -f containers/guardian/Dockerfile -t "fhold/fhold-guardian:$fhold_build_version" .
docker build --build-arg PLATFORM_VERSION="$fhold_build_version" --build-arg VCS_REF="$fhold_build_revision" --build-arg BUILD_DATE="$fhold_build_date" -f containers/portal/Dockerfile -t "fhold/fhold-portal:$fhold_build_version" .
./packages/cli/dist/fhold-cli --version
FH_IMAGE_NAMESPACE=fhold ./packages/cli/dist/fhold-cli install --no-start
./packages/cli/dist/fhold-cli setup
```

These are local source-build instructions, not an identical-byte release retry.
Do not overwrite an existing frozen candidate's images or artifacts. Changed
source/content needs a new version following [release operations](operations/release.md).
Only the exact runtime revision and artifacts recorded in
[Admin/artifact qualification](operations/alpha-qualification.md) or the
[Assistant recovery qualification](assistant-recovery.md#qualification-limits) carry that qualification;
building an arbitrary checkout does not inherit it.

Build the matching local images before setup or start. The persisted literal
`fhold` namespace never pulls during activation, and ordinary update uses those
local builds without registry contact. A missing image requires a local build;
explicit `update --pull` is refused rather than treating `fhold/` as Docker Hub.

The home defaults to `~/.fhold`. Set `FH_HOME` to an absolute directory for an
explicit instance. CLI and Admin derive the same stable per-home Compose
project. Give a new instance a name with `fhold install --name personal-agent`
or the **Instance name** field in Admin setup. The name is persisted in
`deployment.projectName`, produces containers such as `personal-agent-assistant-1`
and sets the Assistant's OS hostname to `personal-agent`. Use lowercase letters,
numbers and hyphens, up to 63 characters. Omitting a name in CLI keeps the
unique per-home default. Names are chosen during installation; existing homes
keep their project identity. Additional instances need distinct names. Fresh setup
prefers ports 3810/3830; if either is already in use, it chooses an available pair
and saves those exact ports. CLI `install --config` preserves explicitly supplied
ports instead. Existing installations keep their ports on refresh and update.
Foreign/unrelated nonempty folders are refused without adoption.
The compiled CLI does not automatically load the invoking directory's `.env`
or `bunfig.toml`; set intended environment variables explicitly in the shell.

Assistant is the only default container. Setup delegates provider sign-in to
OpenCode and completes only after a real no-tool request succeeds. Normal
provider usage may be billed. OpenCode owns authentication and models; fhold
does not introduce another provider credential format.

```bash
fhold provider list
fhold provider login
fhold provider key <provider> --key-file /private/path/to/key
fhold provider test
fhold doctor --readiness
```

Use `--key-file -` for standard input. Do not paste keys into command arguments.
Native auth persists under `knowledge/secrets/auth.json`.

## Optional local Admin

```bash
bun run --cwd packages/electron bundle
bun run --cwd packages/electron start
```

Admin opens at Welcome: choose the default, previous/recent instance or another
folder, or expand **Create new instance**. Choose a folder or enter a full path,
then continue to setup, name the instance and confirm **Install fhold**. Port
selection is automatic; expand **Advanced** and turn off automatic selection
only if you need specific ports. New setup refuses non-empty folders and rejects a
name already used by Docker before writing installation files. Folder selection
alone does not install or start anything. An empty folder opens setup; a
compatible fhold home opens management. Provider authentication
and readiness use the same Assistant as CLI. A startup/port failure offers an
explicit retry, not reinstall-over-data.

For a verified Linux package, use `bun run --cwd packages/electron build:linux`.
Actual packaged startup requires the release smoke gate; a bundle alone is not
a packaged-release claim.

## Choose a client

Open OpenCode for trusted native access. Guardian MCP and portals are optional
and policy-scoped; see [connections](remote-mcp.md), [Discord](portals/discord-setup.md),
[Slack](portals/slack-setup.md) and [native remote workers](native-remote-access.md).

For supported portable backups, initialize a fresh home with `--no-start`,
preview and apply `fhold restore` before completing setup. See
[management and recovery](managing-fhold.md). Raw folders and foreign manifests
are not accepted. Windows/macOS distribution requires future native packaging
and release verification; public source availability does not qualify those hosts.
