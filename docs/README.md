# fhold documentation

- [Install and first agent](installation.md): Linux source/artifacts and provider readiness.
- [Manage fhold](managing-fhold.md): instance selection, lifecycle, schedules, backup and recovery.
- [Ephemeral Assistant recovery](assistant-recovery.md): directory/Blob destinations, initialization, scheduling, ownership and verification.
- [Portable backup review](technical/portable-backup-review.md): intended use, limitations and improvement findings.
- [Ephemeral Assistant runtime plan](technical/ephemeral-assistant-plan.md): host-independent scheduler/recovery controls, SQLite-native backups and external host responsibilities.
- [Ephemeral implementation review](technical/ephemeral-assistant-implementation-review.md): current code ownership, reusable tests and remaining qualification gates.
- [MCP and external clients](remote-mcp.md), [Claude Desktop bridge](claude-desktop.md).
- [Discord](portals/discord-setup.md) and [Slack](portals/slack-setup.md).
- [Experimental native remote workers](native-remote-access.md).
- [Built-in harness plugins and keep-alive](harness-plugins.md): AKM, immutable skills, native activity and portable HTTP heartbeats.
- [Architecture](technical/architecture.md) and [core principles](technical/core-principles.md).
- [Configuration, environment and mounts](technical/environment-and-mounts.md).
- [Native OpenCode configuration](technical/opencode-configuration.md).
- [MCP API reference](technical/api-spec.md).
- [Dependencies and development](technical/package-management.md), [tests](technical/testing-workflow.md).
- [Admin verification](operations/admin-setup-verification.md) and [release gates](operations/release.md).
- [Current alpha qualification and limits](operations/alpha-qualification.md).

Canonical source and contributions live at [fwdslsh/fhold](https://github.com/fwdslsh/fhold).
The [Linux alpha release](https://github.com/fwdslsh/fhold/releases/tag/0.1.2610040821-alpha.3)
includes CLI/Admin downloads and matching public Docker Hub images. Native x64
and ARM64 CI test the runtime images and CLI. ARM64 Admin startup and non-Linux
packaging remain unqualified; earlier local qualification is historical evidence.

Host-specific deployment scripts and third-party addon installers are not part
of fhold's image, CLI/Admin or product test suite. The recovery documents retain
the generic runtime contracts and external host responsibilities.
