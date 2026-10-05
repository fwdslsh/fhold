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

1. Select the old absolute path and run `fhold --name /old/home stop`. Stop any
   separately launched writer using its files. Take and verify a full stopped-home
   filesystem backup outside that home; a portable archive is insufficient.
2. Choose an unused destination and move the whole directory there. Keep the
   backup. Do not merge it into another home or change `deployment.projectName`,
   ports, keys or native account files.
3. In the moved `state/installation.json`, change **only** `homeDir` from the old
   verified absolute path to the new absolute path. Preserve its release and
   managed-image receipt. This is an explicit relocation metadata correction,
   not permission to adopt an unrelated home.
4. Reconcile derived paths without restarting by re-saving the existing
   Assistant port: `fhold --name /new/home config assistant --port <saved-port>
   --no-apply`. This regenerates `state/stack.env`; do not hand-edit that file.
   Review any operator-authored absolute bind paths in the custom Compose file
   separately. An update attempted before reconciliation safely refuses stale
   paths rather than mounting another home.
5. Run `fhold --name /new/home update`, then `doctor --readiness` for that same
   home. Verify history, native sign-ins, hostname, ports and client access.
   Open the new folder in Admin; an old recent-path entry does not relocate data.

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

Download the new CLI or Admin from the [Linux release](https://github.com/fwdslsh/fhold/releases/tag/0.1.2610050714-alpha.6)
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
preserve your edits; the files are read-only inside the container.
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
shows the current name. Switching instances clears transient keys, sign-in steps and previews after
unsaved-change confirmation; it does not stop a stack. Recent paths are stored
in the separate `fhold-admin` desktop profile, not instance state. Keys load
masked and require explicit Show/Copy. Window size remains user-controlled.
SSH management is not implemented.

The sidebar has a slash immediately beside a single named instance dropdown;
there is no separate f/hold wordmark above it. Select a recent
instance to open it directly, or **Open another instance…** to return to Welcome
for folder selection or new setup. It shows no paths, status footer or Refresh
button. **Overview** shows the complete home path and container status; the path
also remains in System → Installation details. Status checks run every 15 seconds
while the selected instance is visible and when Admin regains focus. They pause
during operations and never overwrite drafts, sign-in steps, displayed keys or
the configuration baseline. Unavailable checks do not claim a stopped or healthy
agent; provider readiness remains in Agent settings. Opening/switching instances
and automatic status checks never restart containers or resize the window.

Agent settings owns provider readiness, memory and timezone. **Connections** is
organized by app: **Claude**, **Codex**, **Discord**, **Slack**, **OpenCode** and
**MCP**. Open an app to see its instructions, status, actions and settings.
Claude contains both Desktop extension setup and experimental Claude Code
Remote Control. Codex contains sign-in, pairing and knowledge recall. Discord
and Slack each contain their own bot tokens, allowed-user rules, default access
and individual user overrides; there is no shared token/app selector.
OpenCode contains its address, password and advanced network settings. MCP
contains enabling access, connection instructions, identities/keys and its
advanced network settings. Bot setup enables the shared MCP service when needed.
An app's Save action changes that app, not other apps' unsaved drafts. Restart
confirmation and the persistent pending-changes alert still apply. Native
workers remain experimental; startup enabled is not a verified client connection.
**People & access** owns the reusable named identities and keys, not bot-specific
user mappings. System holds installation details, recent logs, import/export,
then ephemeral container support. A stale
settings snapshot is rejected so concurrent changes are not silently lost.

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
for the same operations through `fhold recovery`, exact coverage and transition
limits. Managed recovery requires the updated Compose assets; an older instance
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
Provider sign-in alone does not restart containers. If provider readiness also
changes Guardian's moderator configuration, Admin offers a restart to apply it.

Restart tracking covers stack intent, release/seeded startup files, native
harness policy and enabled portal tokens. It excludes agent data and provider
login files. Existing homes gain a comparison baseline on their first managed
edit or successful start with these tools. It is not a watcher for arbitrary
files mounted through a custom Compose override; restart explicitly after
editing those files. Status inspection itself never writes tracking state.

## Provider and knowledge

OpenCode owns providers, credentials and models. Use native sign-in, then
`fhold provider test`; `fhold doctor --readiness` makes a small real request.
Auth persists under `knowledge/secrets/auth.json`. Advanced native settings
are documented in [OpenCode configuration](technical/opencode-configuration.md).

Ask the trusted agent to remember facts or schedule work in ordinary language:
“Every weekday at 8 AM, check my project news and save the result to my inbox.”
Every run retains durable AKM history; scheduled reports are restricted to
`knowledge/inbox/`. Automatic memory is configurable and limited to trusted
native build/plan conversations. Never paste credentials into conversations.

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
