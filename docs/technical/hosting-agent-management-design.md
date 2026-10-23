# Separating hosting management from agent management

Status: implemented on `codex/hosting-agent-management`, pending merge and release.
The original design was reviewed against main
`451f4c9ae806c10693c009f82afc3df3f872b86b` on October 22, 2026.
The software architecture and software engineering reviews were independent;
their recommendations are consolidated here. Implementation evidence and limits
are recorded in the [verification record](../operations/hosting-agent-management-verification.md).
No live instances were changed and no cloud mutation was qualified by this refactor.

The [implemented architecture](hosting-provider-architecture.md) describes the
resulting dependency boundaries and extension pattern.
The [hosting guide](../hosting.md) remains authoritative for shipped capabilities.
The [core principles](core-principles.md) remain the active product contract;
they are updated alongside the implementation. Branch implementation is not a
declaration that artifacts have been released or live cloud behavior qualified.

## Decision

Keep one small application layer in `@fhold/lib`, used by CLI and Admin. Compose
independent hosting and agent-management adapters into a selected instance session.
Hosting determines how to discover and operate a deployment. Agent management
determines how to configure and inspect the applications running there. Neither
the common application services nor the UI should infer one from the other.

Use ports and adapters, ordinary dependency injection through function arguments,
interface segregation and composition. Migrate one existing operation at a time
behind these interfaces. No new package framework, inheritance hierarchy, dynamic
plugin loader, service locator, event bus or background management service is needed.

```text
CLI commands / Admin main and preload
                 |
       Instance application services
       one snapshot + named operations
          /                    \
  Hosting management       Agent / app management
  discovery, lifecycle,    AI accounts, preferences,
  deployment, inventory   native workers, app policies
          |                    |
  Local / SSH / ACA        Native OpenCode API,
  host adapters           owned preferences, native tools
          \                    /
           Selected transport bindings
       direct calls / native SSH / HTTPS
```

Adapters translate mechanisms; application services coordinate user intentions.
For example, changing a model is an agent operation. Replacing its container is a
hosting operation. A workflow that genuinely requires both composes them explicitly
and reports each result. Connecting to a different host is not migrating an agent:
moving state, identity or recovery ownership remains a separate explicit operation.

## Baseline audit that motivated the implementation

The findings below describe the pre-refactor baseline, not the current branch.
The typed composition root, normalized observations and consumer migration replace
these couplings; retained SSH wire names are compatibility details, not a second
public management interface.

Preserve the shared library, the built-in composition root, native authentication,
existing local domain functions and the persistent SSH management session. Preserve
host-owned locking, deferred restart receipts, native configuration formats, recovery
ownership and all current local/SSH user workflows.

