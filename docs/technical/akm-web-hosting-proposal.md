# Optional persistent AKM Web hosting

Status: proposal and implementation plan only; not implemented or released.
Prepared November 24, 2026, against fetched `origin/main`
`7ee55f15e72e8894d548a5a768d2af0a1de0b63a`.

Implementation depends on AKM's server and embedding proposal, which is under
upstream review. The contract table below deliberately leaves its final details
unresolved. This document does not define new native AKM flags or claim that a
published package already supports them.

## Decision and ownership

Offer an opt-in stable URL for the AKM Web application already packaged in the
Assistant. Its lifetime is independent of an Admin management session. Preserve
existing on-demand access for installations that do not enable persistent hosting.

AKM owns login, sessions, application behavior, host/write-origin validation,
framing, and native activity reporting. Fhold owns installation settings, secret
mount wiring, optional process lifecycle, deployment networking, and opening the
selected instance's UI. This follows the [primary product rule](core-principles.md)
and [hosting architecture](hosting-provider-architecture.md).

Add no fhold authentication service, cookie or token issuer, session database,
knowledge API, reverse proxy, sidecar, scheduler, or parallel activity tracker.
No new agent restrictions or credential-custody mechanism belong in this feature.

## Scope and user behavior

- Persistent hosting is disabled by default and requires explicit enablement.
- When enabled, the user can navigate to the configured canonical URL and use
  AKM's native login. Reauthentication after a restart is normal, not data loss.
- Admin displays that same URL inside its existing Electron `WebContentsView`.
  It does not launch an external browser, take ownership of the persistent
  process, or stop it when the management session closes.
- Other web applications may embed AKM using upstream's configured parent-origin
  allowlist. Browser HTML iframe behavior and Admin's native browser view are
  separate paths to qualify.
- The first managed implementation covers local Docker and SSH-Docker. ACA's
  knowledge UI operation remains unsupported. Generic image listener support is
  not a claim of ACA Admin access or new cloud provisioning.
- Root-path hosting at a dedicated port or hostname is sufficient. Native
  subpaths and host-application SSO are separate upstream work if later needed.

HTTP is supported. Built-in TLS, rate limiting, SSO, and user-account management
are not requirements for fhold or this integration. Recommend an existing proxy,
firewall, or VPN when exposing the service beyond its host. Host/origin checks
and framing allowlists do not identify client computers or encrypt HTTP traffic.

## Pending upstream contract

Replace each placeholder with an upstream reference and verified published
behavior before implementing the dependent step. The locally discussed AKM
proposal is design input, not a substitute for that contract.

| Decision | Placeholder to resolve with AKM | Fhold consequence |
| --- | --- | --- |
| Proposal and release | **TBD-AKM-01:** canonical proposal/PR URL; release version and source commit; exact CLI/Web/plugin compatibility requirements | Pin a qualified published set and update the lockfile normally. No speculative pins or startup downloads. |
| Server configuration | **TBD-AKM-02:** supported executable, mode selection, bind/port/public-origin settings, configuration precedence and error behavior | Pass native arguments/configuration using existing typed setup; do not invent upstream flags or a translating compatibility layer. |
| Login and sessions | **TBD-AKM-03:** credential-file format, native login URL, session/logout/expiry behavior, rotation and restart semantics | Mount a dedicated credential and open the bare URL; keep credential values out of state, status, logs and URLs returned to ordinary status consumers. |
| Framing | **TBD-AKM-04:** parent-origin allowlist syntax, defaults, nested-frame rules, CSP and conflicting-header behavior | Pass explicit operator choices through; qualify allowed and rejected embedding without changing CORS or injecting headers. |
| Cookies and browsers | **TBD-AKM-05:** supported same-site/cross-site arrangements, cookie attributes, HTTP behavior and third-party-cookie restrictions | Publish an accurate support matrix; do not repair unsupported arrangements with fhold authentication or cookie rewriting. |
| Readiness | **TBD-AKM-06:** credential-free readiness record or safe HTTP probe, canonical Host requirements, runtime failure diagnostics | Observe actual availability without using a login credential as a health token or treating PID existence as readiness. |
| Shutdown | **TBD-AKM-07:** native termination behavior, request admission, in-flight operations and spawned CLI descendants | Stop all writers before the existing final recovery capture; retain the existing deadline and failure semantics. |
| Activity | **TBD-AKM-08:** native signal/API that distinguishes idle serving from active web operations, including long-running jobs | Reuse existing keep-alive integration. Do not claim idle-shutdown compatibility until real native activity is observed. |
| Desktop/Admin launch | **TBD-AKM-09:** continued on-demand launch/bootstrap contract and compatibility with server mode | Preserve existing local/SSH launch and cleanup; keep persistent direct access distinct from temporary forwarded access. |

