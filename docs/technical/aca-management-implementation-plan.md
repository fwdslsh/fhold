# Azure hosting management implementation plan

Status: implemented for review on `codex/aca-management`, not released.
Updated October 31, 2026. Live Azure qualification remains pending; see the
[verification record](../operations/azure-management-verification.md).

Implementation refinements: live native state uses the published image's owned
writable directories, not unqualified EmptyDir overlays. A separate offline Job
cannot restore the app's writable layer, so that action remains disabled; normal
Start performs actual restoration. Existing system-assigned identities are not
converted to enable offline jobs. Full cloud archives and Guardian/Portal deployment
remain the explicitly deferred follow-on scope below.

Extend CLI and Admin so users can install and manage an Azure Container Apps
(ACA) assistant through the same workflows as a local instance. Keep Azure
deployment mechanics in the host provider and native agent configuration in the
shared agent-management layer. Use the published assistant image without an Azure
management agent, sidecar, custom bootstrap, or host Docker requirement.

The source baseline is fhold main `20a4ce2758cb275dbe368a96b34d279466c5ad91`
(0.4.1001). The [hosting architecture](hosting-provider-architecture.md) describes
the existing boundaries; the [hosting guide](../hosting.md) describes shipped
capabilities. This plan extends the current existing-deployments-only scope.

## Decisions and scope

- Local Docker remains the default. Local, SSH and ACA retain the same Overview,
  Agent settings, Apps and System screens. Individual unavailable operations are
  disabled in place; a sleeping instance is not an unsupported instance.
- **Do not detect or police which application manages a deployment.** No adoption,
  takeover, externally-managed lock, ownership tag requirement or associated
  confirmation. The user chooses the instance and is responsible for coordinating
  different tools. This does not change the recovery engine's actual single-writer
  ownership, native Azure authorization or exact-target selection.
- Make narrow changes to the selected resource. Preserve unrelated containers,
  environment entries, mounts, secrets, identities and settings as ordinary update
  correctness, not as a management-ownership policy. Do not overwrite an existing
  app with the fresh-install template.
- Keep normal confirmations for restart, costs/resources created, destructive data
  operations and native account consent. Do not add another restart-policy validator.
- Keep the existing recovery engine, native credential stores, image-baked setup
  scripts and provider composition root. No new daemon, plugin framework, general
  workflow engine, cloud-specific assistant mode or duplicated recovery engine.
- First delivery covers assistant-only provisioning and normal agent management.
  Full cloud export/import and Guardian/Portal deployment are later, explicit work
  packages, not prerequisites for shipping useful assistant management.

## Current gaps and target behavior

| Area | Baseline | Target |
| --- | --- | --- |
| Discovery and selection | Native Azure sign-in, resource-group discovery and resource-ID targets | Retain these; selecting a compatible existing app never requires adoption. |
| Lifecycle | Start/Stop requests and revision restart; accepted results can remain pending | Track native operation completion and subsequent agent readiness separately. |
| Install and update | Installation requires a directory; install/update live under Docker operations | Connection-scoped provisioning and instance-scoped updates through shared operations. |
| Image inventory | App-template image references collected as one assistant service | Report each actual service/container and running revision image separately from configured/update intent. |
| AI settings | HTTPS account auth works; model selection/custom endpoint management is incomplete | Shared native preference editing and agent-network model discovery. |
| Remote workers | No qualified ACA guided setup binding | Reuse baked-in Claude/Codex scripts through native OpenCode execution. |
| Recovery | Image supports Blob and managed identity; management binding is absent | Expose existing coverage/settings/status/init/restore operations with honest availability. |
| OpenCode access | Explicit HTTPS credential, short readiness wait, external ingress assumed | Reuse selected credentials, show cold-start progress, support reachable private endpoints without publishing them. |

## Shared management contracts

Use ports and adapters, interface segregation and the existing composed instance
session. Extend the existing operation tree rather than adding a parallel feature
registry. DTOs stay below implementations; transport translates mechanisms and
does not own user workflows.

### Provisioning before an instance exists

Replace the directory-only installation contract with connection-scoped operations
for installation options, preview and install. These names describe the intended
roles; exported types should follow the existing `Operation<Input, Output>` pattern.

