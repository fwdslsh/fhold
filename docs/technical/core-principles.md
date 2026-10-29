# Core principles

This is fhold's living product and security contract. Change it alongside any
implementation that changes a boundary. fhold is a single-install personal
OpenCode agent: native provider sign-in, real readiness, persistent knowledge,
ordinary-language recurring work and standards-based client access.

This implementation uses OpenCode 2 with AKM 0.10 prerelease integrations.
Native live settings, permissions and persistence checks are recorded in the
[qualification report](../operations/opencode-v2-qualification.md). Public
artifacts must additionally pass the GitHub release gates.

CLI/Admin may publish independently of the runtime. Their build version comes
from the library manifest; the Skeleton and Claude Desktop manifests retain the
last published runtime and extension versions. Tooling-only releases preserve
those image/download defaults and run tooling/artifact gates, not unchanged
container gates. Runtime source or runtime dependency-resolution changes require
a full release. Tooling-only dependency changes may rehoist unchanged packages;
compare non-tooling consumers' resolved dependencies rather than lockfile paths.

## Primary product rule

fhold is primarily a prebuilt image using AKM and OpenCode for custom, private
assistants, with minimal repeatable setup and maintenance tooling. Reuse their
native features before adding code; remove duplicate orchestration and local
agent/tool/memory policy. Any machinery outside this purpose requires explicit
product-owner approval to add or retain. Existing code is not approval. fhold
remains beta; do not add historical configuration converters or compatibility
frameworks. Preserve operator data/settings and native consent, and maintain
Guardian\'s actual external credential boundaries.

## Product and ownership

The wordmark is **f/hold**; plain text, commands and persisted names use lowercase
`fhold`. Owned source is MIT-licensed. Product variables use `FH_*` and the
source workspaces share the current product identity. Third-party native
tool names, configuration and licenses are not renamed.

Assistant is the only default container and includes OpenCode, AKM and
supercronic. Guardian and the single Discord/Slack Portal image are optional.
CLI is the primary installer/orchestrator; Admin is a local settings utility
with no server, chat, tray or background control plane. Its standard Electron
platform-native updater checks/downloads while Admin is open, defaults to the Stable
channel (even in a prerelease build), and applies on ordinary quit or an explicitly
confirmed Admin restart. It never restarts agents, updates container images or
replaces operator-installed CLIs. SSH connections separately prepare exact bundled
management bytes in a private content-addressed cache, without lifecycle actions,
home writes, release downloads, PATH fallback, daemons or new services. All SSH
discovery, sessions, forwarded commands and transfer operations share this resolver.
Packaged Admin selects its current bundled Skeleton and SSH helpers directly,
never through inherited resource-location environment variables. Automatic
relaunch cannot combine new code with an old AppImage's assets. Optional Linux
application-menu installation explicitly copies Admin to a stable per-user
AppImage path and installs standard XDG desktop/icon identities (verified on KDE;
GNOME and X11/Wayland-specific grouping still need manual qualification).
Replacing that copy from another download requires explicit confirmation and
does not infer version ordering from desktop-entry metadata or file sizes.
Windows packaging uses a per-user NSIS Start menu shortcut
and matching AppUserModelID; macOS uses an Applications bundle with its own Dock
icon. Windows/macOS desktop integration is preview-tested on native runners,
independently of Linux container publishing. Public distribution/signing remains
unqualified; native update checks stay unavailable until feeds are published.
Linux menu installation requires
no system installer, background agent or instance changes;
native AppImage updates preserve that stable launcher target.
Optional failures remain local to the updater. The optional
Claude Desktop MCPB bridge is local stdio-to-Guardian.
Portal runs on Node LTS, the supported runtime for the Slack/Discord SDKs,
with Node's built-in SQLite and HTTP server. Bun remains its build/test tool.
Platform health follows the live SDK connection; a failed/disconnected portal
does not stop the Assistant. Vendor WebSocket implementations are not patched.
Portal tracks running Guardian jobs through completion, failure and explicit
input, using bounded MCP requests rather than an overall reply deadline.
Authenticated MCP streams may remain quiet without the HTTP idle timeout closing
them. A transient transport interruption reconnects with the existing
credential-scoped job handle, never replays the request, approval or cancellation,
and uses bounded inspection retries. A lost connection is not an agent failure;
partial public answers remain visible. Handles arrive immediately after accepted
submission, before native inspection. Slack uses native Markdown blocks with a
plain-text fallback only when the platform explicitly rejects the blocks; final
Stop-control cleanup preserves answer formatting.
Discord channel mentions start threads; Slack answers stay in the message's
thread. Public answer text streams as throttled message edits, with continuous
Discord typing and lightweight tool feedback. Standard MCP progress carries
current-turn text and tool names/statuses, never reasoning or tool inputs/outputs.
Question and permission controls are requester-only, including when users share
a credential. Decisions go through Guardian's existing interaction API; ordinary
chat text never approves a permission. Slack Stop controls cancel the same job.
No slash commands or direct Assistant connection are required. Missing optional
thread/reaction permissions or failed progress delivery are logged without
abandoning valid work. Private SQLite delivery receipts retain queued requests,
accepted job handles, public reply snapshots and acknowledged platform message IDs.
After a Portal replacement, recheck requester access and resume inspection of the
accepted job; do not submit it again. Recreate current input controls from Guardian,
never from saved approval decisions. Known messages are edited in place; unknown
submissions or unacknowledged posts require explicit review rather than blind replay.
Native sessions remain accessible in OpenCode. See [Portal restart recovery](../portals/restart-recovery.md).