No placeholder is permission to create a substitute in fhold. If a required
native capability is missing, resolve it upstream or explicitly narrow the
qualified deployment scope.

## Configuration and exposure

Extend existing typed installation settings and generated environment rather
than creating another settings store. Proposed inputs are enablement, container
bind address/port, canonical browser origin, credential-file location, embedding
parents, and optional host publication address/port. Final fhold names follow
the existing `FH_*` convention; native setting names await TBD-AKM-02.

Keep the container bind distinct from host publication. A container-loopback
listener is not reachable through ordinary Docker port publication. Select a
container-reachable bind when publishing; default local host publication to
loopback. Leave OpenCode's listener, password, tickets and WebSockets unchanged.

Disabled mode must require no web credential, web mount, or published web port.
An unconditional Compose secret pointing at a missing optional file would stop
the entire container before the optional process can degrade; avoid that design.
Use existing Compose generation and secret mechanisms to include only the
requested, valid deployment inputs. Do not add another Compose service/profile.

Reject invalid requested settings before applying a deployment change, retaining
the previously usable deployment. At runtime, malformed web settings, a missing
credential or an occupied web port must refuse web startup and report degraded
web status without terminating OpenCode. Never silently start unauthenticated.
Do not weaken existing core/recovery integrity gates to achieve optional failure.

Use the browser's actual canonical origin, not an inferred container address.
Other orchestrators can map the image listener through their normal networking;
this feature adds no provider-specific ingress resources or routing engine.

## Process lifecycle, health and recovery

Start the packaged server after recovery and native AKM preparation, under the
ordinary Assistant UID, working directory and AKM configuration context. Reuse
the existing sanitized writer environment; do not pass recovery-only identity
selectors or privileged writer credentials.

Register the web process and descendants in existing writer shutdown handling,
outside essential PIDs. An optional web failure must leave OpenCode and unrelated
work usable. Record startup and exit failures through existing degraded
diagnostics, with no second supervisor or unbounded restart loop.

Report disabled, starting, available or failed from real observations. A live PID
or stale startup message alone does not establish current availability. Readiness
and diagnostics must not disclose a reusable native login URL or credential.

Stop new web work and its native CLI descendants before final recovery capture.
Verify completed and canceled writes against the existing shutdown deadline.
Reuse native AKM storage and fhold's existing recovery engine; add no second
index, workspace store, checkpoint format or backup implementation. Preserve
the [recovery contract](../assistant-recovery.md).

## Native authentication and access boundaries

Mount a dedicated AKM Web access credential through existing private secret-file
mechanisms. Do not reuse OpenCode's password, provider keys or another service's
credential. AKM loads the file and owns browser authentication. Its exact file
format, provisioning expectations and rotation behavior remain TBD-AKM-03.

Preserve ordinary Assistant filesystem grants and read-only mounts. Give the
web process no root privileges, Docker socket, credential-delegate identity or
access to the delegate's private plaintext secret store. Environment minimization
does not isolate files readable by the same UID; test actual filesystem and
process boundaries. Browser login does not change that boundary. Existing
[credential custody](../credential-custody.md) remains separate.

Allowing a parent to display an iframe must not grant the parent's JavaScript
cross-origin API access. Preserve AKM host/write-origin checks and authentication;
do not add permissive CORS or broaden accepted write origins to match embedding
parents. One canonical service origin can have multiple permitted parents.

The support matrix must distinguish cross-origin from cross-site embedding.
Same-site cross-origin frames may use existing cookie behavior; genuinely
cross-site cookie authentication generally requires different cookie attributes
and can still be blocked by browser privacy settings. An HTTPS parent can also
block an HTTP frame. A parent allowlist cannot override these browser rules.
Leave final guarantees to TBD-AKM-04/05 and test them with real browsers. A
shared-site deployment or external proxy can be documented without putting a
proxy into fhold. Arbitrary cross-site HTTP embedding is not promised.

