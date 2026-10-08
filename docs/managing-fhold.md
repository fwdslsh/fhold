# Managing fhold

Select an instance with `--name` or `-n`: a directory name always means
`~/fhold/instances/<name>`, while an absolute path can select any location.
The argument takes precedence over optional `FH_HOME`; without either, commands
act on the current directory. No environment variable or shell restart is needed
to manage different instances:

```bash
fhold status --name personal-agent
fhold -n another-agent status
fhold --name /srv/fhold/team-agent status
```

With `FH_HOME` unset, change into an instance's home and use the shorter commands
below. Existing homes are not moved by updates: use their saved absolute path,
cwd, `FH_HOME` or Admin's folder picker, not a name that resolves elsewhere.
`~/fhold` can hold `instances/`, `backups/`, `docs/` and other local directories;
those sibling directories are not part of any instance.
CLI and Admin use the same canonical instance and stable Compose
project. Different instances need distinct names; fresh setup chooses free ports.

### Move an existing instance home

Changing the default location does not move an existing installation. A move is
not a portable restore: preserve the **entire stopped home**, including `state/`
and `data/`, to retain native history, accounts and the same instance authority.

Use the matching released CLI's full-instance export/import. It reconciles the
installation receipt and generated paths; no metadata or environment-file edits
are needed. The destination must be empty. Do not install another instance there
first or run the original and restored copies together.

```bash
fhold --name /old/home stop
fhold --name /old/home backup --full --confirm-stopped --to /backups/instance-move
fhold --name /new/home restore --full --from /backups/instance-move --dry-run --confirm-stopped
fhold --name /new/home restore --full --from /backups/instance-move --apply --confirm-stopped
fhold --name /new/home start
```

Stop any separately launched writers before export. The export is unencrypted:
keep it private and outside both homes. External bind mounts, named volumes and
symlink targets outside the home need separate protection. Review their paths
and any ephemeral-recovery destination before starting the restored instance.
The saved instance name, ports, image versions, credentials, conversations,
plugins and task settings are retained; this is relocation, not an upgrade.

Verify history, native sign-ins, hostname, ports and client access at the new
location. Open the new folder in Admin; an old recent-path entry does not relocate
data. Preserve the original stopped home and full export until verification is
complete. On hosts using `/opt/stacks`, select the full path rather than a short
name that would resolve under `~/fhold/instances`.

Use the matching released CLI/Admin. A moved default home can then be selected by
its short name, for example `fhold --name april status` for
`~/fhold/instances/april`. Keep the full backup until the cutover is verified.

## Lifecycle and Admin

```bash
fhold status
fhold logs
fhold doctor
fhold start
fhold restart
fhold stop
fhold update
fhold update --no-start
```

Status/logs inspect without reconciliation or key creation. Explicit start,
configuration and update reconcile safely. Stop removes containers/networks,
not durable volumes or user data; there is no purge command. Offline update
refreshes managed files only and does not upgrade running containers.

Fresh installations use the public `fwdslsh/fhold-assistant`,
`fwdslsh/fhold-guardian` and `fwdslsh/fhold-portal` images pinned to their release.
An ordinary update pulls those pinned images; `--no-pull` uses existing copies.
Existing instances retain their saved image namespace and are not silently
switched from local builds to public images.

With the explicitly selected local image namespace `fhold`, ordinary update does not pull
and every activation uses Compose `--pull never`. Build the reviewed images
locally first; a missing local image cannot silently fetch a Docker Hub substitute.
Explicit `fhold update --pull` is refused for this local-only namespace.
An explicitly configured nonlocal registry namespace retains its default pull
behavior; `--no-pull` selects existing local copies for that registry intent.

### Upgrade from alpha.3

