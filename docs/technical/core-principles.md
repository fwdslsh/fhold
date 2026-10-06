# Core principles

This is fhold's living product and security contract. Change it alongside any
implementation that changes a boundary. fhold is a single-install personal
OpenCode agent: native provider sign-in, real readiness, persistent knowledge,
ordinary-language recurring work and standards-based client access.

## Product and ownership

The wordmark is **f/hold**; plain text, commands and persisted names use lowercase
`fhold`. Owned source is MIT-licensed. Product variables use `FH_*` and the
source workspaces share the current product identity. Third-party native
tool names, configuration and licenses are not renamed.

Assistant is the only default container and includes OpenCode, AKM and
supercronic. Guardian and the single Discord/Slack Portal image are optional.
CLI is the primary installer/orchestrator; Admin is a local settings utility
with no server, chat, updater, tray or background control plane. The optional
Claude Desktop MCPB bridge is local stdio-to-Guardian.

OpenCode owns provider discovery, models, authentication and native approvals.
AKM owns knowledge and task formats. No parallel provider registry, proxy,
credential format, scheduler service or plugin platform is added. Image-baked
Codex/Claude workers remain experimental and vendor-native. Both supervisors
default on. Native sign-in/consent is never inferred and
explicit off settings remain off.
No software is installed at container startup.
Built-in skills are ordinary image-baked managed assets, shared through the
native fhold plugins and the root-owned read-only `/fhold-bundle` AKM source.
Operator-owned AKM catalogs may omit that source without blocking startup;
the built-in skills remain available through native harness integrations.
AKM and fhold plugins are preinstalled in all three native harnesses. Their
existing handlers are registered as native managed hooks at image build time;
no personal approval records are fabricated. Agents run as `fhold`, with home `/home/fhold`; the native
OpenCode HTTP username is `user`. Claude and Codex sign-in guidance preserve native login processes
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

Host-specific deployment/qualification tooling and third-party addon installers
are not part of the image, CLI/Admin or product test suite. fhold retains generic
runtime contracts, directory/Blob transports, product tests and reusable image
smokes. External tooling consumes the shipped image and documented interfaces
without importing internal source modules.

The managed/seed-once asset allowlists in `packages/lib/src/control-plane/seed-manifest.ts`
drive CLI, Admin and the standalone Assistant image. Updates replace only release-owned
managed files, seed missing operator files and never synchronize or delete
whole trees. New named homes live under `~/fhold/instances/<name>`; Admin's unnamed
default is `~/fhold/instances/default`. CLI home selection is an explicit
`--name`/`-n` directory name under that root or an absolute path, then optional
`FH_HOME`, then cwd. Admin reopens the last-used compatible instance once per app
launch, using its existing recent-folder list. First launch or an unavailable/
incompatible previous home shows Welcome without seeding or adopting a folder.
Manual switching keeps Welcome open across renderer reloads. `~/fhold`
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
Fresh setup prefers 3810/3830 and chooses an available pair if either is in use;
manual ports live under Advanced. Existing instances never change ports on refresh
or update. Availability checks are preflight, not a reservation until Compose starts.
Welcome starts with setup/open choices, or a compact named recent list, without
a redundant welcome heading. New setup is an Install → Connect → Ready wizard;
naming is requested once and optional folder/port settings share collapsed Advanced.
The setup screen omits a redundant creation heading. Import has a separate Welcome
entry point and a Choose folders → Review & import workflow, not an accordion
or mode inside installation. Its independent folder draft does not reuse or move
installation controls. Back appears only on review, preserves both folder choices
and invalidates the preview; Cancel exits the flow. First steps have one Cancel
action, not duplicate Back/Cancel navigation. After installation, Finish later
leaves the agent running. Native import protection remains the same. Disclosure controls
share the ordinary filled control styling and explicit chevrons. The management
sidebar combines the slash and named picker on one row without a second wordmark.
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
There is no new connection registry, protocol or generic integration engine.
Configured, running, native startup intent and verified client readiness remain
distinct. Native workers remain experimental and require native consent.

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
Targeted `PATCH /global/config` calls let OpenCode persist and reload its own
preferences, preserving unrelated settings and JSONC comments. Only its preferred
user settings file is writable; native trusted clients can edit that file too.
Config directories, plugins and operator policy remain read-only. Native reloads
can interrupt active OpenCode work, but do not restart its process or container.
Confirm the effective native result after reload; never roll back a native file
from a client-side snapshot. Disable endpoint uses native `disabled_providers`,
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
- Suspicious prompts and interaction answers escalate to a separate loopback
  moderator; failed or ambiguous verdicts block the request.
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
  or stop OpenCode. Guided setup cancellation/failure leaves startup off.