OpenCode owns provider discovery, models, authentication and native approvals.
AKM owns knowledge and task formats. No parallel provider registry, proxy,
credential format, scheduler service or plugin platform is added. Image-baked
Codex/Claude workers remain experimental and vendor-native. Both supervisors
default on. Native sign-in/consent is never inferred and
explicit off settings remain off.
No software is downloaded at container startup. The pinned native plugin managers
may refresh image-owned local plugin selections while preserving operator settings
and native consent. After recovery, AKM's native migrator runs before agents and
task writers; AKM owns conversion and backups. fhold adds no format converter.
Built-in skills are ordinary image-baked managed assets, shared through the
native fhold plugins and the root-owned read-only `/fhold-bundle` AKM source.
Operator-owned AKM catalogs may omit that source without blocking startup;
the built-in skills remain available through native harness integrations.
AKM and fhold plugins are preinstalled in all three native harnesses. Their
handlers run through one native plugin registration path, with native consent;
user/project hooks are not suppressed and no approval records are fabricated. Agents run as `fhold`, with home `/home/fhold`; the native
OpenCode 2 HTTP username is `opencode`. Claude and Codex sign-in guidance preserve native login processes
across tool calls without implementing token exchange or accepting user consent.
The image-baked `fhold-admin` skill provides redacted current-container diagnostics
and routes to versioned Claude/Codex setup scripts. It has no host/cloud management
authority. Claude's existing worker relays explicit native trust/consent through
a PTY; Codex's pinned foreground app-server uses its private native Unix control
socket for standard pairing, without a runtime-installed/self-updating daemon.
Temporary control sockets are not recovery data. Running, account sign-in and
pairing remain separate from a verified native-client tool request.
Assistant includes pinned, upstream npm/npx compatible with its pinned Node runtime,
installed through npm's standard global upgrade at image build time so ordinary
stdio MCP clients can launch their declared commands. Bundled dependency advisories
remain subject to the image scan gate; do not patch npm's internal dependency tree.
No desktop keyring service or vendor-specific client dependency is added to work
around a headless client bug.
Image-baked native CLIs have standard `/usr/local/bin` launchers, including for
OpenCode login shells that replace the image's `PATH`; no user exports are needed.

Use standard container practices and upstream-supported tool installation and
configuration. Do not patch vendor tools or accumulate per-tool wrappers, startup
workarounds or settings that users must recreate. Tests exercise shipped behavior
through normal user interfaces; they must not repair PATH, permissions or native
settings to hide a product defect. Fix the owning layer and keep the normal path
small and maintainable.

Optional failures are logged, isolated and reported as degraded state while the
agent continues. Scheduling, knowledge hooks, keep-alive, native remote workers
and diagnostics do not become whole-container restart gates. Core readiness is
the authenticated native API with its required recovery restoration and owner.
Only an unusable core or unsafe continuation stops startup/writers, including
missing authentication, incomplete restore or actual loss of recovery ownership.
Experimental, default-off AKM cache recovery is separate from essential state.
Only a private candidate with completed native incremental clean is admitted;
cache failures rebuild on demand. Its bounded optional budget may add startup
latency without consuming the essential recovery allowance. Cache settings and
format may change or be removed; see the recovery contract for scope and bounds.