| Existing code | Finding and required seam |
| --- | --- |
| [`hosting/provider.ts`](../../packages/lib/src/hosting/provider.ts) | A useful composition root already selects built-in adapters. Extend composition here rather than adding provider switches to commands and screens. |
| [`hosting/types.ts`](../../packages/lib/src/hosting/types.ts) | `InstanceSession.management?()` separates fully managed Docker instances from everything else. Five broad capabilities cannot express individual settings or data operations. |
| [`management/types.ts`](../../packages/lib/src/management/types.ts) | `ManagedSnapshot` requires `homeDir`, `configPath` and `StackConfig`. `call<T>(method, value, ...extra)` lets callers assert arbitrary result types without a corresponding typed request. |
| [`management/instance.ts`](../../packages/lib/src/management/instance.ts) | `localInstanceManagement` mixes provider sign-in sessions, native worker setup, StackConfig, lifecycle, app credentials and transfer handling. It imports `hosting/local-docker.ts`, which imports it back. |
| [`management/ssh.ts`](../../packages/lib/src/management/ssh.ts), [`session.ts`](../../packages/lib/src/management/session.ts) | Stateful stdin/stdout is valuable for OAuth and native prompts. Transfer, browser forwarding and generic dispatch need smaller owners; no replacement remote daemon is necessary. |
| [`commands/hosting.ts`](../../packages/cli/src/commands/hosting.ts), [`lib/hosting-command.ts`](../../packages/cli/src/lib/hosting-command.ts) | SSH forwards the ordinary CLI, while other hosts take a narrower command path. The capability boundary should determine available commands. |
| [`admin-app.ts`](../../packages/electron/src/admin-app.ts), [`admin-types.ts`](../../packages/electron/src/admin-types.ts), [`instance-presentation.js`](../../packages/electron/admin/instance-presentation.js) | Common screens still consume two snapshot shapes and infer full management from `phase: 'remote'` / `managed: !platform`. Remove this distinction after moving consumers. |
| [`opencode.ts`](../../packages/lib/src/control-plane/opencode.ts), [`provider-settings.ts`](../../packages/lib/src/control-plane/provider-settings.ts) | HTTP auth/config reads are bound to a home directory; preference writes and model discovery also depend on files or Docker. Extract those distinct dependencies, not a fictitious generic HTTP settings API. |
| [`remote.ts`](../../packages/lib/src/control-plane/remote.ts) | Guided Claude/Codex setup also changes startup intent and recreates Compose containers before and after login. Native login and deployment activation are separate responsibilities. |
| [`recovery.ts`](../../packages/lib/src/control-plane/recovery.ts), [`instance-backup.ts`](../../packages/lib/src/control-plane/instance-backup.ts) | Running recovery status, deployment recovery settings and stopped whole-home export have different owners and guarantees. A single `transfer` flag hides these distinctions. |

## Boundaries and ownership

### Hosting

The hosting adapter owns connection validation, discovery, exact resource selection,
inventory, platform logs, lifecycle and provider-specific deployment capabilities.
It also supplies selected access routes, such as an SSH forwarding lease or an
existing authenticated HTTPS endpoint. Opening a management session is read-only;
access routes are acquired lazily when needed.

`StackConfig`, Compose paths, image auditing, local locks and applied-runtime
receipts stay with the Docker host implementation. On SSH these functions still
execute on the owning host through the exact locally bundled private management executable. ACA never receives
a fake home, synthetic StackConfig or a copy of Docker intent.

Connection setup/edit/check belongs to hosting and remains in Admin Settings.
Provider-specific onboarding fields are appropriate there. Instance pages retain
their common layout. Supported lifecycle semantics are presented as operation
effects, not provider-name branches in common confirmation dialogs.

### Agent and app management

Agent services own native AI account inventory/authentication, model selection,
user preferences, readiness tests and native remote-worker account/pairing flows.
They depend on narrow ports for native API access, owned preference documents and
the already-supported native runtime operations they actually need.

Do not put Guardian and Portal inside an Assistant-only abstraction. App services
own their existing policies, identities, tokens, allowlists and mappings. The
application layer composes those services with hosting to persist/apply startup
changes. An Assistant-only ACA deployment can support OpenCode and native workers
without claiming that Discord, Slack or Guardian are installed or manageable.

Deployment startup intent remains distinct from runtime configuration. Scheduler
environment, worker enablement, sandbox policy, mounts and recovery destinations
may need a deployment change even when an account login or model change does not.
Services return that distinction; they do not silently edit deployment templates.

### Data operations

Keep the existing engines and formats. Offer separate capabilities for portable
content export/import, entire stopped-instance export/import, runtime recovery
status, recovery configuration and offline restore/initialization.

Application services coordinate export/import, including confirmation and stopped
writer requirements. Host adapters own host files and transfer. The Assistant
recovery engine owns checkpoints, SQLite snapshots, coverage and writer ownership.
Neither a hosting adapter nor a UI starts a second recovery engine or clears an
owner as a convenience. There is no requirement for a universal filesystem API.

## Contracts

The following examples explain the design; canonical exported shapes live in
the leaf `dto/` modules and `management/contracts.ts`. Keep shared DTOs
independent of implementations and wire envelopes internal to transports.

### Identity and session composition

