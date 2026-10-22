# Hosting-provider architecture for CLI and Admin

Status: the shared host-side foundation, local lifecycle extraction, SSH machine
transport/discovery/lifecycle, shared recents and an experimental ACA adapter are
implemented. SSH now additionally shares the normal Admin/CLI instance operations,
setup, image updates, private archive transfer and automatic browser forwarding.
See [the supported user path](../hosting.md) for current behavior; phased stages
below describe the original investigation, not current SSH capability limits.
Live ACA qualification remains separate. ACA Start/Stop submit native accepted/pending
requests; they do not consume ARM LRO headers or establish replica drain.
Source baseline: `6bc54c9bfe2367b04c11dda3875137f35b6d74e9` (main).
Official platform documentation reviewed October 11, 2026. This investigation
used repository source and public documentation only: no SSH connection, Docker
host operation, Azure account, credential file or live instance was inspected.
AKM was unavailable, so no curate/show/feedback commands were run.

### October 21 implementation refinement

Azure now has native browser onboarding, subscription/resource-group choices,
layered connection diagnostics, revision-aware console logs, interactive CLI
console access and confirmed single-active-revision restart. Read-only inventory
and status remain distinct from opening an agent or restarting it. See the user
guide for supported operations; creation, image replacement, deployment templates
and recovery ownership remain outside this slice.

The provider composition root is `packages/lib/src/hosting/provider.ts`. Adapters
own discovery, typed target selection, lifecycle and diagnostics. Optional
connection onboarding, interactive console and full instance-file management are
separate capabilities, not methods that every cloud must pretend to implement.
CLI's common remote verbs use `InstanceSession`; Admin chooses instance-file
administration by the presence of `management`, not a provider-name check. Named
operation lists replace ambiguous `capabilities(restart, local)` flags and remove
ACA-specific error text from the generic capability helper.
SSH transport primitives are separate from its adapter/domain, eliminating the
adapter-to-management import cycle. Remote directory setup is an optional provider
interface rather than SSH RPC construction inside Electron.

To add another provider, define its connection/target locator and parser, supply
an adapter and register it in this composition root. Add only its necessary
connection fields to the chooser. Implement optional interfaces only where the
platform genuinely supports them; ordinary status/log/lifecycle/console dispatch
and diagnostic rendering need no new vendor switch. Test native argument arrays,
scope/target separation, partial diagnostics, confirmation and no mutation replay.
This is a small built-in adapter boundary, not a configurable plugin framework or
a remote instance-settings mirror.

## Recommendation

Keep local Docker as the primary, default installation and management path.
Introduce one small, built-in **host-side hosting boundary** in `@fhold/lib`,
shared by CLI and Electron main. Extract today's local implementation first;
then add an SSH-Docker adapter that invokes the supported remote fhold CLI at
the remote home. Consider an optional Azure Container Apps (ACA) adapter only
after those contracts are proven. ACA initially means an explicitly selected,
externally provisioned **standalone Assistant**, not a translated Compose stack.

The ordinary flow is:

```text
choose hosting connection -> list compatible instances -> select target
                                                      -> CLI or local Admin
                                                           |
                                            shared hosting boundary
                                             /        |          \
                                      local Docker  SSH CLI    Azure CLI/ARM
                                      local home    remote home ACA resource
```

The adapters are analogous to the small directory/Blob selector in
[`containers/assistant/recovery/storage.mjs`](../../containers/assistant/recovery/storage.mjs),
not a plugin marketplace. Storage and hosting remain different responsibilities:
recovery stores publish checkpoints; hosting adapters discover and operate
deployment resources. A Blob URL does not identify an ACA app and an Azure
management login does not grant recovery-storage authority.

This user-requested direction expands optional CLI/Admin host management, not
the Assistant runtime. The [core principles](core-principles.md) describe that
host-side scope. The baseline below predates these adapters; the implementation
status at the top and [user guide](../hosting.md) describe the shipped scope.
This document extends the existing
[SSH proposal](ssh-management-proposal.md); use it as the common design rather
than developing a separate SSH architecture.

## Baseline before this refactor

At the source baseline, the product is local-home orchestration. There is no hosting provider
selector, SSH management backend or ACA management adapter. The existing
`provider` commands and `admin/providers.js` manage **AI services through
OpenCode**, not hosting. `remote.ts` and the `remote` command manage vendor-native
Claude/Codex workers inside Assistant, not a remote Docker host. Guardian MCP
is guarded agent access, not a deployment-management endpoint.

Local management has substantial contracts that a transport switch alone
cannot reproduce:

- `FholdState` contains real local directories; home resolution uses local
  `realpathSync`, and managed files, secrets, backup sources and configuration
  are accessed with `node:fs`.
- Compose reads the managed file, optional operator overlay and derived
  `state/stack.env` on that host. `state/stack.json`, with `product: "fhold"`,
  owns stack intent. The four services use exact home-relative bind sources.
- The lifecycle lock is a local file with a local process PID. Ownership checks
  compare Compose project labels with the selected stack working directory.
- Startup audits resolved Compose, verifies selected image capabilities, and
  records applied startup inputs only after successful healthy activation.
  Saving settings and applying them are separate operations.
- Native API helpers derive a host endpoint from saved bind/port intent and
  read that home's private OpenCode password. Model discovery executes inside
  Assistant; native preference changes also access host files.
- Admin recents contain `{ kind: 'local', homeDir }`, not resources. Opening a
  compatible home is read-only; it never installs, starts or adopts another stack.
  Unavailable previous homes return to Welcome.

Those contracts remain the local adapter's implementation, not assumptions in
the shared hosting types. See [environment and mounts](environment-and-mounts.md),
[architecture](architecture.md), and [Assistant recovery](../assistant-recovery.md).

### Source modification seams

These are concrete owning components at the baseline, not evidence that the
proposed abstraction exists. Line anchors below are pinned to that revision.