Host-specific deployment/qualification tooling and third-party addon installers
are not part of the image or product test suite. fhold retains generic
runtime contracts, directory/Blob transports, product tests and reusable image
smokes. External tooling consumes the shipped image and documented interfaces
without importing internal source modules.
CLI/Admin additionally share a small host-side hosting-provider boundary: implicit
local Docker, native SSH to the installed Docker-host CLI, and an optional,
experimental native Azure CLI adapter for existing Container Apps. It creates no
cloud resources and owns no custom deployment configuration. Connection metadata
and recents are shared in the host's `~/.config/fhold/hosting.json` (or XDG root),
not copied into instance intent or backups. Remote targets never fall back to
local files/containers; unsupported operations show a specific explanation.
CLI and Admin consume one composed instance session with separately typed host,
agent, app and data operations. Ordinary pages do not branch on hosting provider
names; individual unavailable operations retain their place and explanation.
Docker intent is an optional host-owned subview, never a synthetic cloud home.
Passive status does not acquire forwards or contact/wake an idle native agent.
Explicit native access and temporary sign-in belong to the selected session;
closing it releases those resources, never stops a deployment or changes worker
startup intent. Native model verification remains successful if optional host
installation completion fails, with the partial result reported separately.
Preference results distinguish saved intent from verified effective settings;
neither implies a durable recovery checkpoint. Lifecycle effects come from host
operation metadata, not provider branches in shared confirmation dialogs.
Observed lifecycle eligibility is a separate deployment fact for UI display;
it never mutates the operation-description catalog or preflights an invocation.
Host capability negotiation belongs to the adapter, not a caller's preliminary
status read. A direct operation negotiates its methods/features before dispatch;
unknown optional capabilities do not become false upgrade requirements. Shared
native transport and Docker host primitives sit below hosting and management.
CLI `connect` defaults to MCP consistently and uses advertised route metadata to
explain an OpenCode-only connection before requesting native credentials.
Native host authentication stays with SSH/Azure. A fixed SSH command receives
typed JSON and uses the native PATH plus standard `~/.local/bin`. Discovery reads
managed Compose labels and bounded root/child/home candidates. Host-CLI repair is
explicitly confirmed, checksum-verified and atomic; it never changes Docker,
SSH trust or instance files. Connection editing/removal affects metadata only,
clearing scoped recents on endpoint changes rather than silently retargeting them.
Admin's own Settings page owns host-connection management and app-update
preferences. These remain accessible without a selected or healthy instance.
Update preferences live in Admin's local user-data `settings.json`, separate
from shared hosting metadata and all instance files. Beta and Alpha are explicit
opt-ins; switching back to Stable discards any staged prerelease update and waits
for a newer stable release without downgrading. GitHub releases carry the standard
electron-builder Linux feed for each architecture, verified alongside installers.
There is no custom release protocol, updater service or startup installer.

SSH opens a session-scoped management facade over stdin/stdout, preserving native
sign-in and model-verification state. Local and SSH Admin use the same instance
domain functions; only transport, directory selection, archive transfer and browser
forwarding differ. SSH exposes the normal Admin pages and CLI commands, not merely
lifecycle observations. Standard private SCP/PAX transfer preserves full-export
metadata, and native loopback forwards close on switch/exit without stopping agents.
The fixed SSH endpoints receive
typed JSON on stdin; no shell-interpolated path, arbitrary exec RPC, extra service,
container manager credential or runtime management port is added. Native Docker
subprocesses pin a local socket from the selected native context, never send local
bind paths to a remote daemon or mutate the global context. ACA reports platform
observations and accepted lifecycle requests honestly, separately from readiness,
replica drain, runtime recovery ownership and external deployment intent.
Azure onboarding uses native browser sign-in and read-only account/scope choices.
The adapter owns scoped diagnostics, logs and its explicit interactive console.
Confirmed restart addresses the one active revision through Azure's native API;
it does not apply Docker intent, edit deployment templates or establish recovery
completion. Native management credentials stay on the user's computer, and
status/discovery never contact the agent or implicitly wake an idle replica.
Provider capabilities are named operations; diagnostics and optional onboarding,
console and file-management interfaces remain adapter-owned. Common CLI/Admin
dispatch does not assume every remote target is SSH or has a local instance home.
Admin always uses the same Overview, Agent settings, Apps and System screens,
navigation and section order, regardless of hosting provider. Unsupported sections
remain visible, natively disabled and explained; unknown configuration is never
shown as absent or off. Cloud observations use the ordinary service inventory and
System logs/details, without a separate hosted-instance page or a fake StackConfig.
No unsupported action falls back to local files, credentials or containers, and
viewing these pages does not wake an idle agent.
Standalone deployers may opt into exact-name workload environment aliases using
`FH_OPENCODE_ENV_MAP`. Values are exported only for OpenCode, not persisted,
logged or passed as command arguments. Original configured names are stripped
from writer environments; scheduler and native remote-worker launches get no
aliases. Invalid optional mappings warn without stopping the agent. This is
process launch scoping, not plugin/tool isolation: OpenCode subprocesses inherit
aliases and its plugins may use them during scheduled requests. No cloud-specific
authority, token broker, wrapper or new managed settings layer is introduced.