## Admin and SSH access contract

The current SSH management path assumes every knowledge URL is an on-demand
token-bearing address to tunnel. Merely returning a persistent HTTPS URL from
`KnowledgeUi` would violate those assumptions.

Extend the existing typed operation/result with an explicit distinction between
persistent direct access and session-owned forwarded access. Final type names
are implementation details, not new native AKM settings. The provider/management
layer chooses the access route; common UI code does not branch on provider names.

For persistent mode, validate and return the configured HTTP(S) canonical URL
without a bootstrap credential. Admin loads it in the existing isolated
`WebContentsView` and keeps its origin/navigation restrictions. Closing the view
or management session releases only Admin-owned resources. Repeated opens must
not spawn another persistent server.

For on-demand mode, preserve the private native handshake, Linux bridge discovery,
session-bound child lifetime, and SSH forwarding. Closing stdin stops only that
session's child. Do not silently fall back to launching a second server if the
persistent endpoint is unavailable.

A remote persistent URL must be reachable from the Admin workstation. An SSH
connection alone does not make it reachable: changing to a local tunnel origin
would conflict with a fixed native canonical origin. Additional persistent tunnel
support requires explicit qualification; do not rewrite AKM's origin or cookies.

## Idle behavior

An idle listener must not keep the Assistant awake forever. Conversely, an active
web operation must not be mistaken for idle solely because OpenCode is idle.
Verify native activity reporting against existing keep-alive behavior using real
web operations, including long-running operations and their CLI descendants.

TBD-AKM-08 is a qualification dependency, not a documentation-only caveat. If
native activity is incomplete, request the upstream signal and explicitly leave
automatic idle shutdown with active web work unqualified. Do not silently change
the operator's idle settings or add fake activity, a parallel tracker, or a new
fhold agent policy. Persistent hosting on non-idling deployments can be evaluated
independently while this combination remains pending.

## Implementation plan

### Phase 1: finalize the native contract

Resolve the upstream table against published packages and source. Recheck the
current fhold base and concurrent dependency work before editing pins. Capture
the native direct-access, launch, readiness, framing and activity behavior in a
disposable fixture. This is a feature qualification step, not a new release
pipeline or an instruction to wait on unrelated upstream work.

### Phase 2: typed settings and deployment wiring

Extend the existing settings, secret-file ownership and Compose generation.
Cover disabled mode without any optional secret file, explicit enable/disable,
separate bind/publication choices, canonical-origin validation and rejected apply
operations. Saving settings should use existing pending-activation semantics;
passive inspection must not acquire access or restart containers.

### Phase 3: optional native process

Add startup after recovery/preparation, sanitized environment, real availability
diagnostics, optional exit handling and writer shutdown. Test missing credentials,
port conflict, process exit and termination while writing. Resolve native activity
integration before qualifying idling deployments.

### Phase 4: management and embedded Admin

Add typed persistent-direct versus session-forwarded access through the existing
management/SSH boundary. Keep the native embedded browser and its lifetime rules.
Preserve on-demand local/SSH behavior and explicitly unsupported ACA operations.
Test selected-instance switching, repeated opens, unreachable canonical URLs and
disconnects without duplicate processes or unintended deployment changes.

### Phase 5: qualification and operator documentation

Run affected source checks and real shipped-image/browser tests. Document native
settings, dedicated credential setup/rotation, local and SSH reachability, supported
framing arrangements, optional failures and shutdown/idle limitations. Qualify
the published AKM release before pinning the final fhold candidate. Follow normal
release scope and artifact reuse; this proposal does not authorize a release or
live-instance rollout.

### Expected change locations

