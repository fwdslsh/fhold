# Architecture

fhold is a personal OpenCode agent with persistent knowledge and recurring
work. It uses three runtime images, not a hosted control-plane platform.

```text
trusted OpenCode client ───────────────────────────────> Assistant
external MCP client ──> Guardian ──> policy profile ──> Assistant
Discord/Slack ──> Portal ──> Guardian MCP ──────────────┘
CLI / optional local Admin ──> shared management services
                               ├─ hosting adapter ──> Docker / SSH / ACA
                               └─ agent/app adapters ──> native interfaces
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
does not reconcile or create keys. Admin has no server, tray, standalone background
service or automatic window resizing; recent instances are local preferences only.
Its Settings page manages host connections and the app's standard Electron
AppImage updater. Stable is the default channel, and automatic checks/downloads
run only while Admin is open. Applying an app update does not update containers,
change an instance or install a remote CLI.

Hosting and agent management have separate contracts. Hosting discovers and
observes deployments and owns their lifecycle. Agent services own native AI
accounts, model preferences and readiness; app services own Guardian/Portal
configuration. Data operations retain separate portable-content, stopped-instance
archive and same-instance recovery contracts. A selected session composes those
operations without requiring every deployment to have a Docker home.

The common status model reports supported operations and their current
availability independently. Missing optional observations are not false/off
configuration. Ordinary instance pages do not choose a different management mode
based on the hosting platform. Read-only host inspection never connects to an idle
agent; explicit agent access owns any HTTP requests or temporary transport resources.
Closing that session releases its own resources without issuing another deployment
action. See the [management design](hosting-agent-management-design.md) for contracts,
ownership, extension patterns and the remaining ACA transport limits.

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