The managed/seed-once asset allowlists in `packages/lib/src/control-plane/seed-manifest.ts`
drive CLI, Admin and the standalone Assistant image. Updates replace only release-owned
managed files, seed missing operator files and never synchronize or delete
whole trees. Native system policies belong to that managed allowlist:
`system/assistant/opencode.json`, `system/codex/{config,requirements}.toml` and
`system/claude/managed-settings.json`. OpenCode uses the existing read-only
`system/assistant` directory; Codex/Claude use individual file mounts so image-baked
hook files remain visible. User preferences/account state, AKM task activation and
custom engines/bundles, Guardian settings and custom Compose stay operator-owned.
Ordinary native user/project policy remains available without custom mounts.
Explicit system-level policy mounts are operator-owned. Old config policy files remain inert and untouched without
automatic migration, import or deletion; no refresh-untouched-seeds or startup
configuration writer is added. New named homes live under `~/fhold/instances/<name>`; Admin's unnamed
default is `~/fhold/instances/default`. CLI home selection is an explicit
`--name`/`-n` directory name under that root or an absolute path, then optional
`FH_HOME`, then cwd. Admin reopens the last-used compatible instance once per app
launch, using its existing recent-folder list. First launch or an unavailable/
incompatible previous home shows Welcome without seeding or adopting a folder.
Browsing other instances preserves the selected instance and drafts; Back returns
without switching. Only explicit Open replaces the target. Cancelling setup/import
returns to Welcome without starting a stack. `~/fhold`
may also hold backups/docs; it is not itself an instance or a new configuration layer.
Home selection is canonical; default changes never relocate existing homes or
rename their persisted project identity. Each home has stable independent project
intent and saved concrete ports.
Admin separates saving configuration from applying it. Container-disrupting
actions require explicit confirmation, with postponement as the default. A
private, per-home applied-runtime digest records known startup inputs, not
credentials or agent data. Read-only snapshots report pending changes across
Admin restarts and instance switches. Only successful healthy activation clears
the pending state; updates also verify their selected image identities first.
The existing lifecycle lock and Compose path own application. No background
service, automatic restart or second configuration store is introduced.
Overview shows observed container image tags independently of saved intent and
runtime health. The available image tag comes from the managing tool's bundled
runtime cohort (the exact locally supplied management helper for SSH), not a registry lookup or an assumed
latest version. If Compose omits a reference, a bounded, image-only Docker inspect
fills it from the actual container. Optional metadata failures never block management.
SSH management never falls back to an installed host CLI or invents versions from
saved intent or the desktop release. Update preserves explicit
custom image pins and native confirmation.
Fresh setup prefers 3810/3830 and chooses an available pair if either is in use;
manual ports live under Advanced. Existing instances never change ports on refresh
or update. Availability checks are preflight, not a reservation until Compose starts.
Welcome starts with setup/open choices, or a compact named recent list, without
a redundant welcome heading. Open another instance leads directly to one location
chooser for local/SSH/cloud discovery; local and remote folders use their native
pickers. Host connections live in app Settings, separately from agent Apps. Returning
from Settings refreshes discovery without selecting a target. Button-state updates
never navigate between screens. New setup is an Install → Connect → Ready wizard;
naming is requested once and optional folder/port settings share collapsed Advanced.
The setup screen omits a redundant creation heading. Import has a separate Welcome
entry point and a Choose folders → Review & import workflow, not an accordion
or mode inside installation. Its independent folder draft does not reuse or move
installation controls. Back appears only on review, preserves both folder choices
and invalidates the preview; Cancel exits the flow. First steps have one Cancel
action, not duplicate Back/Cancel navigation. After installation, Finish later
leaves the agent running. Native import protection remains the same. Disclosure controls
share the ordinary filled control styling and explicit chevrons. The management
sidebar uses a full-width named instance picker without a brand mark or wordmark.
Read-only Docker/Compose checks run independently of instance selection so they
do not block naming or create a home. Successful checks add no status clutter;
missing prerequisites show actionable guidance and an explicit retry. Each stage has explicit navigation out of
setup; leaving an installed agent does not stop it. Opening an
existing instance never silently starts a fresh installation. Compatible-home
labels are read from current intent, not stored in a second registry. Preparing
an empty/new folder does not install anything until explicit confirmation. A chosen
DNS-safe name reuses `deployment.projectName` for Compose/container naming and
the Assistant hostname; the CLI uses that same name to select its default folder,
not a separate install-name option or second name registry. Fresh setup refuses
names already present in Docker. Compose commands check project working-directory
ownership before acting, so a selected folder cannot take over another instance.
Opening/switching homes never resizes the window or starts/stops a stack.