- Built-in Codex/Claude hooks use root-owned native managed files. Managed-only
  settings prevent duplicate execution of their plugin hooks. Codex diagnostics
  verify the exact build inventory and distinguish managed readiness from user
  approval. Older unmanaged images retain exact-hash review and version-checked
  writes. System policy is read-only to agents and supplied before startup;
  user-home recovery cannot replace it. See [managed configuration](../managed-harness-configuration.md).
  CLI/Admin verify the selected image's managed-policy capability before
  activating the new mounts, so an older image pin cannot silently suppress
  its only hooks. Active updates check compatibility before managed-file writes.
- Provider setup finishes only after a real no-tool request; it replaces only
  the untouched moderator placeholder with the exact provider/model verified.
- Scheduled tasks use the restricted `scheduled` profile, treat fetched content
  as untrusted, retain durable AKM results and write only to `knowledge/inbox/`.
  Removed sources are preserved; portable/manual restores stage definitions inactive.
- Scheduler timezone is explicit intent. Restart runs future slots only.
  `FH_SCHEDULER_ENABLED=0` disables user task sync and reconciliation.
  Knowledge, native workers and the independent recovery timer remain available.
  Health requires scheduler liveness when scheduling or keep-alive is enabled,
  and fresh reconciliation only when user scheduling is enabled.
- Optional conditional HTTP keep-alive uses native fhold activity hooks and
  the existing Supercronic process, independently of user task enablement. It
  has no cloud API authority or work-age expiry. Unknown activity keeps the
  instance awake; managed hooks must remain enabled. This is best-effort signaling,
  not a scale-in veto. See [the runtime contract](../harness-plugins.md).
- Automatic memory captures validated non-secret facts only from trusted native
  build/plan sessions through the existing provider and remains configurable.
  Remote/unattended sessions do not implicitly write personal memory.
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
snapshots, explicit workspace mappings, stripped old authority, collision checks,
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
The same versioned selection governs backup/restore; hashes bind it to accepted
checkpoints. Additions preserve prior state; narrowing an accepted selection fails
before claiming or writing targets. Lists have no fixed entry cap, but all existing
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
on recognized network filesystems. Policy/effective exclusions are bound to
accepted checkpoints; changed ownership needs a stopped-writer transition to a
fresh namespace. Topology changes abort publication and retain partial-restore
journals. Private inspection is read-only; confirmed offline restore starts no
application writers.
Native process coordination remains excluded even under an explicitly selected
parent; plugin caches may be included without restoring temporary wrappers or
live locks. This does not relax the prohibition on arbitrary links.

Explicit initialization is one-time; an established missing/corrupt/incompatible
head cannot become a blank agent. Valid newer surviving local state is preserved.
An exact surviving receipt permits restoring only missing accepted checkpoint
members after ephemeral storage loss, preserving newer surviving local files and
databases. Unreceipted partial state and orphan WAL/SHM files remain blocked.
Incomplete restore journals block native startup. Known initialized databases
cannot silently disappear during active capture. Routine capture does not stop the apps, and separately captured databases
and files are not one application-wide transaction. Readiness includes ownership
and accepted-checkpoint age. The engine owns the accepted publication clock;
health does not maintain a separate timestamp that can diverge after publication.
SIGTERM stops writers and descendants before the
bounded final checkpoint; forced termination can lose unpublished changes.
Writer shutdown and recovery have separate bounded waits so an in-flight capture
cannot consume the stopped-writer final checkpoint's budget. External host grace
must cover both phases and be tested in that environment.

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
Versions use real UTC `X.Y.yyMMddHHmm` timestamps and explicit alpha/beta/rc
channels. The CLI remains a standalone executable, not an npm bootstrap package.
Fresh installs use pinned `fwdslsh/fhold-{assistant,guardian,portal}` images.
Explicit local builds use the `fhold` namespace without registry pulls. Native
Linux x64 and ARM64 runners test runtime images and CLI; ARM64 Admin startup
and Windows/macOS packaging remain unqualified. No cross-host publishing bridge
is needed. An existing version/receipt permits identical-byte retries only; changed
source or content requires a new version, including unpublished candidates.
