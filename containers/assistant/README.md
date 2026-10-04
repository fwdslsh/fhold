# Assistant image

The active image is built from `Dockerfile`.

It contains:

- OpenCode;
- AKM CLI;
- image-baked standard AKM plugins for OpenCode, Codex and Claude Code;
- pinned native Codex and Claude Code workers, experimental with default-on supervisors;
- supercronic; and
- minimal runtime utilities.

The entrypoint validates its managed configuration and file-backed OpenCode
password, synchronizes user task sources, starts supercronic, and starts the
native OpenCode server. It performs no package installation or network download.
Native worker accounts, workspace consent and Codex hook review remain explicit
setup choices. A failed optional worker never stops OpenCode or the scheduler.
`FH_CODEX_REMOTE=0` or `FH_CLAUDE_REMOTE=0` skips that supervisor without deleting
its account state. Neither variable is needed to sign in or for normal startup.
OpenCode, AKM, Codex and Claude have standard `/usr/local/bin` launchers so they
remain available in login shells that reset the image's `PATH`.

Assistant runs as the configured non-root operator identity, drops all
capabilities, and receives no Docker socket, Admin credential, Guardian token,
or portal token. Its authenticated host port defaults to loopback; StackConfig
may deliberately bind it to another exact host address for direct native
OpenCode clients.

Persistent mounts are the Assistant home, operator OpenCode/AKM configuration,
knowledge, AKM state, and workspace. Managed configuration is read-only.
Provider `auth.json` is intentionally Assistant-readable; delegated ingress
credentials are not.

Managed Guardian sessions select one of three Assistant profiles: tool-disabled
`remote`, read-only `remote-read`, or permission-inheriting `remote-full`.