Admin Apps is organized by the app the user wants to connect, not by
protocol, container or harness: OpenCode first, then Claude, Codex, Discord, Slack
and MCP. Claude offers Desktop chat and Claude remote connection, not a choice
between similarly named developer products. Each bot owns its token setup,
allowlists, inline permissions and individual user mappings. Apps owns
app permissions; there is no separate access-manager navigation destination.
OpenCode/MCP network controls stay under that app's Advanced
settings. App-scoped saves use the existing intent/baseline/restart path and
preserve other apps' drafts; bot enablement retains its shared MCP dependency.
There is no new app-credential registry, ingress protocol or generic integration engine.
Configured, running, native startup intent and verified client readiness remain
distinct. Native workers remain experimental and require native consent.

Admin's Open OpenCode action uses native `POST /api/pair` and opens its single-use
`/auth/connect/:code` link in the default browser. OpenCode owns expiry, redemption
and the browser session cookie. The long-lived password stays in the management
process, not the URL, renderer or clipboard. Local Docker and SSH use the selected
instance's existing credential and route; SSH keeps its existing session-scoped
forward. HTTPS-hosted agents use the explicit native connection established in
Admin, without fetching cloud secrets or assuming Azure login is OpenCode login.
Passive inspection never creates a pairing code. No proxy, new ingress, runtime
patch, auth bypass or deployment restart is needed.

Guarded apps present inline Chat only, Read files and Full access choices;
granting Full access requires explicit confirmation. Normal bot setup hides
fhold keys entirely and preserves its assigned identity without a credential
picker. Claude Desktop/MCP explicitly create a connection before showing
the key-copy step needed by the external app. A collapsed Advanced access section
at the bottom of Apps offers compact permission editing with real Manage
buttons, not key cards, accounts or a policy matrix. Existing registry IDs, values, defaults and
policy contracts do not change; no new policy or app-assignment store is added.
Native OpenCode/Claude remote connection/Codex access is independent of Guardian
permissions. Copy fetches connection keys only on explicit request; there is no
key-reveal UI and values never persist in renderer preferences. Permission dialogs
have no copy, replace or remove actions. System's collapsed Connection keys
section owns explicit, confirmed key rotation; it preserves identity, permissions
and conversations and explains that external apps must update their copied key.
Native assignment/final-key restrictions remain unchanged.
Changing a reused identity's permissions affects all uses and requires explicit
confirmation. Ordinary edits preserve its ID/value and conversation ownership.
Per-app saved-access selectors are not part of ordinary setup. Creating a new
external connection is explicit; editing an existing one belongs to Advanced
access. Never silently fork, transfer or revoke identity. Known bot assignments are shown
honestly; external key use cannot be detected or inferred from a credential name.
App-scoped saves preserve other drafts, use the reviewed configuration baseline
and retain the existing deferred restart path. Opening setup/status creates no
keys, assigns no access and performs no automatic permission escalation.

Management notifications and the persistent pending-restart alert live at the
bottom of the sidebar, including at narrow widths. Setup retains visible inline
feedback rather than placing errors in its hidden sidebar. Restart activation
still requires explicit confirmation; moving alerts never restarts containers
or resizes the window.

Agent settings starts with the resolved native default model, not a directory of
apparently connected accounts. Saved sign-ins and endpoint definitions are a
secondary, reviewable inventory; they never prove a working connection. Add AI
service guides native sign-in or an OpenAI-compatible endpoint, model selection,
an explicit short response test and an explicit Use this model action. Listing,
saving credentials and discovering model IDs make no inference request. Model
discovery runs from the Assistant's network, not the Admin host. Keys remain in
native auth, never inline in generated provider configuration. Native OAuth
attempts remain provider/method/instance bound until completed or cancelled.
Tests stay on the page and never change the default model; only explicit Use
changes it. The model picker uses native text-input/text-output/tool-capable,
non-deprecated models. A model list alone is not verification of tool execution.
OpenCode 2's settings-write API supports shell selection, not a general config
patch. Admin makes narrow edits to the selected native user preference file,
preserving unrelated settings and JSONC comments, and OpenCode's native watcher
applies them without an explicit reload. The ordinary user-config directory is
writable so atomic editor saves and local user-plugin updates work normally.
Image-baked plugins and operator policy remain read-only. Confirm the effective
native result; never roll back a native file from a client-side snapshot.
Disable endpoint uses native `experimental.policies` for `provider.use`,
preserving its definition and credentials; saving it again explicitly re-enables
only that endpoint. Sign-in removal is exact and separate from endpoint disabling
or vendor-side revocation. Never
silently discard restored credentials, including IDs missing from the catalog.
No model-name heuristics, duplicate provider registry or raw JSON UI is added.
Memory and scheduling preferences remain advanced CLI/config intent, not setup
questions. Fresh installs enable AKM/automatic memory and default to the host OS
timezone, preserving existing explicit choices.