| Seam | Current owner and proposed change |
| --- | --- |
| Home versus target | [`foundation.ts:37`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/lib/src/control-plane/foundation.ts#L37), `resolveFholdHome` / `createFholdState`: keep strictly local; never pass remote paths or ARM IDs through them. Add hosting target types separately. |
| CLI selection | [`instance.ts:32`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/cli/src/lib/instance.ts#L32), `instanceArguments`, `resolveInstanceHome`, and [`main.ts`](../../packages/cli/src/main.ts): resolve a hosting connection/target once before command dispatch; preserve today's local `--name`, `FH_HOME`, cwd behavior. |
| Shared domain/export boundary | [`packages/lib/src/index.ts`](../../packages/lib/src/index.ts), [`operations.ts:107`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/lib/src/control-plane/operations.ts#L107), `saveStackIntent`: expose a small hosting facade; keep current local validation/locking and baseline checks behind its local adapter. |
| Lifecycle | [`activation.ts:41`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/lib/src/control-plane/activation.ts#L41), `activateComposeCommand` / `deactivateComposeCommand`; [`lifecycle.ts`](../../packages/cli/src/commands/lifecycle.ts): facade delegates local calls without changing image audit, health, orphan handling or stopped-state behavior. |
| Process/Docker target | [`docker.ts:48`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/lib/src/control-plane/docker.ts#L48), `composeProcessEnvironment`, `runDocker`, streaming, project ownership; [`compose.ts`](../../packages/lib/src/control-plane/compose.ts): make daemon selection explicit and consistent for every read/write/image/one-off command. Keep this Docker-specific layer out of ACA. |
| Install/update | [`install.ts:24`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/lib/src/control-plane/install.ts#L24), `installHome`; [`update.ts:19`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/lib/src/control-plane/update.ts#L19), `updateHome`; [`seed-manifest.ts`](../../packages/lib/src/control-plane/seed-manifest.ts): stay local/remote-host CLI operations. Do not reuse them to seed an ACA app or local shadow home. |
| Pending apply | [`runtime-revision.ts:37`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/lib/src/control-plane/runtime-revision.ts#L37), `runtimeRevision`, activation/applied receipts, `restartStatus`: remote CLI owns remote receipts; ACA reports deployment/revision state separately, never a fabricated local digest. |
| Native agent connection | [`opencode.ts:89`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/lib/src/control-plane/opencode.ts#L89), `assistantEndpoint` / request/auth; [`connection.ts`](../../packages/lib/src/control-plane/connection.ts), [`provider-settings.ts`](../../packages/lib/src/control-plane/provider-settings.ts): isolate explicit reachable endpoint/credential resolution and target-bound narrow settings operations; never create a second model registry. |
| Admin host orchestration | [`admin-app.ts:94`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/electron/src/admin-app.ts#L94), `managedState`, `handleAdmin`, `adminSnapshot`, `runAdminAction`, `registerAdminIpc`: dispatch through selected target; retain sender checks, confirmation and in-flight exclusion. `admin-main.ts` remains the app bootstrap, not an adapter location. |
| Admin type/preload contract | [`admin-types.ts:54`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/electron/src/admin-types.ts#L54), `AdminInstance`, `AdminSnapshot`, `AdminApi`; [`admin-preload.ts:6`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/electron/src/admin-preload.ts#L6): replace unconditional home/config fields with target-specific views and capabilities; expose named operations, not raw shell, Azure SDK or arbitrary IPC. |
| Selection and recents | [`admin-instances.ts:53`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/electron/src/admin-instances.ts#L53), `AdminInstances`, validators; [`admin/instances.js`](../../packages/electron/admin/instances.js): use full target identity rather than `homeDir` equality; preserve existing v1 local recents when preferences evolve. |
| Static Admin views | [`snapshot.js`](../../packages/electron/admin/snapshot.js), [`state.js`](../../packages/electron/admin/state.js), [`runtime.js`](../../packages/electron/admin/runtime.js), [`restart.js`](../../packages/electron/admin/restart.js), [`configuration.js`](../../packages/electron/admin/configuration.js), [`backup.js`](../../packages/electron/admin/backup.js), [`recovery.js`](../../packages/electron/admin/recovery.js): render capabilities and distinct state honestly; invalidate drafts/sign-ins/readiness on target changes. |
| Backup/history/recovery | [`backup.ts:197`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/lib/src/control-plane/backup.ts#L197), [`instance-backup.ts:373`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/lib/src/control-plane/instance-backup.ts#L373), [`history.ts`](../../packages/lib/src/control-plane/history.ts) / [`native-worker.ts`](../../packages/lib/src/control-plane/native-worker.ts), [`recovery.ts:168`](https://github.com/fwdslsh/fhold/blob/6bc54c9bfe2367b04c11dda3875137f35b6d74e9/packages/lib/src/control-plane/recovery.ts#L168): capability-gate host-file/offline operations, retaining their different manifests and authority contracts. |

Suggested new source organization is a small `packages/lib/src/hosting/` with
`types.ts`, `index.ts`, `local-docker.ts`, then `ssh-docker.ts` and optionally
`azure-container-apps.ts`. This is a proposed location, not a required package
graph. Avoid moving every filesystem helper or adding an abstract filesystem.
Extract the smallest common orchestration surface and reuse current functions.

## Connections, targets and homes are different

Use three concepts, with names that cannot be confused with model providers or
the existing app connections:

1. **Hosting connection:** access and discovery scope. Local Docker references
   an explicitly verified local engine/context. SSH references an operator's
   SSH alias and remote fhold executable. ACA references Azure cloud, tenant,
   subscription and optional resource-group/environment scope, using native
   host authentication. One connection can list several instances.
2. **Instance target:** a provider-scoped resource locator, validated at use.
   Local: canonical home plus its persisted project identity. SSH: connection
   reference plus remote-canonical home/project identity. ACA: fully qualified
   ARM resource ID plus reviewed Assistant container/runtime identity. Container
   IDs, revision names, replica IDs, FQDNs and display names are observations,
   not stable instance keys. An ARM ID can be reused after deletion; replacement
   must invalidate previous compatibility/ownership observations.
3. **`FH_HOME`:** a filesystem contract on the host that owns a managed Compose
   installation. It is not a universal cloud resource handle. Remote Docker's
   home exists on the remote host; ACA need not have a managed host home at all.

Keep connection descriptions and recent targets in one small host preference
file shared by CLI and Admin: `$XDG_CONFIG_HOME/fhold/hosting.json`, defaulting
to `~/.config/fhold/hosting.json` on Linux. It lives outside instance data and
backups. Bring existing Electron v1 recents across on the next explicit
preference save; no home migration or authoritative instance registry is needed.
Store locators, display hints and credential references, not keys, tokens or
native provider auth. Continue using OpenSSH/Docker/Azure's native host stores.
An OpenCode endpoint credential, when needed, is an explicit private-file
reference, separate from the hosting account; discovery does not retrieve it.
After connection settings change, discard old observations and resolve the
new target normally rather than reuse an old endpoint or running operation.

The implicit local connection should need no saved connection, onboarding,
Azure CLI or SSH prerequisite. Admin defaults to **This computer**, with an
optional named connection picker followed by its instance list. Illustrative
future syntax is `fhold --connection <host> --name <remote-name-or-path> status`:
retain the existing `--name`/`-n` instance selector, not a redundant `--instance`
flag. ACA may resolve a selected friendly name within the connection's scope,
with explicit resource-ID selection in its hosting command group for ambiguity.
Final syntax is an implementation decision. Conflicting selectors fail; remote
dispatch never globally changes `FH_HOME`, and the local no-argument install/
start behavior must not silently provision or start a remote target.

### Discovery, opening, adoption and creation

Discovery lists candidates in the chosen, bounded scope and is read-only. Local
discovery can inspect direct children of the ordinary instances root and known
recents, not scan the whole home directory. SSH discovery should ask the remote
CLI to inspect its normal root, explicit roots or a supplied home. Compose labels
are supporting evidence only; stopped homes with no containers also exist.
ACA discovery can list app metadata through the management API without reaching
the Assistant endpoint. Only tagged/reviewed candidates need detailed validation;
tags and image names alone never establish product ownership.

Opening selects a validated, existing instance. It does not write StackConfig,
initialize recovery, deploy images, assign identities, change ingress or start
anything. Compatibility includes product/runtime identity, declared deployment
shape and supported management/runtime versions, not just an agent-like name.
Unknown resources stay unsupported/inspect-only. Keep safe partial inspection
available when tools, capabilities or runtime access are missing. Account
permission failures, unreachable hosts and partial discovery are not an empty
list or proof of deletion. Recognition of an explicit remote home/resource ID
requires no new mandatory UUID registry.

Adoption is separate, explicit consent to manage a verified existing resource.
For SSH, require the remote fhold CLI and a compatible home; never adopt an
arbitrary Docker project. For ACA, retain external provisioner ownership by
default. Initial support may remember and inspect a compatible externally
declared Assistant without taking configuration ownership. Broader adoption
requires a preview of every field fhold would own and confirmation; do not
retag a foreign app or infer authority from recovery artifacts. No adoption
occurs simply because discovery returned a resource.

Creation is a separate confirmed operation with preflight, resource scope,
storage/security intent and cost/downtime disclosure. Local setup stays as
shipped. SSH host installation and ACA resource creation are deferred initially:
provide documented native/external provisioning workflows, not a disguised
fallback to local setup. Deletion is not required for this design and remains
outside initial capabilities, with existing path/resource-specific approval
rules unchanged.

## One capability-based host boundary

Use a closed set of built-in adapters selected once into a hosting session
bound to the chosen connection and instance. A small facade needs
connection preflight, bounded instance discovery, target inspection, named
operations, logs, and explicit client-access resolution. Optional operations
should be typed capabilities, not hundreds of booleans or a universal `run`
method accepting arbitrary shell/ARM requests. For example:

```ts
// Illustrative contract only, not current exported types.
type HostingKind = 'local-docker' | 'ssh-docker' | 'azure-container-apps';
type InstanceRef =
  | { kind: 'local-docker'; connectionId: string; homeDir: string }
  | { kind: 'ssh-docker'; connectionId: string; remoteHome: string }
  | { kind: 'azure-container-apps'; connectionId: string; resourceId: string };

type Availability =
  | { supported: true }
  | { supported: false; reason: string };

// Shared orchestration dispatches a closed union of named requests.
// Provider-specific settings remain inside their adapter-owned variants.
type HostingOperation =
  | { action: 'start' | 'stop' | 'restart'; confirmed: boolean }
  | { action: 'save-compose-intent'; config: StackConfig; baseline: StackConfig };

interface HostingProvider {
  listInstances(connection: HostingConnection): Promise<InstanceSummary[]>;
  open(connection: HostingConnection, ref: InstanceRef): Promise<InstanceSession>;
}

interface InstanceSession {
  readonly ref: InstanceRef;
  inspect(): Promise<InstanceSnapshot>;
  operate(request: HostingOperation): Promise<OperationResult>;
  logs(options: LogOptions): AsyncIterable<LogEntry>;
  clientAccess(): Promise<ClientAccess>;
}
```

These names describe the intended port, not a complete API definition. Derive
its request/result types from existing domain operations as they are moved,
with an operation-scoped AbortSignal/progress callback where needed. The
provider factory is a small static selector, like recovery's storage factory.
The session binds one immutable target; it is an in-process object, not a daemon.
`operate` accepts the closed typed union above, never shell text or arbitrary
HTTP requests. Domain operations such as AI service setup remain shared above
the adapter, using its native access/file-operation capabilities where supported.

This is one session/dispatch seam, not an abstract port for every existing helper.
Add named operations only when implemented and qualified; ACA would not accept
`save-compose-intent`. The facade checks capabilities again at invocation;
renderer hiding is not an authorization boundary. Determine available operations
from the adapter, deployment shape and required tools, not just provider name.
Let native SSH/Docker/Azure authorization enforce rights when an action runs;
do not build an IAM inventory or mandatory permission-probing layer. A denied
action does not disable unrelated inspection. Distinguish unsupported,
permission-denied, unavailable, busy and unknown outcome.

Share **behavior**, not every implementation detail: confirmation, target
binding, safe errors, operation progress, fresh baseline checks and honest
completion. Keep Compose profiles and overlays in Docker code; keep subscription,
revision and ARM details in ACA code. Native agent models/auth/settings remain
OpenCode-owned domain operations. No provider conditionals should spread across
every CLI subcommand or renderer form. Route supported operations at the facade;
keep local-only commands visibly local until their remote contract is real.

### Recommended initial capability envelope

This table is a proposed rollout contract, not a claim of current remote support.

| Operation | Local Docker | SSH-Docker first release | ACA first release |
| --- | --- | --- | --- |
| Discover/select/inspect | Existing homes; bounded root list can be added | Remote CLI homes/explicit path | Scoped ARM app metadata; validated Assistant only |
| Status and recent logs | Existing Compose/health behavior | Supported remote CLI status/log operations | Platform state/revisions/replicas, system versus console logs |
| Start/stop | Existing full stack actions | Same remote-host actions | Native ARM actions; qualify the actual shutdown/start workflow |
| Restart/apply update | Existing confirmed audited activation | Defer until remote completion/receipts proven | Initially unsupported; no rolling-revision shortcut |
| Save deployment settings | Existing StackConfig/baseline/pending path | Narrow remote CLI operations after parity tests | Read-only externally owned deployment view initially |
| Native agent/model setup | Existing native flow | Defer browser/PTY and host-file-dependent flows | Defer until endpoint, auth, file mutation and native consent flows qualified |
| Guardian/Portal management | Existing optional full-stack profiles | Only if installed and supported remotely | Absent for standalone Assistant; no fabricated bot/MCP parity |
| Host folder picker/open/edit | Actual local folders | No local picker; explicit remote path input only | No home folder; link to external deployment source/resource |
| Install/provision | Existing fresh local install | External host setup initially | External provisioning initially |
| Portable backup/restore | Existing own-manifest contract | Run remotely first, defer transfer/apply surface | Unsupported as local-home operation |
| Entire-instance export/import; offline history | Existing stopped-writer contracts | Separate future offline/transfer qualification | Unsupported; not a Compose home or portable checkpoint |
| Recovery status/coverage | Existing operations | Existing remote CLI diagnostics | Explicit running-replica diagnostics where supported; not wake-on-refresh |
| Recovery init/offline restore/unlock | Existing confirmed local operations | Existing remote CLI operations; integrated UI deferred | External operator workflow; never auto-unlock or init on first connection |
| Arbitrary exec or filesystem RPC | Not added | Not added | Not added; explicit native console handoff may be offered later |

ACA console availability is not evidence that its stdin, PTY, exit status,
timeouts or disconnected-session behavior can satisfy current Docker helpers.
Likewise a cloud management permission does not expose a stopped native SQLite
snapshot. Disable unsupported paths with a concise reason and useful external
handoff; do not surface empty forms or substitute a different backup operation.

## Remote Docker: supported transport, remote ownership

Docker supports SSH endpoints and named contexts; the remote SSH user must have
permission to access the daemon socket. Use operator-managed OpenSSH config and
host-key verification, not a public unauthenticated Docker TCP socket or new SSH
key store. [Docker's supported SSH transport](https://docs.docker.com/engine/security/protect-access/)
and [daemon exposure warning](https://docs.docker.com/engine/daemon/remote-access/)
describe the security boundary. Daemon access is powerful host authority, not
an agent credential; Assistant must never receive it.

Contexts can be selected per command with `--context`; do not globally execute
`docker context use` during selection. Ambient `DOCKER_HOST`, `DOCKER_CONTEXT`
and saved context state can change the daemon. The current Docker wrapper
rejects process-control values from `state/stack.env` but **inherits host process
environment** and does not bind every call to a selected connection. Extraction
must explicitly resolve/verify the local endpoint and propagate it consistently
to readiness, ownership, image inspection, Compose, exec and offline workers.
Refuse an ambient remote endpoint for a local home, or require explicit remote
selection; never silently act on it. Retain compatible local rootless/desktop
contexts rather than assume that every local daemon uses one Unix socket.
[Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/)
document the selection and override behavior.

Most importantly, Docker bind mounts address the **daemon host**, not the client
filesystem. Changing context does not transfer `state/stack.json`, Compose files,
secret files, ownership, locks, UID/GID, backup sources or workspace. Nor does it
make a remote loopback native API reachable locally.
[Docker bind-mount constraints](https://docs.docker.com/engine/storage/bind-mounts/)
rule out treating a local `FH_HOME` as the remote installation.

Choose **remote CLI execution** for full managed stacks:

- Run the installed, compatible remote fhold CLI under the operator's SSH
  account. Resolve homes remotely, inspect product/config compatibility before
  writes, and use the remote filesystem and lifecycle lock for mutations.
- Add a small supported machine interface to that CLI for wire-envelope version
  and capabilities, bounded discovery, snapshots/logs and reviewed named actions.
  JSON requests on stdin and typed JSON on stdout avoid scraping text tables.
  Different remote binary releases may interoperate when the wire envelope,
  action and home/runtime contract are compatible; do not require exact release
  equality or block useful read-only inspection for a missing write capability.
  This is an on-demand CLI entry point, not a hosted service, new network API or
  general RPC/file browser. It should call the same remote shared library.
- Invoke system OpenSSH with safe host options and a **fixed remote command**;
  remote home/action/config values go through the validated stdin envelope.
  `execFile('ssh', argv)` prevents a local shell but SSH still executes a remote
  command string via a shell: raw dynamic argv concatenation is not safe remote
  quoting. Reject option-like target aliases, preserve known-host checks, and
  qualify fixed-command behavior on supported remote shells. No `eval`, automatic
  trust acceptance or remote bootstrap/install on connection.
- Prefer noninteractive native SSH auth; missing keys/host trust should produce
  actionable guidance to complete native setup. Do not capture login files,
  inject passwords, weaken host-key checks or silently fall back to local work.
- Remote prerequisites are the supported CLI, Docker/Compose and actual home.
  Missing tools or incompatible envelopes disable the affected operation, not
  unrelated inspection or the local provider. No container-startup installs.

An alternative is local Compose rendering plus explicit remote file staging,
source mapping, locked atomic promotion and secret transfer. It creates a second
authoritative tree and more failure/recovery paths; reject it for the first
implementation. A Docker context remains useful for deliberate engine-only
inspection, but context-only mutation cannot provide the full fhold home contract.
Do not combine context operations and remote CLI operations against different
engines; bind and validate the same remote host/daemon/home identity.

For trusted native client access, remote CLI operations can keep the OpenCode
password on the remote host. A separately requested session-bound OpenSSH
forward may expose the remote API on local loopback, preserving native auth;
close it on switch/exit and do not change the remote bind or stack lifecycle.
Return explicit access scope, not a misleading local URL copied from the remote
config. Credential copying is never part of discovery/status. Browser OAuth,
native PTY sign-in and tunneled MCPB access require separate qualification.

## ACA: optional host-side management, not Compose emulation

### Standard tooling and API seams

Prefer the installed Azure CLI as an optional host prerequisite, with native
`az login`/device-code sign-in and explicit subscription/cloud/tenant scope.
No Azure package is required for local Docker. Never run `az account set` as a
global side effect of selecting an instance; supply the selected subscription
on operations and verify account scope before mutation. Login happens only on
explicit user action, never status refresh. No bespoke OAuth broker or host
token cache belongs in fhold.
[Azure CLI authentication](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli?view=azure-cli-latest)
is the supported human authentication path. Automation/service principal/federated
auth remains a native, explicitly configured host choice, not copied into Assistant.

Use `az containerapp list/show`, revision/replica inspection and narrow updates
where documented; require supported CLI/extension versions and refuse missing
functionality rather than dynamically install extensions during an operation.
Use JSON output with allowlisted projections; full resource JSON can contain
sensitive literal environment values or endpoint details.
[The current Container Apps CLI reference](https://learn.microsoft.com/en-us/cli/azure/containerapp?view=azure-cli-latest)
documents these commands and `exec`, but does not list an app-level
`az containerapp start`/`stop`. Job start/stop commands are a different resource
and must never be substituted.

The documented management interfaces provide concrete provider seams:

- Discovery: ARM
  `GET /subscriptions/{s}/resourceGroups/{g}/providers/Microsoft.App/containerApps`.
  Bound discovery to selected groups/environments and handle pagination before
  claiming a complete list. Project only IDs, compatibility markers and relevant
  observations. [ARM List By Resource Group](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/list-by-resource-group?view=rest-resource-manager-containerapps-2026-07-01).
- Start: ARM `POST {resourceId}/start?api-version=2026-07-01`; an accepted
  operation is not agent readiness or evidence of a running replica.
  [ARM Start](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/start?view=rest-resource-manager-containerapps-2026-07-01).
- Stop: ARM `POST {resourceId}/stop?api-version=2026-07-01`; `202` responses carry
  `Location` and `Retry-After`. Use `az rest` host-side when the supported CLI
  lacks a dedicated command. Follow documented long-running operation status
  and then inspect the resource; do not declare completion after request acceptance.
  [ARM Stop](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/stop?view=rest-resource-manager-containerapps-2026-07-01).
- Settings: ARM PATCH of the Container App is a deployment operation, not a
  native agent settings patch. Map only explicitly owned fields after review;
  retain unknown/custom environment, mounts, identity, command, ingress and
  sidecars. [ARM Update](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/update?view=rest-resource-manager-containerapps-2026-07-01).
- Exec: `az containerapp exec` targets a live revision/replica/container and
  requires an executable available in that image. Use the native console flow
  initially, not an assumed Docker-exec replacement. A scaled-zero app has no
  live replica to exec into; do not wake it implicitly. The management
  [Get Auth Token API](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/get-auth-token?view=rest-resource-manager-containerapps-2026-07-01)
  issues an expiring sensitive dev token, not an OpenCode/Guardian credential.
  Keep token/console transport handling inside supported Azure tooling rather
  than build a custom WebSocket client.
  [Container console](https://learn.microsoft.com/en-us/azure/container-apps/container-console).
- Logs: `az containerapp logs show` supports system/console, tail and follow;
  console output is revision/replica/container scoped, not automatically a
  complete resource history. Tail is limited to 0–300 messages. Retain both
  platform system and Assistant console logs for shutdown diagnosis; durable
  history needs externally configured log retention, not a local file fiction.
  [Log streaming](https://learn.microsoft.com/en-us/azure/container-apps/log-streaming).

`2026-07-01` is a documented current API version at review time, not a claim that
this app/region/account or an installed CLI has been tested against it. Pin and
qualify a supported management version in the adapter; return an actionable
unsupported-version error rather than broad fallback experiments. The REST
references do not make fhold's runtime recovery qualified on ACA.

Scope host Azure rights to selected resources and separate metadata reads,
log/exec actions, lifecycle and writes. Built-in roles differ; don't assume
Reader grants console access or an Operator grants deployment edits.
[Container Apps RBAC roles](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/containers)
and [Microsoft.App permission operations](https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/compute)
are the authority for the exact role/action inventory during implementation.
Do not auto-grant roles. Sensitive `listSecrets` operations are unnecessary for
normal discovery and status. Host management credentials, runtime Blob data
credentials/identity and native model sign-in are three independent authorities.

### State and lifecycle are not local-Docker synonyms

Report separate axes: reachable management connection, app provisioning/running
state, active revision set, live replicas, explicit application readiness,
durability/ownership observations and optional-feature warnings. At zero replicas
report **Scaled to zero** if platform state supports that conclusion, not
**Stopped** or **Healthy**. Unknown state stays unknown. Periodic Admin refresh
reads management state only; authenticated HTTP readiness probes may wake the
app and incur work/cost, so require an explicit test/wake intent.

ACA scale rules can permit zero replicas; changing replica limits is a deployment
setting, not the same operation as ARM Stop. Start may leave the app at zero
until its configured trigger arrives. Show **Start app**, **Stop app** and,
only if deliberately supported, **Wake / test agent** as different actions.
Do not implement Stop as an undocumented `maxReplicas=0` hack, disable ingress,
delete the app, clear schedules or alter keep-alive intent.
[ACA scaling](https://learn.microsoft.com/en-us/azure/container-apps/scale-app).

ACA revisions are immutable deployment snapshots. Even single-revision mode
keeps the existing revision active until its replacement is ready. Therefore
single-revision mode and a maximum of one replica **per revision** do not prove
one writer across the transition. The proposed Assistant policy deliberately
accepts downtime: stop/drain the old deployment, confirm platform stop completion
and absence of its writers, then deploy/start a replacement. The shipped runtime
restores and validates recovery ownership before declaring readiness. Do not
claim zero-downtime upgrades or use traffic splitting to share recovery identity.
If that sequence cannot be verified through the supported platform/tooling,
withhold restart/update capabilities and route to the external operator.
[ACA revision deployment behavior](https://learn.microsoft.com/en-us/azure/container-apps/revisions).

Scale-in and revision deactivation send SIGTERM, but platform termination limits
must be qualified separately from the image's shutdown budget. Ordinary startup
probes, revision restart, ARM Stop and scale-to-zero are different test cases.
The stock recovery default needs at least 297 seconds of host grace; that is
fhold's requirement, not proof that a particular ACA configuration supplies it.
Do not promise durability or safe automatic restart until real deployment grace,
PID 1 signal forwarding, final checkpoint and owner release are verified.
[ACA lifecycle](https://learn.microsoft.com/en-us/azure/container-apps/application-lifecycle-management)
and [fhold's controlled shutdown contract](../assistant-recovery.md#controlled-shutdown-and-restart).

### No false filesystem or full-stack parity

ACA offers container/replica-scoped ephemeral storage and separately configured
mounted storage, not the local six-tree fhold home. Inference for this design:
keep native live SQLite on supported local ephemeral storage and use the shipped
same-instance recovery contract for replacement, or separately qualify an
appropriate local persistent storage arrangement. Do not place live SQLite/WAL
on Azure Files SMB/NFS to approximate local Compose binds. Independent mounts
remain externally owned and subject to existing recovery selection policy.
[ACA storage types](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts)
and [SQLite network-filesystem guidance](https://sqlite.org/useovernet.html).

A standalone Assistant does not automatically include Guardian, Portal, scoped
ingress policies, the local secret/keyring store, offline helper containers or
the local custom Compose overlay. Show that deployment shape prominently;
unsupported Apps sections must explain the missing component. ACA networking,
TLS, ingress authentication and endpoint reachability require explicit external
configuration. Built-in ACA authentication is distinct from OpenCode Basic
auth and Guardian authorization; discovering a hostname or getting an ARM token
does not establish usable native access. Preserve native authentication even
behind another gateway, and never expose recovery's private probe publicly.
[ACA authentication](https://learn.microsoft.com/en-us/azure/container-apps/authentication).

Do not translate `gateway`, `discord`, `slack` Compose profiles into ACA sidecars
or resources in the initial adapter. A future full hosted stack is a separate
architecture/security/deployment decision with its own qualification, not an
extra flag on the Assistant adapter.

## Configuration ownership and pending application

For **local Docker**, the current source of truth remains `state/stack.json`
plus operator-native files/overlay on the selected home. Derived env/keyrings
remain generated; the applied-runtime receipt stays private and per-home.
For **SSH-Docker**, exactly the same sources live on the remote host. The remote
CLI performs fresh reads, baseline comparisons, locking, secret writes and
runtime-revision accounting there. Local preferences/cache are only locators
and observations; never mirror remote configuration into a writable local
`FH_HOME` or hash a local mirror as the applied remote state.

For **ACA**, choose externally provisioned configuration as the initial owner.
The external deployment source (for example reviewed infrastructure-as-code)
owns Azure resources, image pin, native system policy, secrets/mount declarations,
identity, ingress and scale/recovery environment. ARM resource state is the
observed deployment, not a local StackConfig file. Admin shows a bounded,
read-only provider-specific configuration view and optional external source link.
Keep arbitrary custom deployment/addon workflows intact; do not normalize them
away, replace their entrypoint or install their dependencies inside fhold.

Initially, ACA deployment edits are handoffs to the owning source/tool, not
direct writes or a local pending-restart marker. Start/Stop are lifecycle
actions and do not transfer configuration ownership. If later editing is
implemented, own only explicitly selected fields, preview changes, re-read
the resource before writing and preserve everything else. Use the provider's
concurrency conditions where available; document their absence otherwise.
No duplicated StackConfig, generic cloud-spec store or two-mode configuration
framework is needed to add discovery and lifecycle management.

Native agent preferences/auth remain native regardless of host. A live native
API may support some settings reads/writes, but today's host-file mutations and
container-network model discovery cannot automatically operate on ACA. Expose
only qualified narrow operations, preserve comments/unrelated settings and
verify the effective native result. Do not export/import host vendor credentials
to make cloud setup appear ready. Listing connected/authenticated accounts is
still not a real provider/client readiness check.

Use generic **Pending apply** language where meaningful, with adapter-supplied
action/explanation. Local and SSH can keep **Restart required** for startup
inputs. ACA deployment changes may need a new revision; app-scoped secrets may
have another activation rule. Do not clear pending state on saving, accepting
an ARM request, process-running status or a failed health check. Keep a native
watcher-applied preference edit separate from a disruptive container deployment.

## Operations, failure and target switching

Bind operations, sign-in attempts, drafts and streams to the immutable selected
target, not `homeDir` alone. Ignore late responses after switching. Preserve
the current unsaved-change warning and in-flight mutation exclusion; stop
streams/tunnels on switch or exit. Switching never changes stack lifecycle or
window size. No detached-operation framework is needed for the first version.

Mutations should follow one visible sequence:

```text
resolve target -> confirm disruptive action -> submit using existing owning lock
  -> observe outcome -> report resulting state
```

Reuse the existing Compose baseline, lock and applied-runtime receipts rather
than add another preflight system. ACA process-local serialization prevents
duplicate clicks, not concurrent external deployments; native resource state
and recovery remain authoritative. Saving settings is still distinct from
applying them. Inspection and metadata discovery remain usable when optional
diagnostics or the agent endpoint are unavailable.

Report real stages rather than percentages. A connection loss after submission
means **outcome unknown** until reinspection, not a failed or rolled-back action.
Cancelling the local client may leave the remote action running. Inspect before
retrying non-idempotent mutations; reads may use normal bounded retries. Keep
the provider's operation reference for reconciliation without storing secrets.

Follow documented ARM long-running operation status and Retry-After, then
inspect the selected app. Accepted Stop is not completed Stop; ordered replacement
waits for actual stop/drain before starting another writer. The runtime, not the
host adapter, validates restoration and ownership. Report failed readiness and
optional degradation distinctly; do not roll back native data automatically.

## Files, backup and recovery safety

Do not add a generic remote filesystem API to satisfy a folder picker. Local
file dialogs select local destinations only. SSH paths must be explicitly marked
remote and canonicalized/validated remotely; no local `realpath`, `stat` or
same-path inference. ACA has no host folder to open/edit. Secret-bearing native
file edits need a separately qualified narrow path and explicit consent, not an
arbitrary console command hidden behind a settings form.

Portable backup, full-instance export/import, native history recovery and
Assistant checkpoints keep their existing distinct contracts. Initially,
SSH operators can use the normal remote CLI and retrieve a verified finished
archive with standard SSH file-transfer tooling outside the product flow.
Later integrated transfer should distinguish remote archive path from local
destination, validate manifest/inventory/hashes, retain private retry evidence,
refuse overwrite/conflicts and never delete the source implicitly. Full export
must stop and verify all writers remotely; full import must target an empty
remote home and leave it stopped. A successful file transfer is not startup or
same-instance recovery ownership verification.

ACA Assistant recovery can preserve native state through the shipped directory/
Blob format, but it does not back up Azure deployment intent, system policy,
independent mounted drives, Guardian/Portal or external provisioner source.
Do not label a checkpoint as an entire-instance export or automatically unpack
it into a local home. Offline restore/initialization on ACA requires an externally
controlled non-writing invocation with the right image/config/storage and proof
of stopped writers; a live exec shell does not provide that guarantee.

Do not duplicate the recovery engine in the hosting adapter. It needs no Blob
descriptor parser, storage credential, second ownership database or extra
startup gate. Use platform facts to stop/drain an old deployment; then let
the shipped runtime restore and validate its stable `FH_INSTANCE_ID` and
checkpoint owner. If it cannot become ready, surface the native failure and
existing recovery guidance. Never automatically clear a stale owner, initialize
an established namespace or overwrite data to make Start appear successful.
Stopped/zero-replica platform state alone does not prove a final checkpoint
succeeded; report that distinction without requiring new host-side storage
authority. Recovery diagnostics, when explicitly requested and available,
come from the existing runtime interface.

See [Assistant recovery](../assistant-recovery.md) for the unchanged snapshots,
mount policy, shutdown budgets and exclusive ownership contract. Delayed backups
still degrade durability without stopping a usable agent; incomplete restoration
or actual ownership loss still stop writers. Keep SSH/Docker/Azure management
authority on the host. No extra port, sidecar or cloud-management dependency
belongs in Assistant; its existing storage-only credentials remain separate.

## Phased implementation and acceptance

### Phase 0: extract local behavior and document the host boundary

Update the active core principles/architecture with the host-side scope and
reconcile the SSH proposal. Introduce target/capability/result
types and the local adapter/facade without remote providers. Preserve CLI default
selection, installation, profiles, known local endpoints, Admin recents/setup,
confirmed restarts, saved-baseline and pending-restart behavior. Address ambient
remote Docker context confusion in this owning layer, with clear guidance for
operators who intentionally use one. Do not rebuild the entire control plane.

Parity tests must prove local code still uses existing operations and authority:
read-only discovery/status creates no home/keys/env; incompatible homes refuse
writes; project/path collisions refuse takeover; save does not restart; failed
activation remains pending; backup/history/recovery keep manifests and stopped
checks; native setup still needs a real request. Test consistent explicit daemon
selection under hostile `DOCKER_HOST`, `DOCKER_CONTEXT`, Compose env and instance
files, including permitted rootless/local contexts.

### Phase 1: SSH-Docker, existing instances first

Add the versioned, bounded remote CLI machine interface and system OpenSSH
adapter. Start with handshake, explicit/bounded discovery, inspect/status/logs
and existing start/stop. Validate remote identities, canonical paths and compatible
CLI before action. Keep provisioning, remote image update, backup transfer,
browser OAuth, native-worker PTY setup and generic editing off until separately
proven. Extend configuration/apply only with remote baseline/lock/receipt parity.

Tests should cover spaces/Unicode and hostile shell metacharacters on paths,
option-like SSH aliases, fixed-command/stdin dispatch, host-key failure, missing
native authentication, tool/version mismatch, foreign homes/project labels,
timeouts/partial JSON/output limits, target-switch races and no local fallback.
Mocked process tests must verify argv/env/stdin and safe errors; a disposable
SSH Linux host with the shipped remote CLI and Compose is still required for
transport/permission/remote-path and ordered shutdown qualification. No real
user homes or accounts in fixtures. A tunnel test must verify loopback bind,
auth retained, close-on-switch and no stack lifecycle changes.

### Phase 2: optional ACA observation, then qualified lifecycle

Add an optional adapter using explicit host Azure CLI authentication and scoped
ARM resources. First deliver bounded metadata discovery, compatible-resource
selection, platform/revision/replica state, and selected logs, preserving external
deployment ownership. Then enable Start/Stop only after real ACA runtime shutdown,
owner release, scale-to-zero and cold restore qualification. No provisioning,
full stack translation, arbitrary exec/file editing, backup-parity claim or
rolling upgrade in the initial acceptance criteria.

Fixture tests must cover multiple tenants/subscriptions and same-name resources,
deleted/recreated ARM IDs, untagged/foreign/custom apps, secrets in unexpected
response fields, missing CLI/extensions, lack of list/log/exec/write rights,
pagination, stopped versus zero-replica state, async 202/Retry-After success/failure,
rate limits, pending operations after disconnect and no automatic wake-on-refresh.
Assert no `az containerapp job start/stop` substitution and no secret values in
argv/logs/preferences/snapshots. Preserve custom deployment fields when testing
any later narrow mutation; stale external edits must block or be explicitly
reported, never silently overwritten.

Live acceptance must use an explicitly authorized disposable app and private
checkpoint namespace, not a live user agent: normal authenticated native request,
provider/client readiness separately, loss/replacement restoration, ongoing work
and schedule independence, actual SIGTERM/PID 1 chain and full grace, final
checkpoint/owner release, ARM Stop then Start, revision deactivation and
scale-to-zero separately, network/upload failure, and refusal of competing owners.
Retain exact image/API/CLI/config and platform logs in private qualification
evidence. If platform grace/ownership cannot satisfy the recovery contract,
do not promote unsafe lifecycle/update support or weaken recovery to fit it.

### Verification scope

This document changes no source, image, schema, deployment or running instance.
Documentation review/link checks are appropriate for this draft; no live platform
support is qualified by reading docs. AKM unavailability is disclosed above.

For future implementation, run the repository's `bun run check`, `bun run test`,
`bun run lint`, CLI build and Admin bundle, all-profile Compose validation and
changed-shell `bash -n`, plus packaged/rendered Admin target-selection tests.
Run ingress/security tests when access or gateway behavior changes and real-image
recovery/health/native tests when those boundaries are touched. Verify no secret
or privileged mount reaches Assistant. Platform fixtures/mocks prove request
logic only; SSH/ACA qualification is an additional authorized acceptance gate,
not a replacement for shipped local behavior or release artifact gates.

## Decisions, alternatives and complexity cuts

| Decision | Reason / rejected alternative |
| --- | --- |
| One small built-in host facade | Keeps CLI/Admin behavior shared; reject a public plugin package graph, runtime loader, custom cloud SDK distribution or providers branching through every form. |
| Local Docker remains implicit/default | A personal local install needs no cloud account, connection wizard, SSH client or new service. |
| Remote CLI owns remote Compose homes | Reuses real filesystem/lock/audit/revision boundaries; reject context-only activation with local bind sources and shadow homes. |
| Native OpenSSH, Docker and Azure CLI | Standard supported host tooling and auth; reject custom login/token brokers, sshd inside Assistant and startup installers. Optional host prerequisite setup is explicit. |
| ACA Assistant-only and external-source-owned first | Honest deployment shape; reject generic Compose-to-ACA conversion, default sidecars, duplicated settings stores and unreviewed adoption. |
| Capabilities are checked in host domain code | UI can explain missing operations without pretending parity; reject arbitrary exec/filesystem/ARM passthrough as an escape hatch. |
| Recovery-aware stop/start accepts downtime | Preserves one owner; reject rolling zero-downtime assumptions, traffic splitting and automatic lock takeover. |
| No background deployment control plane | On-demand operations and native platform state are sufficient; reject a server, always-running watcher, scheduler or fleet controller. |
| No automatic credential copying or secret inventory | Native host stores and private refs preserve authority separation; reject host account injection into image, ordinary config and backups. |
| Provisioning/transfers/native setup deferred | Each has material cost, data and authority requirements; reject breadth before local/remote ownership is proven. |

The unavoidable complexity is honest resource identity, remote asynchronous
outcomes and recovery ownership. Keep it centralized, typed and tested rather
than conceal it in provider-specific UI hacks. A useful first release can be
local management plus safe SSH existing-instance operations; ACA observation can
follow without promising every local button. If extracting the facade forces
every storage/config/domain function to accept a universal provider object,
the abstraction is too broad. If ACA needs a runtime-side cloud manager or weakens
single-owner recovery, that scope should be cut, not normalized into the product.

## Review conclusion

The design is feasible, but it is a moderate structural refactor rather than a
Docker-command substitution. The work is concentrated in instance selection,
the shared operations facade, target-shaped Admin snapshots, and asynchronous
process/API adapters. Storage, the Assistant image and native provider formats
do not need to change for hosting discovery and lifecycle support.

The root review retained remote CLI execution and a small static adapter factory,
made shared host preferences explicit, preserved `--name` and the implicit local
path, and removed a proposed management-side recovery/permission-probing layer.
The shipped runtime remains the only recovery authority. Local extraction and
SSH support are the next useful implementation slice; ACA observation/lifecycle
can then be added behind the same port. File mutation, provisioning and full
backup transfer are later capabilities, not hidden assumptions in that port.