Retain existing `HostingConnection` / `InstanceRef` locators and persisted recents
initially. A discriminated locator is appropriate at the boundary. Do not add
another global instance UUID or migrate homes to make the abstraction work.
Common consumers compare the canonical instance key and display normalized
location metadata; they do not inspect remote paths or ARM resource IDs.

An `InstanceSession` composes focused `host`, `agent`, `apps` and `data` operation
groups. This is a facade over existing services, not a new owner of their state.
`close()` releases only session-owned resources: forwards, SSH processes, pending
auth attempts and temporary transfer leases. It must never stop the deployment.
Discard local OAuth attempt references on close; do not imply that OpenCode has
a native OAuth cancellation API. Native login cancellation addresses only the
temporary child/process session owned by that attempt.

Use named, typed domain operations, for example:

```ts
interface ModelSelection {
  provider: string;
  model: string;
}

interface AgentModelOperations {
  inspect: Operation<void, ModelInventory>;
  test: Operation<ModelSelection, ModelTestResult>;
  select: Operation<ModelSelection, SettingsWriteResult>;
}

type Operation<Input, Output> =
  | { support: 'unsupported'; reason: string }
  | { support: 'unknown'; reason: string }
  | {
      support: 'supported';
      availability(): Availability;
      invoke(input: Input, context: RequestContext): Promise<Output>;
    };

type Availability =
  | { state: 'ready' }
  | { state: 'unavailable'; reason: string; remedy?: Remedy };
```

`RequestContext` carries cancellation and explicit user-intent information when
needed, not a provider, home directory or arbitrary command. A small shared
invocation helper translates unsupported/unavailable outcomes consistently.
`availability()` is a cheap description of known state, not a mandatory network
preflight. Mutations validate their actual target and required invariants, then
rely on the authoritative operation result. An earlier UI snapshot is not permission
or proof that a target is still running; an unknown optional diagnostic is not a
reason to block an otherwise valid operation or stop the agent.

The same registered operation slots produce the serializable feature descriptions
for Admin. The description is a pure operation projection; observed lifecycle
eligibility remains a separate deployment fact that the renderer combines with
that projection for disabled controls. Do not maintain a second independent
supported-feature matrix. Metadata cannot claim support when no handler exists.
Temporarily offline or signed-out is unavailable, not unsupported; an older
runtime with unknown support remains unknown until inspection or an explicit tool
update establishes it. Explanations are short and actionable. Unknown optional
features must not disable unrelated operations.

Transport code uses one typed method-to-request/result map for the supported
operation set and validates unknown wire data once at each trust boundary. Replace
caller-chosen `T` and variadic `extra` with inference from that map. Retain and
evolve the existing SSH envelope through advertised operations and a compatible
wire version; do not demand identical desktop and image versions. SSH executable
and managed Skeleton bytes are content-bound to the local distribution, not an
operator-maintained remote CLI.
Domain methods must not know IPC channels, JSON-line framing or cloud commands.
Today the hosting-machine `hello` uses version 1 and advertises management method
names, while the persistent management-session request itself has no version field.
Keep currently shipped method names/request shapes during the initial extraction.
If new contracts change the wire shape, negotiate that explicitly and translate at
the transport boundary; do not infer wire compatibility from TypeScript types or
add a required handshake that breaks existing clients. Test both old-client/new-server
and new-client/old-server behavior within the declared supported protocol window.

### One snapshot, independent observations

The common snapshot contains instance identity/display location, deployment
observation, service inventory, operation availability, pending changes and
independent agent/app/data observations. It has no mandatory filesystem or
StackConfig fields. Use a small shared observation union:

```ts
type Observation<T> =
  | { state: 'known'; value: T; observedAt: string }
  | { state: 'not-inspected'; reason: string }
  | { state: 'unavailable'; reason: string; lastKnown?: { value: T; observedAt: string } }
  | { state: 'unsupported'; reason: string };
```

An empty known inventory differs from an unavailable inventory. A stopped platform,
an idle zero-replica deployment, an unreachable agent, an unsigned-in worker and an
unverified account are distinct facts. `lastKnown` is display-only; mutations
revalidate the request's original bound target and authority, never whichever target
the UI happens to select after an `await`. Optional diagnostics fail
independently rather than making the whole snapshot unusable.