`state/stack.json` requires `product: "fhold"` and owns deployment intent.
Derived env/keyrings do not own settings. Inspection is read-only; mutations
use a shared per-home lock and current intent. Foreign/nonempty unrelated
homes are refused, not adopted. fhold has no foreign-home importer or aliases.

## Security

The following container configuration rules describe shipped defaults and
release-test expectations. A user controlling the Docker host owns their Compose
customizations; host tooling is not a security boundary against that user.
`fhold doctor` may report differences as advisory warnings, but the policy audit
does not authorize or veto start, restart, update or offline recovery. Native
Compose parsing, instance targeting, lifecycle locks, image compatibility and
the recovery engine's identity/integrity/ownership checks remain operational
requirements. No bypass flag or automatic rewrite of operator overrides is needed.
Guardian's own authentication and request protections remain unchanged.

- No service runs as root or receives additional Linux capabilities.
- Assistant never receives Docker, host-admin, Guardian or portal authority.
- Native Assistant API is authenticated and loopback-published unless explicit
  intent selects another exact bind. Native access intentionally bypasses Guardian.
- External guarded requests enter authenticated Guardian MCP. Protection cannot
  be disabled by an overlay. Authentication, origin, moderation and secret/path
  boundary errors fail closed.
- Named credential identities have private file-backed keys and fixed
  `chat`, `read` or `full` policy. A request cannot choose its own profile.
- `chat` and `read` begin with deny-all; `read` excludes managed secrets,
  private knowledge environment and dotenv reads. `full` inherits native access.
- Handles are encrypted, authenticated, expiring and credential-scoped.
  Session ownership is independently bound in native metadata.
- Guardian reads through its own read-only workspace mount and rejects both
  canonical-path and opened-descriptor escapes.
- Suspicious prompts and interaction answers use OpenCode's native tool-free
  generation API with Guardian's separate moderation prompt/model selection.
  No second server, provider credential copy or agent session is needed;
  failed or ambiguous verdicts block the request.
- Portal allowlists default-deny. Operator-owned per-adapter maps select only
  explicit identities; each adapter receives just its generated keyring.
- Native remote workers bypass Guardian and use operator-supplied native task
  permission policy. Native account sign-in and remote consent remain explicit.
  Never copy host login files or fabricate user consent. Process-running status
  is not account/client readiness.
- Codex defaults to `workspace-write`; `read-only` also uses its native sandbox.
  Explicit `danger-full-access` uses the container as the isolation boundary,
  without an inner filesystem/network sandbox or bubblewrap prerequisite.
  Task approvals follow native policy, defaulting to `on-request`.
  Never select it automatically after a failed sandbox probe or grant extra
  capabilities. Accessible data, credentials and network remain within its reach.
- Enabling Claude or Codex remote access enables its supervisor on every
  Assistant boot, independently of the scheduler. Missing/expired sign-in or
  native consent may prevent connection but does not silently unset that intent
  or stop OpenCode. Cancelling native sign-in preserves prior startup and sandbox
  intent; cancelling later pairing does not undo an already applied confirmed change.
- Built-in Codex/Claude hooks use one native plugin registration, preserving
  native trust/consent and operator/project hooks. There is no managed-only
  exclusion or image task-policy compatibility gate. Actual recovery capability
  and ownership checks remain. See [native configuration](../managed-harness-configuration.md).
- Provider setup finishes only after a real no-tool request; it replaces only
  the untouched moderator placeholder with the exact provider/model verified.
- Scheduled tasks use native AKM engine/agent selection and the operator's
  unchanged prompt, with no additional fhold tool ceiling. Removed sources are preserved; portable/manual restores stage definitions inactive.
- Scheduler timezone is explicit intent. Restart runs future slots only.
  `FH_SCHEDULER_ENABLED=0` disables user task sync and reconciliation.
  Knowledge, native workers and the independent recovery timer remain available.
  Missing scheduler processes or overdue reconciliation produce actionable
  health-log warnings shown by CLI/Admin; they do not fail core readiness.
  Reconciliation runs in the background and retries without blocking startup.
- Optional conditional HTTP keep-alive uses native fhold activity hooks and
  the existing Supercronic process, independently of user task enablement. It
  has no cloud API authority or work-age expiry. Unknown activity keeps the
  instance awake; managed hooks must remain enabled. Native supervisors use the
  installed CLI's account status to wait in `sign-in-needed` before launching an
  unsigned-in worker. This inactive state permits idle without fabricating native
  hook observations. Failed status checks and missing signed-in worker coverage
  remain unknown, not proof of idle. This is best-effort signaling,
  not a scale-in veto. See [the runtime contract](../harness-plugins.md).
- Native AKM plugins own automatic context, learning and reviewable memory
  proposals for native/custom agents. fhold does not filter prompts or implement
  its own extractor. Explicit off choices remain off. Guardian's current
  chat/read credential ceiling excludes automatic private context/learning;
  full credentials inherit native behavior.