| Existing owner | Expected work |
| --- | --- |
| `containers/assistant/tools/package.json`, `bun.lock`, and relevant image plugin pins | Qualified matching AKM Web/CLI/plugin versions after TBD-AKM-01; no unrelated dependency refresh. |
| `packages/lib/src/control-plane/stack-config.ts`, `compose.ts`, existing seed/secret/runtime-input owners, `packages/skeleton/system/stack/stack.compose.yml` | Typed optional intent, secret/mount/publication wiring and existing activation bookkeeping. |
| `containers/assistant/entrypoint.sh`, `healthcheck.sh` | Optional native child, readiness/degraded observations and existing writer shutdown. |
| `packages/lib/src/management/knowledge-ui.ts`, `types.ts`, `contracts.ts`, `wire-input.ts`, `instance.ts`, `instance-session.ts`, `ssh.ts` | Explicit access-route contract, persistent URL opening, preserved session-owned launch/forwarding. |
| `packages/lib/src/hosting/provider.ts` and applicable existing bindings | Capability composition; no provider switches in shared pages and no newly claimed ACA support. |
| `packages/electron/src/admin-app.ts`, `admin-knowledge.ts`, existing settings presentation | Persistent URL in the current isolated browser view and settings through shared typed operations. |
| `plugins/fhold/scripts/activity.mjs` and existing keep-alive integration, only if required by verified native behavior | Consume native activity without another tracker; exact changes pending TBD-AKM-08. |
| Existing configuration/management tests, `scripts/smoke-akm-web.mjs`, `scripts/smoke-keepalive.mjs`, recovery/lifecycle smokes and Electron E2E | Targeted native regression and feature coverage listed below. |

## Acceptance and verification

- Disabled mode works with no web credential file, mount, listener or host port.
  Invalid optional settings cannot turn off a usable core Assistant.
- Enabled mode uses the qualified native login, edit and logout flows. Test
  missing/invalid/expired sessions, rotation and restart behavior without logging
  credential values or embedding credentials in ordinary status output.
- Test container bind versus host publication, direct HTTP and externally proxied
  canonical URLs, forged Host/Origin, and unchanged OpenCode API/WebSocket access.
- Real browser tests cover multiple permitted parents, unlisted and nested
  parents, login/reload/write/logout, and relevant cookie restrictions. Fhold does
  not claim upstream-unsupported cross-site arrangements.
- Real Admin tests use its existing `WebContentsView`; repeated opens do not
  duplicate services, instance switching stays correctly scoped, and disconnect
  does not terminate persistent hosting. On-demand local/SSH cleanup still works.
- Kill or fail the optional process and confirm accurate diagnostics while
  OpenCode remains usable. Readiness reflects service availability, not just PID.
- Exercise shutdown during real writes and native child work; completed content
  survives recovery, canceled work is reported, and no writer outlives final
  capture. Preserve the existing shutdown deadline and exclusive recovery owner.
- Verify Assistant-UID denial of delegate-private plaintext secrets and actual
  read-only paths. Do not repair fixture permissions to manufacture a pass.
- Observe idle serving separately from active native work. Record evidence for
  TBD-AKM-08 before claiming automatic idle-shutdown support.
- Qualify affected Assistant editions/architectures and CLI/Admin artifacts using
  existing release gates. Reuse eligible evidence; do not create an extra build
  or publication pipeline for this feature.

This planning commit changes documentation only. Its checks are documentation
generation/tests and link/format review; runtime tests above are future acceptance
work, not claims of completed implementation.

## Non-goals and remaining decisions

No cloud-specific provisioning, automatic public exposure, fhold authentication,
SSO, TLS termination, rate limiter, native subpath shim, keyring change, delegated
secret migration, new backup engine, or legacy beta compatibility framework is
included. Enabling web hosting never authorizes changing live recovery settings.

The upstream contract table, supported browser matrix, activity/shutdown behavior
and exact native readiness probe remain open. Initial Docker/SSH support does not
imply Docker Desktop, persistent SSH tunneling, or ACA Admin support; qualify and
document each additional reachability path before exposing that capability.

## References

- [Core principles](core-principles.md), [environment and mounts](environment-and-mounts.md), and [hosting guide](../hosting.md).
- [Native credential custody](../credential-custody.md) and [Assistant recovery](../assistant-recovery.md).
- [Dependency and release process](../operations/updating-dependencies-and-releasing.md).
- AKM server/embedding proposal: **TBD-AKM-01** (upstream link pending; no broken placeholder link).
- [CSP frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors), [cookie attributes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie), and [third-party cookie constraints](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies).