- Options provide defaults and native choices without creating resources.
- Preview describes the exact destination, image, resources reused/created,
  storage coverage and operational consequences. Do not invent a price estimate.
- Install returns the canonical `InstanceRef` and progress/outcome information.
  An incomplete installation remains resumable without inventing a fake home.

Local and SSH bindings delegate to their existing installer. Keep directory picking
as an optional filesystem capability; cloud installation does not implement it.
Use one wizard shell with small provider-specific placement controls, not three
copies of setup or a schema-driven form framework. Provider-specific selection
belongs in connection/setup composition, not ordinary agent feature pages.

### Deployment operations on an existing instance

Expose inspect, prepare/apply deployment changes and update through the host-side
contract. Move common install/update consumers off `session.docker`. Keep genuine
Compose and `StackConfig` details in the Docker bindings; do not convert ACA into
synthetic Docker intent or serialize an entire Azure template into local settings.

An operation result distinguishes submitted, in progress, completed, failed and
unknown outcome. Reuse Azure operation/deployment identifiers for reconnection.
Store only the minimal private, target-bound continuation reference locally, not
secrets or a replica of Azure resource state. Closing Admin does not cancel an
already submitted Azure operation; it also cannot promise to run later local
steps while the application is closed. Reopening inspects and offers continuation.

### Agent and data operations

Bind native API, preference-document and command-execution ports to the selected
agent. Reuse existing agent services and the image's documented native commands.
Do not route cloud agent configuration through local filesystem helpers or scrape
interactive `az containerapp exec` output into a management protocol.

Keep recovery status/coverage, deployment recovery settings, initialization and
offline restore separate. Use the existing engine for mutations. Do not introduce
a mandatory second check of its format, ownership or readiness in host tooling.

## Azure provisioning design

### User workflow

1. Choose Azure from the ordinary new-instance workflow. Use native Azure CLI
   sign-in and the selected subscription/resource group; do not change the global
   Azure account or require service-principal credentials for desktop users.
2. Name the assistant. Choose or create an ACA environment and choose **Always
   running** or **On demand**. Default to Always running for local-like behavior;
   explain the cost/availability choice without making it a separate setup mode.
3. Keep region, resource sizing, storage and optional mounts under Advanced.
   Reuse suitable existing infrastructure when explicitly selected. Show resources
   that installation will create before submission.
4. Provision, initialize recovery, deploy and report progress in the existing
   Install stage. Connect and Ready remain the same native agent setup stages.
5. Finish later leaves a successfully deployed assistant running. Cancelling before
   submission creates nothing. Cancelling observation after submission reports what
   Azure has accepted and does not delete resources or replay the operation.

### Resources and defaults

- One assistant Container App, TLS ingress to the native OpenCode port, one active
  writer and a pinned published image. Single revision and maximum one replica are
  defaults, but are not sufficient to serialize replacements.
- Reuse or create an ACA environment and general-purpose storage account. Do not
  require one storage account per assistant. Use a private Blob container per
  instance and a stable `FH_INSTANCE_ID` unrelated to revision/replica names.
- Prefer a per-instance user-assigned managed identity for fresh installation so
  storage access is available before the app starts. Grant Blob access at the
  instance container scope. Continue supporting existing system-assigned identity
  deployments; do not force their conversion.
- Use standard ACA secrets for the generated OpenCode password and file-backed
  secret mount supported by the image. Key Vault remains optional. Keep the
  password out of URLs, command logs, recents and renderer preferences.
- Configure startup/readiness/liveness independently. Use the image's existing
  private recovery probe where appropriate; never expose it as another public API.
  Initial restore must have enough time and temporary backup degradation must not
  become a restart loop.
- Set termination grace from the documented writer-shutdown/final-checkpoint
  budget, including a margin. The existing 360-second lab setting is a starting
  point for default budgets, not a constant that ignores changed recovery timeouts.
- Do not install tools at startup, force Codex's sandbox off, change native consent,
  or install third-party plugins as part of Azure provisioning.

