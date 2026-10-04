# Managing fhold

Select an instance with `--instance` or `-i`: a directory name always means
`~/fhold/instances/<name>`, while an absolute path can select any location.
The argument takes precedence over optional `FH_HOME`; without either, commands
act on the current directory. No environment variable or shell restart is needed
to manage different instances:

```bash
fhold --instance personal-agent status
fhold -i another-agent status
fhold --instance /srv/fhold/team-agent status
```

These selectors describe the source CLI/next release. Published alpha.3 still
uses `FH_HOME`; see [installation](installation.md#select-an-instance).
With `FH_HOME` unset, change into an instance's home and use the shorter commands
below. Existing homes are not moved by updates: use their saved absolute path,
cwd, `FH_HOME` or Admin's folder picker, not a name that resolves elsewhere.
`~/fhold` can hold `instances/`, `backups/`, `docs/` and other local directories;
those sibling directories are not part of any instance.
CLI and Admin use the same canonical instance and stable Compose
project. Different instances need distinct names; fresh setup chooses free ports.

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

Admin starts at Welcome: previous/default instance, recent paths or a folder
picker. **Create new instance** suggests `~/fhold/instances/<name>` as you enter a name;
choose another empty folder or full path to override it. It then opens setup
with the chosen editable instance name. Ports are chosen automatically:
3810/3830 when available, otherwise a generated free pair. **Advanced** offers
manual overrides. Saved ports remain stable on refresh/update. Each installation
keeps its own knowledge, credentials, workspace and runtime data. Names are the
persisted Compose project names: `personal-agent` creates
`personal-agent-assistant-1` with OS hostname `personal-agent`. Setup and lifecycle
commands refuse to take over a same-named project from a different folder.
Existing names are not changed when opening a home; System → Installation details
shows the current name. Switch instance clears transient keys, sign-in steps and previews after
unsaved-change confirmation; it does not stop a stack. Recent paths are stored
in the separate `fhold-admin` desktop profile, not instance state. Keys load
masked and require explicit Show/Copy. Window size remains user-controlled.
SSH management is not implemented.

Agent settings owns provider readiness, memory and timezone. Connections holds
OpenCode links, Guardian MCP details and optional portals. People & access owns
named identities. System holds backup, restore, logs and diagnostics. A stale
settings snapshot is rejected so concurrent changes are not silently lost.

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

## Portable backup and own-backup restore

```bash
fhold backup --to /private/path/backup
fhold --instance /absolute/path/new-instance install --no-start
fhold --instance /absolute/path/new-instance restore --from /private/path/backup --dry-run
fhold --instance /absolute/path/new-instance restore --from /private/path/backup --apply
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
