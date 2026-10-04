# Architecture

fhold is a personal OpenCode agent with persistent knowledge and recurring
work. It uses three runtime images, not a hosted control-plane platform.

```text
trusted OpenCode client ───────────────────────────────> Assistant
external MCP client ──> Guardian ──> policy profile ──> Assistant
Discord/Slack ──> Portal ──> Guardian MCP ──────────────┘
CLI / optional local Admin ──> shared library ──> Docker Compose
AKM + supercronic ──> restricted scheduled work ───────┘
```

Assistant is the only default container: OpenCode owns providers/auth/models,
AKM owns knowledge/task definitions and supercronic executes recurring work.
Optional image-baked Codex/Claude native workers share the trusted workspace,
bypass Guardian and remain experimental. Both supervisors default on; explicit
off choices remain off. Native sign-in and consent are still required. Their failure
must not disrupt OpenCode or scheduling.

Guardian authenticates named credentials or verified OAuth identities, selects
`chat`/`read`/`full` policy, screens hostile input and owns expiring scoped handles.
It exposes MCP at `/mcp`, health and protected-resource metadata. It is not a
model proxy or arbitrary OpenCode route passthrough. Portal contains Discord
and Slack adapters and receives only their explicitly needed credential keys.

CLI and Admin call the same host library for install, configuration, credential
changes and own-backup restore. Per-home locks serialize mutations. Inspection
does not reconcile or create keys. Admin has no server, tray, background updater
or automatic window resizing; recent instances are local preferences only.

`state/stack.json` owns fhold deployment intent, including product identity,
project/image selection, Assistant settings, gateway, portal scope and named
access policies. `state/stack.env` and portal keyrings are derived runtime inputs,
not another editable settings API. OpenCode, AKM, OAuth and portal maps retain
their native/operator formats.
Generated private `state/installation.json` records release and managed-image
baselines for update; it is not a second installation discriminator or fallback.

The sole managed Compose file is
`packages/skeleton/system/stack/stack.compose.yml`; the sole user overlay is
`config/stack/custom.compose.yml`. Profiles are exactly `gateway`, `discord`
and `slack`. The source-only development build override is not an installed layer.

See [core principles](core-principles.md) for security/lifecycle invariants,
[configuration and mounts](environment-and-mounts.md), [API](api-spec.md) and
[recovery](../managing-fhold.md). There is no compatibility edge, model server,
VPN, browser chat or public extension package graph.