Passive `inspect` observes the host and uses existing cached agent observations.
It must not contact ingress, open a runtime console or start a forward that probes
the agent. Explicit Connect/Open/test/settings-refresh actions acquire agent access;
the UI explains when this may wake an idle instance. Do not add repeated confirmation
for ordinary reads after an explicit connection. Stop, switch or close ends active
agent polling so the Admin does not inadvertently defeat scale-to-zero.

Service image metadata carries provenance: configured reference, observed deployed
reference(s), optional digest and a separately reported update candidate/source.
ACA app-template images are configured intent, not evidence of each active revision's
image. Multiple revisions may legitimately report multiple images. The tooling's
bundled runtime cohort is an update candidate only where the adapter can apply it;
it is not proof of registry latest, compatibility or an available ACA upgrade.

### Operation completion and settings results

Lifecycle results distinguish `accepted`, `completed`, `failed` and `unknown`.
For an accepted operation, keep the native operation identifier/polling reference
where available and observe its completion without resubmitting it. Bound waiting
and allow the user to stop waiting. An unknown transport outcome is not a failure
that can be automatically retried. Do not build a durable job queue for this.

Completion has a stated scope: request accepted, deployment reconciled, agent ready
or recovery shutdown confirmed. A successful Azure response is not replica drain
or completed checkpoint evidence; zero replicas is not evidence that all data was
published. Any future image replacement needs explicit single-writer handoff, not
an assumption that rolling updates are safe.

Settings results distinguish what was saved, whether the native effective value
was verified, whether activation is pending and what disruption activation causes.
Saving watched preferences can succeed while read-back fails; report saved but
unconfirmed instead of rolling back from an old client snapshot. Runtime recovery
durability is separate: saving a file in ephemeral storage is not proof it reached
the latest checkpoint. Show the existing checkpoint observation without making
ordinary settings saves depend on forcing a new checkpoint.

## Access routes and native operations

| Target | Initial implementation route | What must not be assumed |
| --- | --- | --- |
| Local Docker | Direct calls to shared services; host-owned preferences; existing native API and container commands. | A local agent endpoint or home is universal. |
| SSH Docker | Exact bundled private helper runs those same services; typed SSH session, existing SCP transfer and explicitly acquired loopback forwarding. | Files must be mirrored locally or native credentials copied to the desktop. |
| ACA | Native Azure hosting adapter plus explicit authenticated native OpenCode HTTPS access where reachable. | Azure account access authenticates to OpenCode, or HTTPS alone permits filesystem/native-worker management. |

Refactor the existing OpenCode HTTP helper to receive an endpoint and a private
authorization provider. Keep native provider-account secrets in OpenCode's store.
Local/SSH retain their current private-file resolution on the owning host. ACA
needs an explicit deployment-supplied or user-supplied native API credential;
initially keep it session-scoped. Do not read all Azure secrets, put passwords in
recents, repurpose a Guardian key or introduce a second credential registry.
Persistent remember-password support would require a deliberate host secret-store
design, not plaintext in `hosting.json`. Unreachable private ingress reports that
route as unavailable without changing network policy or provisioning a proxy.

The native client should not follow redirects with authorization to an unrelated
origin. A cloud resource with multiple live replicas/revisions is not necessarily
one mutable agent: before sign-in or writes, establish an unambiguous runtime target
or report the ambiguity. Pin native login attempts to the target/runtime, provider
and attempt ID. Switching targets cannot carry verification, consent or PKCE state
into another instance. A replaced runtime invalidates the attempt visibly.

OpenCode v2's HTTP settings-write API is not a general configuration patch API.
Current model/custom-endpoint edits use watched user JSONC preferences and effective
API read-back. Extract an owned-preference port that preserves comments, unrelated
keys and precedence. Supply narrow model/endpoint edits; never expose arbitrary
filesystem writes, managed-policy replacement or a raw JSON editor as the solution.
Custom endpoint model discovery must continue from the Assistant network.