Always running uses minimum/maximum one replica and preserves the ordinary
scheduler default. On demand uses minimum zero/maximum one, disables user scheduling
for a fresh instance, and can use existing conditional keep-alive during work.
It does not disable recovery or native workers. Explain that outbound Discord,
Claude and Codex connections cannot themselves wake a zero-replica app. Preserve
explicit choices on existing instances; changing availability is a reviewed
deployment edit, not an implicit scheduler rewrite. Persist an explicit timezone
at creation, defaulting to the management computer's timezone.

Keep native Azure client access centralized in `hosting/azure-client.ts`. Use native
management SDK long-running-operation support where the current CLI wrapper only
returns acceptance; reuse Azure CLI credentials rather than implementing OAuth or
an ARM polling framework. Provision related resources through a bounded standard
ARM deployment, with packaged templates and native deployment tracking. Reuse
existing data-plane SDKs for Blob operations. No workstation Bicep compiler or
Terraform installation should be required to install an assistant.

Azure separates environment-variable revisions from application-level secrets;
secret changes still need explicit application to running workloads. Use those
native semantics rather than treating a successful settings write as a restart.
See [environment variables](https://learn.microsoft.com/en-us/azure/container-apps/environment-variables)
and [secrets](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets).

### Initial recovery creation

Qualify a manual, short-lived ACA Job using the same published assistant image and
its existing `fhold-recovery init --confirm-new-instance` command. Supply the
instance identity, recovery selection and any required mounts; leave application
writers off. The identity can be authorized before either the job or app starts.
This keeps initialization inside the owning engine and works without host Docker.

Wait for the native execution result and inspect the resulting namespace. A lost
response is not permission to run initialization again: reconcile the existing
descriptor/execution first. Existing namespaces are never reset or automatically
initialized during ordinary startup. Match the job's command/arguments to the
shipped entrypoint, and verify non-root secret/mount access in the first spike.
After success, remove only the disposable job resource created by that install;
retain the instance's data, identity and infrastructure. Keep failed executions
available for diagnostics and show a deliberate cleanup action.

This uses [native finite-duration ACA Jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs),
not an always-running service. Do not substitute an init container without
qualification: [managed identity limitations](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity)
apply to init containers in some environment types.

## Storage and settings

Use the existing [recovery contract](../assistant-recovery.md) and
[environment/mount contract](environment-and-mounts.md).

| Content | Location and management |
| --- | --- |
| Live SQLite, native account state and recovery receipts | Image-owned writable container directories; restore from Blob before native writers on recreation. No default EmptyDir overlays. |
| Recovery generations | Private Blob container through existing managed-identity transport. |
| Optional shared project/workspace directories | Azure Files, with explicit read/write intent and recovery mount exclusions. Never put live databases here. |
| Boot/deployment intent | ACA environment variables, including recovery location/ID, scheduler, timezone and existing worker settings. |
| Recovery include/exclude/required-mount policy | Existing JSON format, mounted as a small deployment-supplied file; no new policy schema. |
| Deployment secrets | ACA secret references/file mounts; optional existing Key Vault integration. |
| AI accounts and harness preferences | Native files/auth APIs, covered by recovery; not duplicated into ACA env on every edit. |

Azure Files is optional, not the assistant's default home. Blob is the checkpoint
destination, not a mounted live filesystem. Both container recreation and replica
replacement may require restoration; durability does not depend on the local
writable layer surviving. [Azure storage mounts](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts)

Qualify supported Files authentication with current native APIs. Do not make a
preview Files identity feature, custom VNet, Key Vault or private endpoint mandatory
for the default installation. Preserve an existing private-network deployment and
report its connectivity needs without making it public as a repair action.

Keep the current default 60-second snapshot cadence and report checkpoint age and
degraded durability. A snapshot is not a cross-application transaction. Current
capture bounds include 10,000 files, 64 MiB per ordinary file, 256 MiB per database
(including live main/WAL/SHM preflight) and 1 GiB total; test representative
workloads before promising that every
workspace fits. Do not raise limits or replace the engine as incidental provider
work. Clearly distinguish independently mounted data from checkpoint coverage.

## Lifecycle and update behavior

Azure single-revision rollout keeps the prior revision serving until the new one
is ready. This can overlap stateful writers, so the provider must not use the
ordinary rolling-update sequence for this assistant. [ACA revisions](https://learn.microsoft.com/en-us/azure/container-apps/revisions)

For a running instance, apply a restart-requiring change as:

1. Show the selected changes/image and confirm interruption using the common dialog.
2. Submit Stop and follow its native operation to completion. Historical replica
   records need not disappear. An early `runningStatus: Stopped` is not enough.
3. Report final-checkpoint/recovery-owner evidence when available. Missing optional
   diagnostics produce an unknown/degraded observation, not a new lifecycle veto.
   An actual failed shutdown or known unresolved writer/owner is actionable; never
   auto-clear ownership. The recovery engine remains the authority on restoration.
4. Re-read the target and apply only the requested fields, preserving unrelated
   fields. For images, update the selected assistant/service container, not every
   container in the app. Preserve custom pins unless the user explicitly changes them.
5. Start and follow native readiness, including restoration. Report completion only
   after the required checks for that operation succeed. Optional subsystem failures
   remain local and visible.

Updating an intentionally stopped instance finishes with a completed Stop. Azure
may activate a revision while applying its new template; this does not promise
zero transient execution during an explicitly confirmed update. Waking an on-demand
instance is explicit; passive inventory/log inspection never contacts ingress.
Explicit Restart uses a qualified graceful stop/start sequence when recovery is
enabled; an accepted revision-restart request alone is not completion evidence.
Use an operation-specific startup budget with progress rather than the current
10-second native readiness wait. HTTP authentication failure is not a cold-start
retry; unavailable private networking is not an instruction to change ingress.

If update/start fails, report the exact completed step and leave data intact. Do
not blindly replay an unknown mutation, force-unlock storage, fabricate a blank
instance or automatically downgrade an image after native database migration.
Retry uses current resource/native operation state. No blanket drift detector or
external-manager approval gate is added.

Confirmed failed infrastructure, initialization and app-deployment steps have an
explicit retry action. Unknown outcomes are observed, never blindly replayed.
The continuation retains the validated nonsecret original placement and exact
image because failed ARM deployments may not populate outputs. Retrying a known
failed deployment reapplies that reviewed template; this is not a new adoption
or manager-ownership mechanism.

### Save now and apply later

Preserve the existing pending-restart interaction. Pending Azure deployment edits
are a small target-bound patch in the existing private management preferences, not
a second authoritative template. Applying re-reads current resource values; only
the requested fields change. Azure state remains authoritative after application.

Do not submit revision-creating changes when the user chooses Later. Keep staged
secret values out of plain preferences: initially retain them only for the current
session and clearly require re-entry after closing if not applied. Do not claim
such secrets were durably saved. Discarding a draft changes no Azure resources.
Applying changes made in another tool requires no fhold adoption or reconciliation
ceremony. There is no promise that local drafts are synchronized to other computers.

## Native agent parity

### Settings and custom endpoints

Reuse the existing JSONC preference editor with a qualified OpenCode native
filesystem binding. Edit the user preference document, not managed system policy;
preserve unrelated keys/comments. Verify effective settings through the native API
without reloading OpenCode or restarting the container. Show saved, effective and
checkpointed as different facts; do not roll back from a stale client copy.

OpenCode 2.2.1's experimental config PATCH supports shell selection only. Do not
use it for model/provider writes. Qualify its
[native filesystem API](https://github.com/anomalyco/opencode/blob/v2.2.1/packages/protocol/src/groups/fs.ts)
for writing the selected preference document, including failure/partial-write
behavior. Use a native atomic write path if the HTTP operation cannot provide the
needed semantics; do not add a new remote filesystem protocol.

Run custom-endpoint discovery from the Assistant's network via qualified native
execution, never from the workstation. Keep keys in native authentication and out
of command arguments/output. Scope the executor to these existing use cases rather
than exposing an arbitrary new management RPC API. Ordinary AI settings requests
must work on local, SSH and ACA using the same domain behavior.

### Claude and Codex

Use the shipped login/pairing scripts and supervisor commands. Qualify OpenCode's
[native terminal API](https://github.com/anomalyco/opencode/blob/v2.2.1/packages/protocol/src/groups/pty.ts)
for private input, output, exit status, cancellation and disconnect handling.
Native account sign-in and user consent remain vendor-owned. No token exchange,
trust bypass, per-harness Azure wrapper or repeated startup install is introduced.

Tie temporary setup to the actual running target. If a revision/replica replacement
invalidates it, show a retryable setup interruption; do not silently submit a
single-use code into a different process. Cancellation only disposes the setup
session. Worker startup preferences are separate host deployment edits, not side
effects of sign-in cancellation.

### Authenticated OpenCode access

For new installations, reuse the generated native credential for connection and
the existing one-use browser pairing flow. For existing apps, resolve a configured
native ACA secret reference on explicit Connect/Open when Azure permissions allow;
otherwise offer the existing native credential entry. Do not scan/reveal all
secrets or assume Azure login itself authenticates to OpenCode.

Resolve the native username from the selected deployment configuration, with the
shipped image default as a default, rather than hard-coding it for custom instances.

Keep credentials in the management process and reacquire as needed rather than
adding a second persistent credential database. Do not impose an external-manager
prompt on this path. Support explicitly configured, workstation-reachable internal
endpoints without automatic network exposure. Native credential errors should offer
correction, not a container restart.

## Implementation sequence and code map

### 1 Qualify native building blocks

Before building UI around them, test native preference writes/watchers, terminal
execution/private input, the same-image initialization job, managed identity/RBAC
propagation and Azure stop/update/start semantics. Test both default and required
external-mount recovery policies. Resolve unsupported native behavior in the
owning integration; do not hide it behind test-only repairs.

### 2 Extend contracts and complete lifecycle

| Files | Work |
| --- | --- |
| `packages/lib/src/hosting/types.ts`, `dto/hosting.ts` | Connection-level provisioning contracts and normalized deployment progress/image observations. |
| `packages/lib/src/management/contracts.ts`, `host-operations.ts`, `instance-session.ts` | Shared deployment operations, result semantics and operation descriptions. |
| `packages/lib/src/hosting/provider.ts` | Bind capabilities at the existing composition root. |
| `packages/lib/src/hosting/local-docker.ts`, `ssh-docker.ts`, management SSH/wire handlers | Route current local/SSH installation/update through the shared contracts without changing their runtime behavior. |
| `packages/lib/src/hosting/azure-client.ts`, `azure-container-apps.ts` | Native operation tracking, per-container image observations, selected-resource updates, readiness/wake separation. |

Add small Azure deployment/template modules beside the provider only when their
responsibility warrants separation. Do not make the provider file an installer,
storage client, native settings editor and UI model in one place.

### 3 Add installation and storage management

Implement native resource provisioning, resource reuse, initialization, deployment
options and recovery bindings. Extend the existing connection onboarding choices
for environments/storage. Verify one fresh install and one existing-instance update
through CLI before adding the corresponding Admin interaction. No local Docker
dependency is permitted on the ACA management path.

### 4 Complete native management and common UI

| Files | Work |
| --- | --- |
| `packages/lib/src/control-plane/native-agent.ts`, `provider-files.ts` | Shared native transport and preference document integration. |
| `packages/lib/src/management/https-agent-session.ts`, `agent-services.ts` | Bind HTTPS preference, endpoint discovery, native worker setup and realistic cold-start handling. |
| `packages/lib/src/control-plane/recovery.ts`, `recovery-config.ts`, `dto/recovery.ts` | Reuse policy normalization and existing operation results; provide cloud bindings without host-side recovery. |
| `packages/cli/src/commands/hosting.ts`, `commands/setup.ts`, `lib/hosting-command.ts` | Same install/update/settings intentions through the selected connection and target. |
| `packages/electron/src/admin-app.ts`, `admin-types.ts`, `admin-preload.ts` | Typed operation/progress IPC, private credential handling and request lifetime. |
| `packages/electron/admin/hosting.js`, `configuration.js`, `recovery.js` and existing setup/Overview modules | Shared wizard, pending apply, capabilities and progress; no parallel Azure screen tree. |

### 5 Qualify and document assistant parity

Publish tools independently if the existing image satisfies the qualified native
contracts. Do not rebuild containers merely for host tooling. If a necessary
generic runtime correction emerges, keep it separate, document the reason and
qualify that image before claiming the feature works. No release is authorized by
this planning document.

Package the provisioning templates with both standalone CLI and Admin, including
the installed/updater-managed AppImage. Extend the packaged-assets tests to verify
resource resolution without a source checkout or inherited development paths.
Do not accidentally change the bundled runtime image default in a tooling-only
release. Verify dependency resolution scope before choosing that release path.

## Acceptance tests

Extend existing suites rather than constructing a second test framework:
`scripts/management-architecture.test.ts`, `scripts/provider-settings-native.test.ts`,
`packages/lib/src/control-plane/azure-hosting.test.ts`, management session/agent/host
tests, CLI hosting tests and Admin workflow tests.

- Contract tests exercise local, SSH and ACA through the same consumer operations.
  Existing local/SSH selection, install, pending restart and update behavior remains.
- Existing ACA apps with arbitrary unrelated tags/settings remain manageable. There
  is no manager detection, takeover prompt or tag-based mutation permission.
  Narrow updates preserve unrelated containers, secrets, environment and mounts.
- Snapshot requests cause no ingress calls, sign-in, key creation, wake or mutation.
  Configured, available and actual revision image references remain distinct.
- Delayed Azure completion, throttling, disconnect, Admin close/reopen and unknown
  mutation outcomes do not trigger duplicate installation or blind action replay.
- Sleeping, administratively stopped, restoring, ready and degraded states are
  distinguishable. A single stopped replica record does not claim durability.
- Local image-backed tests verify watched native preference changes, custom endpoint
  discovery from the agent network, native scripts, private code input and setup
  interruption. No paid model call or real account consent is inferred from mocks.
- Live disposable ACA qualification covers fresh install without host Docker,
  reuse of infrastructure, private Blob MI, optional Files mounts, normal Stop/Start,
  natural scale-to-zero/wake and image replacement with preserved session IDs,
  final messages, credentials and file hashes.
- Test final checkpoint failure and forced termination separately. Expect honest
  degraded/repair guidance and last-accepted-checkpoint behavior, not automatic
  ownership takeover or a claim that forced kill is lossless.
- Verify a new Claude and Codex tool request after restart with explicitly provided
  test accounts. Observe real natural-idle behavior with the chosen keep-alive policy.
- Visually review the same Admin pages for each provider, keyboard navigation,
  disabled states, progress, retry, Cancel/Finish later and one-click authenticated
  OpenCode access. Do not resize user windows or use live lab instances as fixtures.

Unit/native-image checks run during development. Live Azure resources, costs and
native account usage require an explicitly authorized test environment. Record
source/image identity and results; source review and ARM success are not runtime
qualification. Reuse eligible evidence instead of repeatedly running full builds.

## Follow-on work and documentation

Cloud full export cannot honestly mean a Docker-home tarball. A follow-on design
must package native state, deployment settings and explicit external-volume
coverage, distinguish moving the same identity from cloning, and use the existing
engines. Do not relabel a recovery checkpoint as a complete portable export.

Guardian/Portal support needs actual service deployment/configuration and, for
bots, suitable availability. Keep those sections visible but disabled until the
provider supports their operations. Do not route Guardian secrets through Assistant
or claim that scaling an outbound bot to zero preserves bot responsiveness.

With implementation, update `AGENTS.md`, `core-principles.md`, the hosting design
and architecture, `docs/hosting.md`, `docs/assistant-recovery.md`, environment/mount
docs, Admin/CLI instructions and both hosting verification records. Replace the
old prohibition on host-side provisioning while keeping cloud administration out
of the image. Remove superseded HTTPS capability claims only after qualification.
Keep historical test findings labeled rather than presenting them as current results.

Databasin assistants are a reference, not a dependency or template to copy. Reuse
the lessons of native operation completion, ordinary image-backed setup and actual
data-preservation tests. Do not import its multi-tenant database, organization
model, provisioning service, model proxy or startup wrapper. Its recorded normal
Stop/Start verification does not qualify this provider's natural-idle or remote
worker behavior; those are explicit acceptance cases above.