- `state/stack.env` contains non-secret derived input. Child processes use
  argument arrays; lifecycle commands never interpolate shell strings.
- Compiled CLI launches do not automatically read the invoking directory's
  dotenv or Bun configuration. Instance selection comes from the explicit CLI
  argument, optional shell environment or cwd, never unrelated project files.
- Assistant Bun helper/AKM launches disable workspace dotenv and bunfig loading
  with native image runtime options; `/work/bunfig.toml` is not managed preload
  authority. This does not add a launcher or configuration service.

## Persistence and recovery

`system/` is release-owned; `config/`, `knowledge/` and `workspace/` are
operator-owned. `state/` contains control-plane intent/derived credentials;
`data/` contains durable native runtime state. Portable backup is not full
runtime recovery: preserve detected runtime data, links and external files
separately, and report omissions prominently.

Own-backup restore requires a supported bounded fhold manifest, validates hashes
and preview digest, refuses conflicts/path escapes, preserves source/target and
requires explicit sensitive-data opt-in. Per-file atomic writes are not
transaction-wide rollback. Private plans/receipts make partial failure honest.
Native history recovery uses offline non-root workers, WAL-inclusive consistent
snapshots, explicit workspace mappings, collision checks,
existing-target preservation and private retry journals outside knowledge.
Unfinished tool calls block by default. Explicit reviewed archival may convert
them to native terminal interrupted errors without replaying them; raw exports
remain unchanged and private receipts identify every conversion.

An explicit whole-instance export/import scope preserves the entire stopped home,
including native sessions/databases (and WAL/SHM), account credentials, permissions,
plugins, active tasks and deployment identity. Both operations verify stopped Docker
writers under the ordinary lifecycle lock; other writers must also be stopped.
The same manifest envelope records all files, directories and unfollowed links,
with hashes and explicit process-coordination omissions. Full import only accepts
an empty destination, validates the complete inventory and preserves the original
home/export. It reconciles generated host paths/owner metadata without seeding,
changing native authority or upgrading images. Containers remain stopped; partial
imports block startup and retain private evidence. CLI requires explicit stopped
confirmation; Admin additionally binds apply to preview and explains sensitive
data, active schedules, downtime, external sources and single-instance identity.
External drives/checkpoint namespaces are not rolled back. This is not an active
clone, cross-version converter or a substitute for ephemeral checkpoint ownership.

Opt-in Assistant-only ephemeral recovery is a separate, sensitive same-instance
format, not portable import. One image-baked Bun worker restores before default
seeding or any AKM/native writer, takes bounded SQLite-native snapshots on its
own timer, and publishes complete immutable generations under ownership and a
conditional descriptor. Live SQLite stays on local storage. Local or mounted
network directories hold artifacts, subject to coherent atomic filesystem
semantics; object-storage transports share the same recovery core. No deployment,
wake, scale, cloud-management tooling, extra service or mandatory sidecar is added.

One optional externally supplied `FH_RECOVERY_INCLUDE_FILE` extends the native
catalog with literal absolute file/directory paths and registered SQLite files.
The versioned selection is recorded with each checkpoint and bound by hashes.
Restore applies the current selection without writing newly excluded or unselected
paths; the next checkpoint records the edited coverage. No new namespace is
required for coverage edits. Lists have no fixed entry cap, but all existing
size/count/deadline, link, private-state and destination boundaries still apply.
CLI/Admin expose the same generic settings through StackConfig and an operator
policy file, not another backup engine, format, service, plugin registry or cloud
management layer. Saving is deferred. Initialization/offline restore require
confirmation and stopped local writers; status/coverage inspection are read-only.
Host tools and the image share the selection normalizer. Blob credentials are
private files granted only to Assistant, never environment values or portable
content. Compose adds exact directory/policy/private-state mounts and derives
adequate termination grace without widening native or ingress authority.
Versioned recovery policy may exclude directory roots, require independent mount
roots and opt into recognized network-mount discovery. Ordinary local volumes
stay covered. Excluded roots are never traversed/written; missing required mounts
block startup. Registered SQLite and WAL/SHM paths cannot be excluded or placed
on recognized network filesystems. SQLite discovered in selected trees uses
native snapshots without requiring a second path list. Recorded policy/effective
exclusions remain part of historical checkpoints; current policy governs restore.
Topology changes during an operation abort publication and retain partial-restore
journals. Private inspection is read-only; confirmed offline restore starts no
application writers.
Native process coordination remains excluded even under an explicitly selected
parent; plugin caches may be included without restoring temporary wrappers or
live locks. This does not relax the prohibition on arbitrary links.