Download the new CLI or Admin from the [Linux release](https://github.com/fwdslsh/fhold/releases/tag/0.1.2610061043-beta.1)
first; `fhold update` updates the selected instance, not the CLI executable.
Select the existing home's **absolute path** in the new CLI, or open that folder
in the new Admin, then update:

```bash
fhold --name /absolute/path/to/existing-instance update
```

This keeps the existing location, saved identity, ports, data and credentials.
Managed image defaults advance to the installed CLI/Admin release. Explicit image pins remain pins;
review and update an older pin before activating the new managed policy mounts.
The CLI refuses an incompatible Assistant image rather than silently disabling
its hooks. CLI/Admin and image must come from the matching release.

Built-in AKM/fhold hooks now use native managed registration. Custom user,
project and ordinary plugin hooks are suppressed by the managed-only default;
move reviewed custom hooks into native managed settings before upgrading if
you rely on them. Plugin skills and MCP servers remain available. See
[managed harness configuration](managed-harness-configuration.md) for native
file paths and examples. Native remote workers remain experimental.

### Edit harness settings

Edit the native files under your instance's `config/` directory and run
`fhold restart` from that home (with `FH_HOME` unset), or select it with `--name`.
No image rebuild is required. Updates only seed missing operator files and
preserve your edits. Managed policy and the configuration directories are
read-only inside the container. OpenCode's preferred user preferences file is
the exception: Admin and trusted native clients use OpenCode's own API to edit
and reload it without restarting the process/container. Host editors that
replace that file or change its filename still require `fhold restart` to refresh
its file bind. Native reloads may interrupt active OpenCode work.
Use [the configuration map](managed-harness-configuration.md#deployment-inputs)
to choose between ordinary user settings and enforced operator policy. Do not
edit release-owned `system/` files or generated `state/stack.env`.

## Admin

Admin automatically opens the last-used instance on launch. First launch, or a
previous folder that is missing or incompatible, shows Welcome instead without
creating or changing anything. Use the instance dropdown → **Open another instance…**
to open a recent instance, browse for an existing one or start new setup.
On first launch, choose **Set up a new agent**, **Open existing instance…** or
**Import an instance…** from an entire-instance export.
Recent compatible instances are listed by saved name, with their folder paths
to distinguish them; unavailable folders cannot be opened as new installations.
**Set up a new agent** opens the Install → Connect → Ready wizard. Name the agent
once; its suggested folder is `~/fhold/instances/<name>`. Docker and Compose
checks run in the background without blocking typing or selecting a home.
Successful checks stay out of the way; missing prerequisites show a warning,
Docker/Compose setup links and **Check again**. The setup screen has no redundant
creation heading. Import is not a mode inside setup: it has its own entry point,
folder-selection step and separate review screen, without new-agent name or port controls.
**Advanced**, collapsed by default, contains the folder picker and port settings.
**Install fhold** follows Advanced and is the explicit installation confirmation.
The first step has only **Cancel setup**, returning to the instance choices
without installing. Import likewise has only **Cancel import** on its first
step; **Back** appears on review and preserves both folder choices.
After installation, **Finish later** leaves the agent running;
reopening its home resumes account setup. Ports are chosen automatically:
3810/3830 when available, otherwise a generated free pair. Saved ports remain
stable on refresh/update. Each installation
keeps its own knowledge, credentials, workspace and runtime data. Names are the
persisted Compose project names: `personal-agent` creates
`personal-agent-assistant-1` with OS hostname `personal-agent`. Setup and lifecycle
commands refuse to take over a same-named project from a different folder.
Existing names are not changed when opening a home; System → Installation details
shows the current name. Switching instances clears transient connection choices,
sign-in steps and previews after
unsaved-change confirmation; it does not stop a stack. Recent paths are stored
in the separate `fhold-admin` desktop profile, not instance state. Connection keys
are copy-only and fetched on request; OpenCode's password can still be loaded
masked or explicitly copied. Window size remains user-controlled.
SSH management is not implemented.

The sidebar has a slash immediately beside a single named instance dropdown;
there is no separate f/hold wordmark above it. Select a recent
instance to open it directly, or **Open another instance…** to return to Welcome
for folder selection or new setup. It shows no paths, status footer or Refresh
button. **Overview** shows the complete home path and container status; the path
also remains in System → Installation details. Status checks run every 15 seconds
while the selected instance is visible and when Admin regains focus. They pause
during operations and never overwrite drafts, sign-in steps, connection choices or
the configuration baseline. Unavailable checks do not claim a stopped or healthy
agent; provider readiness remains in Agent settings. Notifications and pending
restart appear at the bottom of the sidebar, not above page content. Setup keeps
its feedback visible in the wizard. Opening/switching instances
and automatic status checks never restart containers or resize the window.

Agent settings connects and verifies AI accounts. **Apps** is
organized by app: **OpenCode** first, then **Claude**, **Codex**, **Discord**, **Slack** and
**MCP**. Open an app to see its instructions, status, actions and settings.
Claude offers **Desktop chat** for this computer and an experimental **Claude
remote connection** for access from other devices. Codex contains sign-in,
pairing and knowledge recall. Discord
and Slack each contain their own bot tokens, allowed-user rules, default access
and individual user overrides; there is no shared token/app selector.
OpenCode contains its address, password and advanced network settings. MCP
contains enabling access, app permissions, connection instructions and its
advanced network settings. Bot setup enables the shared MCP service when needed.
An app's Save action changes that app, not other apps' unsaved drafts. Restart
confirmation and the persistent pending-changes alert still apply. Native
workers remain experimental; startup enabled is not a verified client connection.
There is no separate access-manager sidebar destination. System holds
installation details, recent logs, advanced connection-key rotation, import/export,
then ephemeral container support. A stale
settings snapshot is rejected so concurrent changes are not silently lost.

### App permissions

Choose what an app can do inside **Apps**, alongside its setup.
Claude Desktop, MCP, Discord and Slack offer three choices:

- **Chat only:** conversation without agent tools, file changes or tasks.
- **Read files:** conversation and non-sensitive workspace reads, without file
  changes or command execution.
- **Full access:** agent tools and actions within the Assistant's existing
  permissions. Choose this only for trusted apps or people; confirmation is
  required when granting it.

For Claude Desktop or another MCP app, choose permissions and select **Create
connection** before copying the address and **Copy access key** into the external
app's fields. A key is needed only for that connection step. New external access
retains the existing Read files default and receives a name automatically. Once
created, **Save permissions** edits that connection for the rest of this Admin
window. For an existing connection after reopening Admin, use **Advanced access →
Manage** to change its permissions rather than creating another connection.
There is no per-app saved-access picker; fhold cannot detect which external app
uses a copied key. Never interpret a saved name as verified client readiness.
Creating a new connection does not replace an existing app's key or conversations;
paste the new key only if you intend to use the new, separate connection.

Discord and Slack show permissions directly; fhold supplies their own access
keys without asking you to choose, name or copy one in normal bot setup. Saving
bot settings preserves that bot's current connection rather than reassigning it.
**Who can use the bot** still controls the allowlist independently.
**Different permissions for a person → Save person permissions** sets an exact
platform user's permissions;
that person must also pass the bot's allowed-user rules. **Use bot permissions**
removes the override, not the allowlist entry. Other app drafts are preserved.

Existing credentials, values, policies and assignments stay unchanged until an
explicit save. Changing saved permissions affects every use of that identity,
including external apps fhold cannot discover. Confirm the shared effect before
saving; existing conversations remain attached to the same identity. Explicitly
setting up separate access starts separate
credential-scoped conversations. Old conversations stay with the old identity;
external apps must be reconfigured when their connection key changes.

**Advanced access**, collapsed at the bottom of Apps, offers compact
permission editing through **Manage** buttons, not a policy matrix or key-card
destination. Permission dialogs do not include copy, replacement or removal.
Only saved bot assignments are known, not external usage. Missing selected
access never silently selects a more privileged identity.

**System → Connection keys → Rotate key** is for advanced security maintenance,
such as replacing an exposed key. Confirmation explains that the old key stops
working. Permissions and conversations stay unchanged. After rotation, **Copy
new key** provides the replacement for each external app where it was pasted.
fhold supplies bot keys automatically; apply the saved change when ready.
Copy fetches a private value only on request; there is no connection-key reveal
field and values are never stored in renderer preferences.

Permission saves use the existing configuration baseline and restart-now/later
confirmation; opening or cancelling a form restarts nothing. These permissions
do not control OpenCode's native password or Claude remote connection/Codex account access.
Those connections retain native sign-in, consent and approvals. Keep copied keys
private, like passwords. This Admin redesign is an unverified preview; see the
[verification runbook](operations/admin-setup-verification.md).

### Import/export and ephemeral container support

The **System** page starts with **Installation details** and **Recent logs**.
Below them, two separate sections explain content transfer and runtime continuity:

- **Import / export** offers an **entire instance**, requiring stopped containers
  and including native conversations, sign-ins and runtime authority, or
  **portable content**, transferring reviewed knowledge, workspace and allowlisted
  settings into a fresh agent. Portable sensitive content is opt-in and imported
  task definitions remain inactive; full imports retain active scheduling intent.
- **Ephemeral container support**, the last section, is opt-in automatic checkpointing for replacing
  the same Assistant after ephemeral storage disappears. It preserves native
  sessions, account files, approvals and consistent SQLite snapshots. It is not
  a host/Guardian/Portal rollback or an archive to import into a different agent.

CLI and Admin use the same `fhold backup` / `fhold restore` implementations.
Portable content can export while running; import it after installing a fresh
instance, before provider setup completes. For an entire-instance export, stop
the instance in Overview first and select **Entire instance (must be stopped)**.
To import that export, choose **Import an instance…** directly at Welcome,
**without installing first**. Choose the entire-instance export and a new/empty
destination, then **Review import**. Review shows the saved name, both paths and
warnings. **Back** preserves those choices for editing and requires another
preview; **Cancel import** exits without copying files. Folder choices are
independent of new-agent setup and never hidden under Advanced. The native confirmation
explains downtime, credentials, active tasks and external-storage limitations.
Both full operations leave containers stopped. These exports are not interchangeable
with the automatic same-instance checkpoint format.

Choose a private **local/mounted directory** or an existing **Blob destination**.
Live SQLite remains on local storage. Directory artifacts require exclusive
creation and atomic rename; Blob credentials use a private file or a deployment
managed identity, never a secret environment value or host CLI login.

Save leaves running containers alone and records a pending restart. For a
**genuinely new** destination/instance ID: save, confirm Stop, explicitly
**Initialize new destination** once, then confirm Start and **Check checkpoint
status**. Configuration alone is not a successful backup. For an existing
namespace, do not initialize again: start restores before writers run.
**Inspect saved coverage** is read-only; **Validate / restore same instance**
requires stopped writers and confirmation, leaves containers stopped, and
refuses conflicting surviving files. No automatic owner takeover is provided.

Advanced settings expose bounded timing, extra container paths/SQLite files and
external-mount/exclusion policy through the editable
`config/recovery/include.json`. They do not mount drives. Storage credentials and
runtime recovery policy are intentionally not ported by a portable archive.
See [Assistant recovery](assistant-recovery.md#configure-through-admin-or-cli)
for the same operations through `fhold recovery` and coverage details. Ordinary
image updates and coverage edits keep the same checkpoint destination. Failed or
overdue backups show a warning without stopping the agent; loss of ownership still
stops writers. Managed recovery requires the updated Compose assets; an older instance
must be explicitly updated before these settings can be saved.

### Save changes, restart when ready

Admin saves settings before offering **Restart now** or **Restart later**.
Postponing is the default; closing the prompt does not restart anything. Make
several changes and apply them together when you are ready. A persistent
**Pending restart** banner belongs to that instance and survives closing Admin
or switching instances. For a stopped instance, it offers **Start to apply**.

Applying recreates the configured containers and can interrupt active work and
client connections. The banner clears only after a successful healthy start;
failed or interrupted attempts keep it pending. A matching CLI's `fhold restart`
also applies the settings and clears the pending state on Admin's next refresh.
Use fhold's restart, not `docker restart`, to load changed environment, mounts
and image settings. Turning a remote worker off is also a saved change: it
continues running until you apply it. Native remote **Set up** separately asks
for permission before its sign-in workflow can restart containers.

Live credential keys, policies and portal-user mappings still take effect
without a restart; deferring settings does not defer credential revocation.
Provider sign-in and native provider/model API edits do not restart containers.
In-place native preference changes do not create a pending-restart alert.
If provider readiness also
changes Guardian's moderator configuration, the pending-restart alert lets you
choose when to apply it; verification does not open a restart prompt.

Restart tracking covers stack intent, release/seeded startup files, native
harness policy and enabled portal tokens. It excludes agent data and provider
login files and in-place native user preferences. The preferences filename/inode
is tracked because replacing that file changes the container's bind mount.
Existing homes gain a comparison baseline on their first managed
edit or successful start with these tools. It is not a watcher for arbitrary
files mounted through a custom Compose override; restart explicitly after
editing those files. Status inspection itself never writes tracking state.

## Provider and knowledge

**Agent settings** shows the AI service and default model your agent uses. It
does not present every saved key as a connected service. Use **Test response**
to check the current model; the result describes this check, not permanent health.

To change or add a service:

1. Choose **Add AI service**, then OpenCode Zen/Go, OpenAI, Ollama, LM Studio,
   llama.cpp or a custom OpenAI-compatible endpoint. **Another provider** searches
   OpenCode's native catalog.
2. Sign in or save an API key for a cloud service. For your own server, enter its
   API URL and optional key. Existing keys are never shown. Native browser
   sign-in has an explicit **Cancel sign-in** action.
3. Choose a model. For an endpoint, load its advertised models or enter the exact
   model ID. Discovery sends no inference request and is not a response test.
4. **Test response** makes a small, potentially billed, no-tool request to that
   exact model. Endpoint details are saved before this explicit test; a failed
   response does not erase them or imply sign-in was not saved.
5. **Use this model** explicitly sets the default for new conversations. Existing
   conversations and clients can retain their own model selection. Testing alone
   never switches your default or navigates away.

Ollama, LM Studio and llama.cpp must already have a model/API server running.
The request originates inside Assistant: `localhost` means that container, not
your desktop. Use a private address reachable from the container and restrict
server exposure to the intended network. fhold does not start model servers,
download models or change their listening address. See the
[endpoint networking notes](technical/opencode-configuration.md#local-and-custom-ai-servers).

The model picker excludes audio-only, embedding-only, non-tool and deprecated
models using native capabilities. Custom endpoint capabilities are native defaults;
their advertised IDs do not prove tool-call support. The short response test
proves inference, not every agent tool or vendor entitlement.

Expand **Saved AI setups** to review old sign-ins, including restored records.
They are not labeled connected or verified. Removing a saved sign-in deletes only
that instance's native credential, not vendor access or endpoint/environment
settings. **Disable endpoint** preserves its definition and separate sign-in,
using OpenCode's native disabled-provider setting. Edit and test it to explicitly
re-enable it; other disabled services stay disabled. Choose
another default first if the setup is currently used by your agent. Advanced
managed settings are read-only here; no operator policy is silently overwritten.

OpenCode owns providers, credentials and models. Use native sign-in, then
`fhold provider test`; `fhold doctor --readiness` makes a small real request.
Auth persists under `knowledge/secrets/auth.json`. Advanced native settings
are documented in [OpenCode configuration](technical/opencode-configuration.md).

Ask the trusted agent to remember facts or schedule work in ordinary language:
“Every weekday at 8 AM, check my project news and save the result to my inbox.”
Every run retains durable AKM history; scheduled reports are restricted to
`knowledge/inbox/`. AKM and automatic memory are enabled for fresh installations;
the scheduler uses the host OS timezone by default. Existing explicit choices
remain unchanged. Advanced operators can configure these through the CLI/config,
not Agent settings. Automatic memory is limited to trusted native build/plan
conversations. Never paste credentials into conversations.

```bash
fhold task list
fhold task create project-news --schedule '0 8 * * 1-5' --prompt 'Check project news and save a report'
fhold task show project-news
fhold task run project-news
fhold task history project-news
fhold task pause project-news
fhold task resume project-news
fhold task remove project-news
```

Timezone is explicit Assistant intent; daylight saving follows that IANA zone.
Downtime does not replay missed slots. Remove preserves the definition in
`knowledge/disabled-tasks/`. Restore stages tasks outside active scheduling;
`fhold task adopt <file>` validates prompt-only sources and installs paused.
Review the source and manual run's side effects/results before resuming.

## Access

Trusted native OpenCode bypasses Guardian. Guarded MCP uses named
`chat`, `read` or `full` identities; `full` grants native agent permissions.
Portal allowlists default-deny and per-user assignments use those same identities.

```bash
fhold credential list
fhold credential add reader read
fhold credential key reader
fhold credential map discord <user-id> reader
fhold credential mappings discord
```

Use [MCP](remote-mcp.md), [Discord](portals/discord-setup.md),
[Slack](portals/slack-setup.md) and [experimental native workers](native-remote-access.md)
for each normal connection flow. Never expose native Assistant publicly without
explicit bind intent and appropriate transport security.

## Import/export

### Entire stopped instance

Use this to preserve or relocate **the same instance** with its conversations,
remote sign-ins, approvals, credentials, policy, plugins and task state. It copies
the entire selected home, including extra top-level files, dependency trees,
empty directories, relative links and native SQLite databases **with their WAL
and SHM files**. All containers—including one-off, paused and restarting writers—
must be stopped before export/import and stay stopped throughout. Other processes
writing those files must also be stopped by the operator. Docker must be reachable
to verify the named project, even for a full import preview.

```bash
fhold --name personal-agent stop
fhold --name personal-agent backup --full --to /private/full-export --confirm-stopped
# Use a new/empty folder. Do NOT run install first.
fhold --name /absolute/path/restored-agent restore --full --from /private/full-export --dry-run
fhold --name /absolute/path/restored-agent restore --full --from /private/full-export --apply --confirm-stopped
# Review saved settings, external mounts and recovery destination, then start explicitly.
fhold --name /absolute/path/restored-agent start
```

`--confirm-stopped` acknowledges the inclusion of sensitive runtime authority and
downtime; it does **not** override the Docker check or stop/restart anything.
Full import is not a merge into an existing home or an automatic clone with a new
identity: it keeps the exported instance name, ports, keys, native approvals,
configuration and exact image versions. Never run the original and restored copies
together; stop the old project with `fhold stop` (which removes its containers)
before bringing its identity to a different folder. Existing same-named containers
owned by another folder are refused even when exited. Original homes and exports
are kept; retiring them is a separate decision. To restore over an existing home,
first preserve/move that home yourself and choose an empty destination.

The directory has the same required `fhold-backup.json` envelope with
`scope: "instance"` and a separate `instance/` payload. A complete inventory
records files, directories, link targets, ordinary permission bits, timestamps,
sizes and SHA256 hashes. No supported manifest is published for a failed export.
Full import checks the complete inventory (including unexpected files), refuses
overlapping/linked destinations and verifies copied bytes. Import previews are
read-only; Admin binds apply to the exact reviewed digest. Full CLI apply rebuilds
the current plan. Limits are 1,000,000 entries and a 128 MiB manifest; file copying
is streamed rather than loading databases into memory.

Only process coordination is omitted, with exact paths in the manifest: the
lifecycle/partial-import marker, Codex `tmp`, `.tmp`, `locks`,
`thread-writer-locks` and app-server socket, and AKM runtime locks. Plugin caches
and all ordinary files remain included. Links are not followed; external targets
are reported and preserved as references only. An absolute link into the original
home is rebased to an equivalent relative link in the restored home. Linked main
instance/runtime roots are refused instead of claiming their target data was saved.
Special files outside the known coordination exclusions block export.

Restore changes only generated host-location/owner metadata (`state/stack.env`),
the installation receipt's `homeDir`, and pending-start status; it adds a private
completion receipt under `state/instance-restore-receipts/`. Files belong to the
restoring non-root host user. POSIX ownership, ACLs/xattrs and hard-link inode
topology are not filesystem-image metadata in this directory format; ordinary
permissions and content are preserved. No seeding, key regeneration, native data
conversion, automatic task pausing, image upgrade or container startup happens. A partial import
leaves a private marker and blocks all managed startup; retain that folder as failure
evidence and retry into another empty folder rather than deleting or merging data.

Exports are **unencrypted and contain credentials**. Protect the whole directory
and any copies. Container images, named volumes, external bind sources and link
targets **outside the home** need separate backups or reattachment. Custom Compose
absolute paths are not automatically rewritten. Existing recovery settings/receipts
are preserved, but external checkpoints and ownership are not rolled back: review
the same-instance recovery destination and stopped-writer ownership before startup,
never reinitialize an existing namespace. Use matching native images/architecture;
this is not a cross-version data converter or permission to downgrade engines.

### Portable content

Use this for reviewed user content moving to a fresh installation. For replacing
an ephemeral container while preserving the same agent's runtime sessions,
accounts and approvals, use [Assistant recovery](assistant-recovery.md), not a
portable archive. Independently persistent container mounts are configured only
in that recovery policy; they do not alter host-side portable backup selection.

```bash
fhold backup --to /private/path/backup
fhold --name /absolute/path/new-instance install --no-start
fhold --name /absolute/path/new-instance restore --from /private/path/backup --dry-run
fhold --name /absolute/path/new-instance restore --from /private/path/backup --apply
```

A required `fhold-backup.json` with `product: "fhold"`, supported format and
bounded hash inventory identifies supported input. Raw/foreign homes and manifests
are refused. Restore applies only reviewed allowlisted portable content to a
fresh initialized target. It verifies hashes, refuses conflicting edits,
preserves source and skips identical content on re-preview retry.

Provider auth, private environment, portal/OAuth maps require separate opt-ins;
recreate referenced named identities first. Managed runtime settings and old
authority are not restored. Tasks remain inactive. Private receipts report partial
completion; per-file atomicity is not transaction-wide rollback.

If preview requires separate preservation, inspect the omissions and preserve
them before applying with `--acknowledge-unrestored`. CLI apply rechecks the
current plan; Admin additionally binds apply to its reviewed preview. Backups
are unencrypted, and ordinary knowledge/workspace files can contain secrets even
without sensitive opt-ins. Stop active work for a quieter backup; this is not a
consistent whole-home snapshot. Portal maps carry usernames, not keys or policies.
See the [portable-backup review](technical/portable-backup-review.md) for scope,
safe usage, retry behavior and identified improvements.

Portable backup does **not** include native conversation history, runtime state,
external work or linked files. Review the omission inventory and preserve those
separately. Recovery is not complete merely because portable files copied.

## Native history and updates

`fhold history --help` exposes offline native export/import. Select an explicit
trusted source image and runtime path, keep source/target stopped, map workspaces
and preserve private archives outside knowledge. Recovery uses consistent
WAL-inclusive snapshots, native preflight, collision checks, content verification,
stripped old authority and retry journals while preserving existing target sessions.

Unfinished tool calls block recovery by default. After review, pass
`--archive-interrupted` to both preview and apply to preserve those calls as native
terminal errors, explicitly marked interrupted and never rerun. Raw exports and
the source database stay unchanged. The private receipt identifies every changed
call; all other transcript content and IDs still undergo native round-trip
verification. Use the same option on retries; this is not an approval bypass.

Normal updates preserve native history and credentials in place. They preflight
configuration/assets before writes and retain private control-plane checkpoints
under `state/update-receipts/`. Those are not complete native-data rollback.
If a new engine may change native data, take a compatible stopped-instance
recovery point first. Do not automatically run older images against newer data.
No foreign-home importer or in-place foreign upgrade is provided.
