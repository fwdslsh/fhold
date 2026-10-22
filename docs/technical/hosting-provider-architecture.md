# Hosting and agent management architecture

CLI and Admin compose hosting, agent, app and data operations in the shared
library. They use one instance snapshot and the same operation descriptions.
Local Docker is the default; SSH Docker and experimental Azure Container Apps
are built-in host adapters.

The [management design](hosting-agent-management-design.md) records the reasons,
contracts and migration decisions. The [hosting guide](../hosting.md) describes
the user workflow. See the [verification record](../operations/hosting-agent-management-verification.md)
for what was tested and the ACA execution limitation.

## Composition and dependency direction

```text
CLI / Admin main + preload
             |
     composed instance session
     common status + typed operations
       /       |       |       \
    hosting   agent   apps     data
       |       |       |       |
    host      native  existing existing
    adapters  APIs    policies engines
```

The composition root is
[`hosting/provider.ts`](../../packages/lib/src/hosting/provider.ts).
It binds independent host functions and application services for the selected
connection and target. The common contract lives in
[`management/contracts.ts`](../../packages/lib/src/management/contracts.ts);
[`management/instance-session.ts`](../../packages/lib/src/management/instance-session.ts)
assembles observations and named operations. Feature views use those contracts,
not a provider-name branch or optional full-management mode.

Concrete host adapters do not construct the local management service. Management
services do not import the concrete host adapters. Interfaces carry the needed
operations into the service; the composition root imports both sides. This
removes the former circular dependency between the local Docker adapter and
instance management.

## Responsibility boundaries

| Owner | Responsibility |
| --- | --- |
| Hosting | Discovery, exact target selection, connection diagnostics, platform inventory/logs, lifecycle and available deployment operations. |
| Agent | Native AI accounts, effective model/configuration, explicit readiness tests, owned preferences and native worker setup. |
| Apps | Guardian identities/policies and Portal tokens, allowlists and user mappings. These are not Assistant-owned settings. |
| Data | Portable-content transfer, entire stopped-instance archives and same-instance runtime recovery, preserving each format's guarantees. |
| Application workflows | Coordinate multiple owners, confirmation, pending activation, request lifetime and partial results. |
| Transport | Native SSH framing/forwarding/transfers or explicit authenticated HTTPS, without interpreting business policy. |

Docker homes, StackConfig, local locks, Compose and applied-runtime receipts stay
with their owning Docker implementation. SSH executes the same services on the
remote machine through the installed fhold CLI. ACA has a resource locator and
platform observations; it receives no synthetic home or Compose configuration.

Connections, instances and storage destinations remain distinct. Native SSH/Azure
credentials stay on the management computer. OpenCode owns AI-account credentials.
Recovery storage credentials grant storage access, not hosting authority.

## Observations and capabilities

A snapshot distinguishes known, not-inspected, unavailable and unsupported facts.
A temporarily offline agent is not an unsupported platform. An unread account
inventory is not an empty account list. Optional failures do not erase healthy
deployment observations or become new startup gates.

The same registered operation slots describe support and current availability.
CLI and Admin invoke named, typed operations and render specific unavailable
reasons. Unsupported controls retain their position in the common Overview,
Agent settings, Apps and System pages.

Passive inspection observes the hosting platform and already known facts. It
does not contact OpenCode ingress, acquire a native setup process or wake an
idle replica. Explicit agent access owns requests, native auth attempts and
temporary transports. Switching targets discards late results and browser events.
A submitted mutation stays bound to its original target; a lost response does
not authorize replay.

Keep deployment acceptance/completion, agent readiness and recovery durability
separate. A platform's accepted Stop request does not establish a released
recovery owner. Configured image intent, observed running images and the
managing tool's bundled update cohort have distinct provenance.

Public client links live in a redacted app observation, not in acquired native
access. Seeing a published URL never authorizes an automatic provider read or SSH
forward. A user can explicitly open OpenCode in one click to acquire that route.
Standalone app-policy edits are typed app operations; the UI does not need a
Docker configuration just to change a credential's permissions.

## Native agent access

[`management/agent-access.ts`](../../packages/lib/src/management/agent-access.ts)
contains the native OpenCode HTTP client. It takes a selected endpoint and a
private authorization source; it does not derive a Docker home. Existing
host-backed functions resolve native credentials on the owning local/SSH host.
Explicit HTTPS connections use a private session credential and do not copy it
into recents or instance metadata.

OpenCode's general preference changes are still native watched JSONC edits.
[`management/agent-models.ts`](../../packages/lib/src/management/agent-models.ts)
defines the owned preference-document boundary; host code preserves comments,
unrelated keys and managed-policy precedence. Results distinguish saved from
effective state without an automatic container restart or destructive rollback.

Native Claude/Codex login processes and vendor consent remain native. Temporary
login cancellation/disposal does not apply deployment settings. Setup is bound
to the originally selected running container; replacement during sign-in
invalidates the pending startup change.

## Transport compatibility and ACA limits

The fixed SSH machine endpoint advertises its wire version and operation names.
The persistent session preserves OAuth attempts and native prompt processes
across calls. Request/result types are shared; unknown JSON is validated at the
boundary. Keep supported old wire shapes explicitly compatible instead of
requiring identical desktop, remote CLI and image releases.

ACA hosting uses the native workstation Azure CLI. The reachable OpenCode HTTP
subset is independent of deployment management, but HTTPS does not provide
native preference-file writes or stateful CLI setup. The tested Azure CLI console
requires a terminal and is not qualified as a typed unattended transport.
Those operations retain specific capability explanations; no console scraping,
management daemon or image-baked cloud tooling is introduced.

Provisioning, ACA deployment-template editing, mount/secret changes and image
rollout remain external deployment responsibilities. Full Docker-home archives
do not pretend to export an entire ACA deployment. Runtime checkpoint storage
and ownership remain with the Assistant's existing recovery engine.

## Adding a provider or operation

For a host provider, add its validated connection/locator and onboarding fields,
implement host discovery/observation and supported operations, bind qualified
agent routes, and register it at the composition root. Run the shared behavior
tests and native environment qualification. Ordinary feature screens and agent
use cases should not need provider-specific edits.

For an agent operation, define its input/result and capability slot, implement
the domain use case against its narrow ports, bind the qualified implementations
and expose the same action to CLI/Admin. Add tests for target binding, partial
failure, cancellation and native state preservation. Extend existing engines
and native interfaces rather than adding another registry or runtime service.