For operations without a supported native HTTP endpoint, first reuse existing
image-baked native tools (`fhold-remote-setup`, `fhold-remote`, `fhold-recovery`).
Separate guided login/account/consent/pairing from worker startup intent, sandbox
policy and deployment activation. Preserve the current Docker workflow while
extracting it; a native login alone must not silently enable a worker or change
isolation. Existing default-on workers can pair without an artificial deployment
change when their native setup allows it. Account, process and client readiness
remain separate observations.

The baseline cancellation path wrote the worker disabled and activated Compose.
The implementation replaces that behavior: closing login cancels its temporary process,
while any already authorized deployment change retains an explicit workflow result.
Never undo a confirmed change or trigger another deployment apply merely because
a client disconnects. Do not widen native trust/consent during this extraction.

A small generic runtime command for narrow preference/native operations is a
conditional option, not an approved transport assumption. First qualify whether
ACA's supported execution surface reliably provides noninteractive input, output,
termination and cancellation. Its documented interactive console/custom executable
support does not establish that guarantee. Never scrape terminal prompts or base64
encode secrets into command arguments to simulate a management API.

If qualification succeeds, reuse the existing typed command conventions, native
tools and plain shared code; keep Azure commands/credentials outside the image.
If it fails, retain explicit native/manual actions for those features and record
the limit. A new authenticated management endpoint/service would be a separate
architectural decision, not a hidden fallback in this refactor.

## Workflows that must remain correct

1. **Open and switch:** select a full connection/target identity, collect passive
   status and render the same four pages. Lazy agent access never touches the
   previously selected target. Selection generation/abort handling discards late
   responses and suppresses stale browser-open/progress callbacks as well as data
   updates, then releases the old session's resources.
2. **Connect an AI account:** acquire native access explicitly, use native auth,
   preserve the live OAuth attempt, discover models, run only a user-requested test
   and explicitly select a model. The existing first-setup moderator-placeholder
   update and installation-complete marker are separate application-level steps
   for deployments that have them; a missing Guardian cannot invalidate agent auth.
3. **Save and apply:** save only the owning setting, preserve other drafts, report
   pending deployment changes persistently where supported, and confirm disruptive
   apply. Do not restart the whole container for a watched native preference.
4. **Native remote setup:** keep native sign-in processes/consent alive across
   calls, expose progress/cancel, apply only supported and confirmed startup changes,
   then pair. Session teardown must not terminate the already-running agent/workers.
5. **Export or restore:** keep portable content, stopped whole-instance archives
   and same-instance recovery distinct. Download/upload transports do not change
   manifest, history, credential or writer-stop guarantees.
6. **Interrupted mutation:** display uncertainty, reconnect and inspect state.
   Never resubmit an update, OAuth completion, import, approval or lifecycle change
   solely because its response was lost.

## Implementation sequence and file ownership

Implement in small reviewable changes, preserving a working local/SSH release at
each step. The first stages are structural and can ship as tooling-only changes
if release classification confirms no runtime dependency/source changes.