Explicit initialization is one-time; an established missing/corrupt/incompatible
head cannot become a blank agent. Valid newer surviving local state is preserved.
An accepted-generation surviving receipt permits restoring only missing selected checkpoint
members after ephemeral storage loss, preserving newer surviving local files and
databases. Unreceipted partial state and orphan WAL/SHM files remain blocked.
Incomplete restore journals block native startup. Known initialized core and
explicitly selected databases cannot silently disappear during active capture;
versioned native Codex filenames may change during native migrations. Package
versions and ownership epochs are provenance, not restore-compatibility gates.
Supported checkpoint format, identity, hashes, database integrity and current
ownership remain enforced. Native tools own their schema upgrades. Warm startup
does not apply backup inventory limits to an already receipted home; only missing
checkpoint members are validated and restored, without overwriting surviving data.
Routine capture does not stop the apps, and separately captured databases and
files are not one application-wide transaction. Readiness requires completed
restoration and ownership. A delayed/failed checkpoint warns about durability
and retries without stopping a working agent. Actual ownership loss still stops
writers. Private diagnostic writes and the optional probe can fail without
invalidating ownership; status writes retry. The engine owns the accepted publication clock; health does not maintain
a separate timestamp that can diverge after publication.
SIGTERM stops writers and descendants before the
bounded final checkpoint; forced termination can lose unpublished changes.
Writer shutdown and recovery have separate bounded waits so an in-flight capture
cannot consume the stopped-writer final checkpoint's budget. External host grace
must cover both phases and be tested in that environment.
In-flight ownership renewal finishes before the final checkpoint and release;
an actual renewal failure still prevents an unsafe final checkpoint.
Process exit races in `/proc` traversal must not abandon final recovery. The
entrypoint logs writer stop, successful checkpoint/owner release and completion;
failed recovery is a visible nonzero shutdown, never a successful-stop claim.
Normal termination uses the image PID 1, with no pre-stop repair or automatic
ownership takeover. See the supported shutdown sequence in the recovery guide.

Directory ownership has no automatic timeout takeover. External tooling must
confirm the previous writer is stopped before explicitly clearing a stale owner.
Publication fencing does not make arbitrary external tool actions exactly-once.
Private recovery includes supported native account/trust/approval files without
auto-trusting anything; actual token refresh and vendor reconnect remain separate
qualification gates. Same-instance recovery with explicit scheduling enablement
preserves reviewed future-only intent; scheduling off leaves stored tasks inactive.
See [Assistant recovery](../assistant-recovery.md) for supported destinations,
configuration, limits and verification evidence.

Ordinary updates preflight identity/config/assets before managed writes and retain
private control-plane checkpoints/failure evidence. They preserve knowledge,
history, keys, approvals and scheduling intent. Offline file refresh is not a
running-container upgrade; do not downgrade images automatically after native
data changes. Future schema conversions belong beside a real changed schema,
not an empty timestamp-release migration registry.

## Current release boundary

GitHub at https://github.com/fwdslsh/fhold is the canonical source and contribution
host. GitHub builds Linux standalone CLI and Admin AppImage downloads and
publishes Assistant/Guardian/Portal images to public Docker Hub. Every candidate
needs its own artifact and runtime gates; earlier artifacts do not qualify changed source.
The 0.1 release line uses real UTC `X.Y.yyMMddHHmm` timestamps and explicit
alpha/beta/rc channels. The historical 0.2 patch format is `yyMMdd<build>`:
UTC year/month/day plus an unpadded daily build number starting at 1, with the
same prerelease suffixes. From 0.3 onward use `X.Y.YYMMNN[-alpha|-beta|-rc]`:
UTC year/month and exactly two counter digits starting at 00. Each public release,
including channel promotion, consumes a counter; there is no additional serial.
Development candidates use source SHA/image digest; reserve a version near
publication. Unpublished candidates and local dry-run receipts do not reserve a
counter and may change. Published tags, images and downloads remain immutable.
See the [release runbook](../operations/release.md#monthly-versions-from-03)
for ordering, UTC reset, immutable retries and refusal after counter 99.
Historical 0.1/0.2 versions remain valid and immutable. This changes release
naming, not recovery or runtime schemas.
The CLI remains a standalone executable,
not an npm bootstrap package.
Fresh installs use pinned `fwdslsh/fhold-{assistant,guardian,portal}` images.
Explicit local builds use the `fhold` namespace without registry pulls. Native
Linux x64 and ARM64 runners test runtime images and CLI; ARM64 Admin startup
remains unqualified. Windows/macOS desktop integration is preview-tested on native
runners; public distribution/signing remains unqualified. No cross-host publishing bridge
is needed. Published versions permit identical-byte retries only; changed public
content requires a new version. Final changed artifacts must pass qualification.