| Stage | Concrete changes | Exit evidence |
| --- | --- | --- |
| 1. Contracts and composition | Introduce typed contracts/observations in `management/types.ts` or a focused `management/contracts.ts`; use `hosting/provider.ts` as composition root; remove the `hosting/local-docker.ts` ↔ `management/instance.ts` cycle by composing host functions and application services above both. | Contract tests for local/SSH/ACA passive inspection, unsupported versus unavailable, partial failure and target identity. No behavior loss. |
| 2. Extract existing services | Split `management/instance.ts` by AI accounts/preferences, native-worker sessions, app access and data workflows. Keep `control-plane` deployment logic. Rename Admin-specific domain helpers only where they become shared services. Replace `value/extra/call<T>` dispatch with the typed request/result map. | Existing local/SSH sign-in, readiness, settings, app-policy, pending-restart and transfer tests pass through the new ports. |
| 3. Shared consumers | Adapt Electron main/preload and CLI commands to the same named operations and normalized snapshot. Keep fixed page/component layout. Move provider-specific lifecycle effects into adapter descriptions. Keep dedicated native interactive CLI transport where it is actually required. | Remove the `phase: 'remote'` view branch, `managed` feature guesses and broad `settings/transfer` flags. Confirm unchanged local/SSH workflows and clear disabled ACA operations. |
| 4. Native agent client | Extract injected HTTP access from `control-plane/opencode.ts`; isolate native preference and in-agent model-discovery dependencies from `provider-settings.ts`. Add explicit ACA native API connection/auth/readiness for supported operations. | No-wake passive tests, native auth flow, no redirects leaking auth, same agent-service contract on each reachable transport. Actual ACA qualification before claiming live parity. |
| 5. Remaining runtime operations | First run the bounded ACA execution feasibility experiment. Then, only if warranted, extract existing worker/recovery commands and add narrow generic preference operations to the image. | Shipped-image verification of I/O, account/consent lifetime, runtime replacement, secrets, effective settings and persistence after replacement. This stage needs a full runtime release. |
| 6. Retire bridges and document extension | Remove old dispatch/snapshot compatibility code once in-tree callers move; keep only necessary advertised remote protocol compatibility. Update hosting guide/core principles and provider conformance fixtures. | New adapter can satisfy contracts without modifying ordinary Admin screens, agent services or existing provider behavior. |

Stage 1 has an explicit dependency direction: adapters contribute bound host and
application ports, and management services do not import concrete host adapters.
The provider registry selects an adapter; generic composition consumes its
contribution without another vendor switch. Shared DTOs declare their shapes
without deriving them from implementation return types, and lower control-plane
functions do not import management. Import-graph checks
enforce those edges rather than banning individual symbol names.

Focused additions are the leaf `dto/` DTOs, `management/contracts.ts` and
`management/instance-session.ts`. Native HTTP implementation belongs in
`control-plane/native-agent.ts`; native preference editing belongs with
`control-plane/provider-files.ts`. Existing filesystem and SSH transfer utilities
remain where useful. There is no separate public string-RPC application facade;
the published compatibility envelope stays at the transport boundary.

## Parity target and deliberate differences

| User outcome | Local / SSH | ACA target in this design |
| --- | --- | --- |
| Select, inspect, logs, lifecycle | Preserve current behavior; normalize observations/effects. | Preserve host scope, improve accepted/completed status and image provenance. |
| AI accounts, native model inventory and readiness | Same extracted agent services. | Same services over reachable authenticated native API; explicit connection may wake. |
| Model/default and custom endpoint editing | Existing watched JSONC route behind owned-preference port. | Requires a qualified preference-write route and in-agent discovery; not unlocked by HTTPS alone. |
| Claude/Codex sign-in and pairing | Preserve native workflow, separate startup intent. | Reuse native flow after command/session qualification; startup deployment editing remains external. |
| Guardian/Discord/Slack policies and startup | Preserve installed apps and existing persistent intent. | Disabled when absent or externally owned; no automatic new containers/services. |
| Recovery coverage and durability visibility | Existing engine and status. | Same runtime facts when explicitly reachable; no new host-side storage reader. |
| Full stopped-instance export/import | Preserve existing home/archive contract. | Unsupported for a whole cloud deployment. Future agent-content export is separately scoped, not mislabeled as a full deployment export. |
| Provision, change mounts/scale/secrets, replace ACA images | Existing Docker installer/update remains. | External deployment tooling remains authoritative in this design; a future deployment adapter must separately qualify rollout and single-writer handoff. |

Parity means the same operation has the same meaning and presentation wherever
supported, not that every platform must grow every Docker feature. A new host
provider changes its adapter, registration, connection parser/editor and tests.
An independently new agent implementation changes its agent adapter and tests.
Neither requires rewriting ordinary pages or implementing unrelated interfaces.
OpenCode remains the only implemented agent engine; this is not a new AI provider
registry or a commitment to supporting every agent engine now.

### Repeatable extension pattern

For a new host provider: define and validate its connection/locator at the edge;
implement discovery/host observation and the operations it supports; bind the
reachable agent transports; register it in the one composition root; add its
onboarding fields and run the shared conformance suite plus native qualification.
For a new agent operation: add its typed domain request/result and support slot;
implement the shared use case against narrow ports; supply those ports in each
qualified adapter; expose the same CLI/Admin action; test its failure and lifetime
behavior. Provider-specific API details stop at the adapter in either case.

## Acceptance tests and limits

Use shared behavior tests parameterized by adapter factories. Reuse existing
`hosting.test.ts`, `azure-hosting.test.ts`, `management/session.test.ts`,
`management/ssh.test.ts`, `management/transfer.test.ts`, provider/native settings
tests and Admin browser fixtures. Test observable behavior, not class/file names.

- Same page/section order and named operations across local, SSH and ACA fixtures;
  unsupported controls disabled with a remedy/reason and unknown values not rendered
  as false, disconnected or empty. No provider dispatch in ordinary page handlers.
- Passive discovery/inspection issues no agent request and starts no workload;
  explicit connect can wake; switch/close/stop cancels owned polling and stale UI
  results without terminating the target or changing window size.
- Native auth attempt, readiness result and verified model never cross targets;
  auth process survives separate calls. Secrets do not appear in recents, snapshots,
  process arguments, diagnostics or test artifacts.
- Watched preference change preserves unrelated JSONC and managed precedence;
  effective read-back, persisted save and recovery durability have truthful separate
  outcomes. No unnecessary container restart or stale rollback.
- Optional metadata failure preserves other operations. Old CLI/image support is
  reported per operation; old/new client-server combinations preserve the advertised
  contract. Repairing tools is explicit and never updates workloads. Missing optional
  observations do not introduce new mandatory preflight requests or restart gates.
- An accepted lifecycle mutation with dropped response is not replayed. Polling
  stops on timeout/cancel with unknown outcome rather than false success. Deployment
  health is never promoted to checkpoint/owner-release proof.
- Current/configured images remain distinct, including custom pins and multiple
  active revisions. Candidate source is explicit and not fabricated from Admin version.
- Export/import preserve existing formats, native histories, permissions, source
  files and stopped-writer constraints. Recovery does not acquire/clear ownership
  during inspection or reinterpret a portable archive as a checkpoint.
- Architectural import checks keep presentation/services independent of concrete
  provider modules, Electron, Docker/az invocation and filesystem path resolution;
  the explicit composition roots and concrete adapters are the exceptions.

Real disposable local, SSH and ACA verification must complement fixtures before
claiming live parity. Use explicit cost/resource authority for cloud qualification;
do not use existing personal instances as test fixtures. Interactive ACA console
success is insufficient evidence for a typed unattended management transport.

## Decisions retained after review

Keep the existing SSH protocol and local implementation; replace their public
coupling incrementally. Do not make all management HTTP, move the host CLI into
the Assistant, use Guardian as a privileged control plane, invent a universal
filesystem, duplicate account state or add speculative infrastructure.

The ACA execution experiment found the installed native console requires a terminal
and does not establish unattended typed process I/O. Consequently, this implementation
uses the explicit authenticated HTTPS subset and leaves preference-file edits and
guided worker setup unavailable through ACA. It adds no image helper, terminal
scraping, cloud SDK or management daemon. A future route needs independent
qualification before enabling those operations; the contracts/local/SSH extraction
do not depend on that future work. Details are in the verification record.

## External platform evidence

Reviewed October 22, 2026:

- [Azure container console](https://learn.microsoft.com/en-us/azure/container-apps/container-console)
  documents revision/replica/container selection and a custom executable already
  present in the image. It does not establish unattended typed-session behavior.
- [Azure revisions](https://learn.microsoft.com/en-us/azure/container-apps/revisions)
  are immutable and can overlap. Single-revision rollout keeps the old revision
  until the new revision is ready; this is not by itself a single-writer handoff.

Those platform facts constrain adapters. They do not require Azure-specific
policy in the common agent services or inside the Assistant image.
