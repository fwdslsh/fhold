# Assistant recovery

Recovery is an opt-in, same-instance runtime feature. It is separate from
portable backup/import and offline native-history transfer: recovery artifacts
can contain private provider credentials, conversations, workspace trust and
native approvals. Keep the destination private and protect it independently.
The private runtime format is not a portable user archive and adds no custom
per-object encryption. Use encrypted storage and narrow access externally;
hashes detect corruption, not malicious replacement by an authorized writer.

### Choose the right operation

| Need | Use | What it preserves |
| --- | --- | --- |
| Move reviewed content into a fresh installation | CLI/Admin portable backup and restore | Knowledge, workspace and allowlisted settings; sensitive content is opt-in and tasks need review. |
| Preserve or relocate an entire stopped instance | CLI/Admin full-instance export/import (`--full`) | Entire home, including native history, sign-ins, keys, active tasks and same-instance identity; external sources need separate protection. |
| Resume the same agent after replacing its disk/container | Assistant runtime recovery | Native databases, sessions, credentials, approvals and selected files, under single-owner checkpoint authority. |
| Transfer conversations with reviewed workspace mappings | Offline native history export/restore | Conversation history with explicit authority handling, not an entire runtime. |

Keep these contracts/formats separate. Portable imports deliberately do not
replay runtime credentials or checkpoint authority; recovery must preserve that
authority and native state. Combining their writers would
complicate those guarantees. Container exclusions are never silently applied to
host portable backup. See [managing fhold](managing-fhold.md) for those flows.

## Runtime configuration

Standalone deployments supply the image inputs below. Managed CLI/Admin installs
store the same non-secret intent in `state/stack.json` under `recovery`, selection
in `config/recovery/include.json`, and Blob credentials in the private file
`state/secrets/fhold_recovery_connection_string`. No cloud management is included.

### Configure through Admin or CLI

Open **System → Ephemeral container support**, the last section after installation
details, recent logs and import/export. This is the Admin name for the same runtime
recovery feature; environment variables and `fhold recovery` commands are unchanged.
Enable **automatic checkpoints and restore**, then choose
a private local/mounted directory outside the instance home or an existing
`azblob://account/container/prefix`. The stable instance ID defaults from the
saved instance name. Blob uses a private connection-string file or the deployment's
explicit managed identity, never a host CLI account. Saving does not initialize
storage or restart containers; a persistent alert records unapplied settings.

For a **genuinely new** namespace: save, stop the instance through its confirmed
lifecycle action, and choose **Initialize new destination**. Confirmation is
required, existing namespaces are refused, and native writers remain stopped.
Then start normally and **Check checkpoint status**. Initialization is not a
checkpoint. For an **existing** namespace, never initialize again: startup
validates/restores before writers run. **Validate / restore same instance** does
that offline while stopped; it does not erase surviving data or select an older
rollback point. Stale ownership still requires separate external verification.

**Inspect saved coverage** is read-only. **Advanced recovery settings** exposes
additional paths/SQLite and exclusions/required mounts/discovery. These are
literal container paths, not host names; listing them does not mount a drive.
The native engine checks database integrity, required mounts and accepted
authority. Ordinary image upgrades and coverage edits do not require a new
destination. Package versions are recorded for diagnosis, not used to reject
an otherwise valid checkpoint. Native tools handle their own database upgrades.

The CLI uses the same shared operations:

```sh
fhold --name my-agent recovery configure --directory /absolute/private-checkpoints
# Blob alternative; the input file must be mode 600/400:
fhold --name my-agent recovery credential --from /absolute/private-connection-string
fhold --name my-agent recovery configure --to azblob://account/container/my-agent
fhold --name my-agent recovery show
fhold --name my-agent stop
fhold --name my-agent recovery init --confirm-new-instance  # new namespaces ONLY
fhold --name my-agent start
fhold --name my-agent recovery status
fhold --name my-agent recovery inspect
```

`recovery configure --selection-file /absolute/policy.json` saves a reviewed
selection. `--interval`, `--max-unsaved` and `--timeout` adjust bounded timing;
`--instance-id` supplies stable identity. `--managed-identity [--client-id UUID]`
selects externally supplied identity; `--connection-string` selects the private
file. `recovery disable` saves an off choice for next restart and keeps all data,
credentials and checkpoints. `recovery restore --confirm-stopped` validates and
restores offline, not a portable archive.

Update earlier managed homes with the current CLI before configuring this
surface, so their allowlisted Compose file has the recovery mounts. Saving never
updates an old image implicitly. Activation and offline operations also require
the matching Assistant image's mixed-storage recovery capability; an older image
is refused before containers or checkpoints are changed. Compose derives termination grace from the
operation budget (297 seconds by default), mounts the backup root at `/recovery`,
the policy read-only at `/run/fhold-recovery/include.json`, and private staging/
receipts from `data/recovery` at
`/run/fhold-recovery-state/<destination-and-ID-digest>`. Changing a destination
does not copy or fabricate native authority.

Recovery protects the **Assistant**, not deployment intent, managed system policy,
Guardian/portal databases or independently persistent drives. Preserve those
separately. Recovery credentials and selection files are not portable backup
members. A different home or image does not make a checkpoint portable.

| Input | Default / purpose |
| --- | --- |
| `FH_RECOVERY_URL` | Unset keeps ordinary disk persistence; `file:///absolute/path` or `azblob://account/container[/prefix]` enables strict recovery. |
| `FH_INSTANCE_ID` | Required with recovery; stable lowercase slug, not a replica/revision name. |
| `FH_SCHEDULER_ENABLED` | `1`; set `0` to disable user scheduling only. |
| `FH_RECOVERY_INTERVAL_SECONDS` | `60`; capture cadence, 1–86,400 seconds. |
| `FH_RECOVERY_MAX_UNSAVED_SECONDS` | `300`; warn when the last accepted checkpoint is older than this threshold. Does not stop the agent; independent of the capture interval. |
| `FH_RECOVERY_OPERATION_TIMEOUT_SECONDS` | `120`; monotonic between-step/SQLite budget, 1–3,600 seconds. |
| `FH_RECOVERY_PROBE_PORT` | `0` (off); private health-only probe, not the native API port. |
| `FH_RECOVERY_STATE_DIR` | `/home/fhold/.fhold-recovery`; private staging/receipt, no arbitrary native-tree overlap. |
| `FH_RECOVERY_INCLUDE_FILE` | Unset keeps the native catalog; externally supplied absolute JSON file for additional paths, SQLite registrations and optional mount policy. |
| `FH_RUNTIME_DIR` | `/tmp/fhold-runtime`; ephemeral private process/status files. |
| `FH_RECOVERY_CREDENTIAL_FILE` | Unset uses explicit managed identity; otherwise absolute private standard Blob connection-string file. |
| `AZURE_CLIENT_ID` | Unset uses system managed identity; UUID selects a user-assigned identity. |
| `FH_RECOVERY_ALLOW_INSECURE` | Off; exact `1` enables HTTP only for allowed emulator hosts. |
| `FH_RESTORE_TIMEOUT_SECONDS` | `300`; entrypoint wait for validated restoration before native startup. |
| `FH_SHUTDOWN_SECONDS` | `25`; writer-stop grace, not the final backup deadline. |

Invalid numeric timing/probe settings log their setting names and use the
documented defaults; they do not prevent a valid instance from starting.
Invalid scheduler enablement disables scheduling only. Identity, destination,
authentication and restore-safety errors still require correction before startup.

Set the existing native API password through its normal private secret-file
contract. Codex/Claude workers remain independent and experimental. Both
supervisors default on, with independent explicit off switches.
Configuring recovery does not sign them in, accept trust or approve their tools.

## Local or mounted-directory destination first

Use `FH_RECOVERY_URL=file:///absolute/path/to/private-backups` and a stable
`FH_INSTANCE_ID`. The directory is a backup destination, not the live Assistant
home. Keep working SQLite databases on local storage. A network-mounted backup
directory is eligible only when all owners see the same filesystem and atomic
directory creation, exclusive file creation and atomic rename behave correctly.
This does not qualify live SQLite WAL on NFS/SMB or object-storage FUSE.

Initialize a genuinely unused namespace through the explicit recovery
initialization operation before ordinary startup. Initialization is not an
always-on flag: startup refuses a missing, corrupt, inaccessible, incompatible
or wrong-instance recovery head. It must never quietly create a blank agent.
With the same destination/identity environment that ordinary startup will use,
run the image's `fhold-recovery init --confirm-new-instance` once. Use
`fhold-recovery status` for the private durability status; initialization alone
is not a checkpoint or application readiness. Do not reinitialize an established
namespace to work around a restore error.

For a new disposable instance, external tooling can initialize the namespace by
overriding the image's ordinary entrypoint. Choose an exact empty backup directory
and exact image reference yourself; this example does not create or delete them:

```sh
docker run --rm --entrypoint fhold-recovery \
  --user "$(id -u):$(id -g)" \
  --mount type=bind,src=/absolute/private-backups,dst=/recovery \
  --env FH_RECOVERY_URL=file:///recovery \
  --env FH_INSTANCE_ID=my-agent \
  YOUR_DIGEST_PINNED_ASSISTANT_IMAGE init --confirm-new-instance
```

The mount must be writable by the configured non-root user. For host-owned bind
mounts, use the same numeric UID/GID for initialization and every subsequent
container, as managed fhold installs do. Configure ordinary
startup with the same destination and instance identity, separate writable local
native state, and native password secret. Perform native provider/vendor sign-in
through the image's existing private exec/setup flow after restoration; no Azure
management CLI or copied host login is involved.

Only one owner may serve an instance. Directory ownership does not expire
automatically. After a crash, an external operator must confirm the old writer
and its descendants have stopped before explicitly transferring ownership.
A timeout or replica count of one is not proof that the old writer is stopped.
Never manually remove a lock while an old writer may still run.

For an image upgrade, drain the old deployment before starting its replacement.
An orchestrator reporting **Stopped**, **NotRunning**, or an old successful
readiness result does not prove the final checkpoint finished or ownership was
released. Wait for the old replicas/processes and descendants to be removed,
allow the full termination grace described below, and check for completed
checkpoint publication and owner release. Do not update/restart immediately
after only a stop request is accepted. An interrupted shutdown may leave an
owner nonce even when the final process is gone; use the exact-owner unlock
procedure below only after external confirmation that every old owner stopped.
Keep deployment-specific lifecycle scripts outside the fhold runtime.

Blob uses a 60-second descriptor lease, renewed every 10 seconds with a conservative
45-second local safety window. A persistent owner nonce remains after lease expiry:
expiry alone never authorizes takeover. Neither descriptor fencing nor a timer can
stop a partitioned native process's local writes or arbitrary external tool action.
External routing must not expose two owners, and a paused old host must be confirmed
terminated before ownership transfer.

After externally confirming every old writer/publisher and descendant is stopped,
read the exact owner nonce from the private descriptor/owner record. With the same
destination, instance identity and transport authentication environment, run:

```sh
fhold-recovery unlock --confirm-stopped --owner EXACT_PREVIOUS_OWNER_NONCE
```

Use the image's recovery executable in a separate non-writing operator invocation
(override its normal entrypoint), not a running Assistant tool session. The command
checks exact identity/nonce; it does not establish that the old process is dead.
Then start normally and allow full restore validation. Never substitute an old
nonce, delete a lock manually or run `init` to work around failed recovery.

Recovery logs preserve allowlisted failure reasons without exposing file paths,
credentials or raw SDK errors. Repeated identical checkpoint failures are logged
once until a capture succeeds; the private status records the current failure.
An unreleased owner explains blocked restarts, not necessarily the initial crash.
Retain platform system/console logs externally to distinguish an interrupted
shutdown, lost storage ownership, an unhealthy probe or resource exhaustion.

## Blob destination and authentication

Azure Blob uses the identical storage-neutral core added after directory proof.
Use `azblob://account/container[/prefix]`, without credentials/query strings.
Account is 3–24 lowercase letters/digits; container is 3–63 lowercase
letters/digits/hyphens with no consecutive hyphens. Prefix components use only
letters/digits/underscore/hyphen, 1–128 characters each. Empty components, dot
segments, percent escapes and trailing slashes are rejected.

Authentication is explicit managed identity (system identity by default,
`AZURE_CLIENT_ID` selects a user-assigned identity) or
`FH_RECOVERY_CREDENTIAL_FILE` pointing to a private standard connection-string
file. No default host CLI account discovery or credential logging is allowed.
The file must be a regular non-linked file with owner-only permissions, such as
mode 600/400; SAS and `UseDevelopmentStorage` shorthand are not accepted.
Transport credentials must live outside native/knowledge/workspace trees (or
inside the excluded private recovery directory), never in searchable knowledge.

An emulator endpoint comes only from that connection string; HTTP requires exact
`FH_RECOVERY_ALLOW_INSECURE=1` and a host of `localhost`, `127.0.0.1`, `[::1]` or
`azurite`. Cloud authentication and hosted/native-client qualification remain
separate from emulator evidence. S3 is not qualified. There are no cloud
management tools, hosting selectors, mandatory sidecars or startup installs.

The private health-only probe has `/live` and `/ready`, no control API. Do not
route it publicly. A conflicting or unavailable probe warns and is disabled;
it does not prevent restoration, checkpoints or native startup. Recovery environment must be removed from native worker/tool
launch environments, but trusted same-UID code is not OS-isolated from private recovery
files; external storage policies must protect retention/rollback independently.

## Scheduling and durability

`FH_SCHEDULER_ENABLED=0` disables task synchronization, cron and reconciliation,
not recovery, AKM knowledge or native access. Explicit scheduling enablement
preserves reviewed same-instance intent and resumes future slots only; it does
not replay missed slots or in-flight tool calls. Portable/manual restore retains
its separate task-review requirement.

Periodic captures use SQLite-native snapshots, never a changing database/WAL
file copy. Each database is individually consistent, but sequential databases
and workspace/auth files do not form one application-wide transaction. Capture
intervals must be recorded. Readiness requires completed restoration and active
ownership, not a recovery worker PID alone. An overdue or failed checkpoint
reports `durable: false` and a backup warning while the agent keeps running and
retrying. It does not make a working agent unhealthy or trigger a restart.
Actual ownership loss still stops writers to prevent competing checkpoints.
Private status publication is diagnostic: write failures warn and retry without
being treated as ownership loss. If status cannot be read, report diagnostics as
unavailable, not as proof that a live owner lost its lock. The owner still enforces
restoration and renewals independently; its exit stops the native writers.
Accepted-checkpoint age is owned by the engine after conditional publication
and its private receipt write; the supervisor uses that same monotonic clock.
A later staging-cleanup error must not make an accepted, receipted checkpoint
disappear from health bookkeeping. An older restored checkpoint alone does not
count as a fresh boot publication.

Core health proves the authenticated agent is usable and, when configured,
restoration completed with a live recovery owner. Optional task reconciliation,
scheduler, knowledge and keep-alive failures appear as health-log warnings in
CLI status and Admin Overview. They never trigger a whole-container restart.
Reconciliation and heartbeat failures retry; a stopped optional process requires
corrective action and an explicit restart. Readiness is not provider/client readiness.

The potential loss window includes the timer interval, capture and upload time;
outages make it longer. SIGTERM should stop writers and descendants before a
bounded final checkpoint, releasing ownership last. SIGKILL or a failed final
upload can lose changes after the previous accepted generation. There is no
zero-loss or numerical RPO/RTO guarantee from small synthetic fixtures.

The recovery shutdown phase has a separate derived budget of twice
`FH_RECOVERY_OPERATION_TIMEOUT_SECONDS` plus 30 seconds. This allows an in-flight
capture to finish and then a final capture of the stopped writers. The default
host termination grace must cover 25 seconds for writers, two seconds for
killed-writer settling and 270 seconds for recovery: at least 297 seconds.
External deployments must supply a grace period covering the total budget. Increasing operation or writer
budgets requires increasing the host grace too. These bounds do not cancel
kernel-level hung filesystem I/O or guarantee a successful upload during an outage.

Snapshot subprocess deadlines do not guarantee cancellation of a kernel-level
hung filesystem operation on a network mount. Use external host deadlines and
health/routing controls; an unresponsive mount must never justify lock takeover
while the previous writer may still exist.

The fixed default engine limits are 10,000 files, 64 MiB per ordinary file,
256 MiB per database (including live main/WAL/SHM preflight), 1 GiB total member
bytes, 4 MiB manifest and configured 120-second whole-operation/SQLite budgets.
The operation uses monotonic deadline checks between steps, including restore,
but this is not cancellation of a kernel-level hung filesystem call.
Oversized SQLite members are rejected rather than becoming plain file copies. These are
acceptance caps, not promised capacity: captured buffers, databases, temporary
snapshots, downloads and application WAL growth consume additional memory/disk.
Use externally enforced filesystem quotas and headroom; a free-space check is
not a quota. A dense catalog can hit file-count limits before byte limits.
Recovery preserves ordinary file contents and owner executable bits, not full
ACLs/xattrs/group permissions or empty-directory metadata. Unsupported state
must be reviewed explicitly rather than advertised as a perfect home clone.

Restore validates identity, supported checkpoint format, member hashes, SQLite
integrity and path containment before admitting writers. Package versions remain
provenance in the descriptor, manifest and receipt, not an upgrade gate.
Native tools migrate their own schemas when they start; recovery does not
implement a dependency-version compatibility matrix. An empty replacement layout
restores members selected by the current configuration. A surviving receipt
matching the accepted generation permits missing selected members to be restored,
including SQLite databases, while preserving every surviving local file or
database, which may contain newer writes. Changing the image or retrying a failed
startup does not invalidate that receipt. Recovery does not rescan a receipted
home against backup size/count limits before starting native tools. Those limits
apply to capture and restored artifacts, not newer surviving local files. This is not permission to
adopt unreceipted local state, ignore orphan WAL/SHM files or overwrite existing
files. Unexpected loss of an initialized core or explicitly registered database
still blocks publication. Versioned Codex database filenames and newly discovered
databases may change as native tools migrate their state.
Unresolved authority fails closed. Corruption does not authorize automatic
rollback to an older generation.

Container recovery retains the existing native roots (`/home/fhold`,
`/stash`, `/work`, `/opt/akm/data`, `/etc/akm`). Explicit additional paths restore
to their original absolute container locations. Container `FH_HOME` does not
remap them; host CLI/Admin home selection remains separate. Symbolic links and
special files are refused rather than silently followed or copied.
Directory artifacts can live on qualifying local or network mounts, but no real
network-mounted filesystem was exercised in the current qualification.

## Which files are included?

The image owns an explicit, versioned catalog in
[`catalog.mjs`](../containers/assistant/recovery/catalog.mjs). It recursively captures
ordinary files and SQLite databases in these trees, plus individually selected
SQLite databases outside them:

| Tree | Included state |
| --- | --- |
| `/work` | Workspace files, Git metadata and other regular files. |
| `/stash` | Knowledge, task sources/results and private native provider files. |
| `/home/fhold/.config/opencode`, `.local/share/opencode`, `.local/state/opencode` | Native OpenCode configuration, sessions, account and supporting files. |
| `/home/fhold/.codex` | Codex configuration, account, sessions, approvals and databases. |
| `/home/fhold/.claude`, `.claude.json` | Claude configuration, account, sessions and consent. |
| `/opt/akm/data`, `/etc/akm` | AKM durable state, logs and configuration. |

Generated SDK dependencies, vendor plugin caches, transient coordination files
and the rebuilt AKM index are excluded. The catalog is **not the entire home**:
for example, `/home/fhold/.my-client` and `/home/fhold/.npm` are not selected.
Adding a file under `/work` or `/stash` needs no catalog change, subject to the
existing bounds, link rules and SQLite checks. Keep third-party credentials out
of searchable knowledge and ordinary shared workspaces.

### Additional files, directories and SQLite databases

Set `FH_RECOVERY_INCLUDE_FILE=/run/fhold/recovery-include.json` and supply that
file externally on every boot, including `init` and empty-container restoration.
For example, mount it read-only; it contains paths, not authentication keys:

```json
{
  "paths": [
    "/home/fhold/.my-client",
    "/extra/project-files",
    "/extra/settings.json"
  ],
  "sqlite": [
    "/extra/project-files/application.db",
    "/home/fhold/.my-client/state.sqlite"
  ]
}
```

- `paths` selects individual regular files or recursive directories, in addition
  to the native catalog. `sqlite` registers individual database files; those files
  need not also appear in `paths`. Either list may be omitted or empty. This
  unversioned format accepts only those two keys. There is no fixed entry-count limit; existing capture,
  manifest-size and deadline bounds still apply. The include file is at most 4 MiB.
- Entries are literal, canonical absolute **container** paths. Spaces and Unicode
  are supported; globs, tilde/environment expansion, trailing slashes, dot segments,
  relative paths, links and special files are not. Repeated/overlapping entries
  capture each physical file once. Missing paths/databases may initialize later;
  unexpected loss of a captured explicitly registered database blocks publication.
- Each SQLite file uses the same bounded native `VACUUM INTO` snapshot
  and integrity validation as the built-in databases. Committed WAL changes are
  included, but live `-wal`/`-shm` files are never ordinary backup members. Additional
  SQLite is identified by its file header in selected directories, regardless of
  extension; it does not need a separate `sqlite` entry. The explicit list selects
  individual databases outside those directories. Databases must remain on local storage.
  Each database is consistent individually, not one transaction across all apps.
- Operator-selected paths can opt into a normally omitted cache, but cannot select
  recovery staging/receipts, runtime coordination, its storage credentials, its own
  include file, the backup destination, `/proc`, `/sys`, `/dev` or the filesystem root.
  A deliberately selected parent such as the native home still excludes private
  engine/runtime state. Do not put the include file in a captured tree; a read-only
  external mount or excluded private recovery directory is appropriate.
  Native Codex `tmp`, `.tmp`, `locks`, `thread-writer-locks` and its live control
  socket, plus AKM process locks, remain excluded even when a parent is selected.
  These are process coordination, not plugin/account data. Ordinary native control
  metadata and operator-selected plugin caches remain recoverable; arbitrary links
  elsewhere are still refused, never dereferenced as a shortcut.
- Custom catalogs record the normalized lists in the immutable manifest and bind
  their hash into the descriptor/receipt. Restore never adopts paths from a backup
  that the current operator configuration does not cover. The external tooling
  must preserve this configuration across replacements; it is not itself restored.
- Apply selection changes on the next restart. Restore uses the current selection
  and leaves newly excluded, unselected or independent paths untouched. The next
  accepted checkpoint records the new selection; older immutable checkpoints
  remain intact. Adding or removing entries does not require a new destination,
  identity or receipt. Reordering/duplicates do not change the normalized selection.
  Never reinitialize an existing namespace.

Files restore to their original locations without overwriting pre-existing files.
The image's non-root user must be able to create/write the chosen locations and
parent directories. A backup of a read-only mounted source needs a writable empty
target on replacement; this does not add mount provisioning or mount remapping.
This selection works identically for directory and Blob destinations, with no
Azure-specific settings in the snapshot algorithm or CLI/Admin.

Do not use path selection to emulate an unavailable OS credential store: a
client whose tokens live in a desktop keyring still needs a headless storage
backend. Runtime backups may now include third-party private state: protect the
destination and avoid selecting credential folders into searchable knowledge.

Local CLI/Admin **portable backup** is a different archive: it selects knowledge,
workspace and a small operator-configuration allowlist, with explicit sensitive
data opt-ins. It does not back up the native runtime home. Use same-instance
recovery for ephemeral hosting, not a portable archive as full runtime recovery.

CLI/Admin also offer **entire-instance** export/import with containers stopped.
It includes all home-owned native state and recovery configuration/receipts, but
does not roll back an external checkpoint namespace, lease or independently
persistent mount. Import stays stopped and preserves the saved identity; review
the recovery destination and stopped-writer ownership before starting. This
manual directory snapshot is separate from automatic ephemeral checkpoints.

### Independently persistent mounts

Use the versioned form of the same externally supplied include file when some
content belongs to an independent drive/volume rather than recovery:

```json
{
  "version": 1,
  "paths": ["/home/fhold/.my-client"],
  "sqlite": ["/home/fhold/.my-client/state.sqlite"],
  "excludePaths": ["/work/scratch"],
  "externalMounts": ["/work/shared-drive"],
  "autoExcludeNetworkMounts": false,
  "recoverMounts": []
}
```

Lists default empty; discovery defaults off. This policy works with ordinary
Docker binds, named volumes and independently provisioned mounts on other hosts.
There are no hosting selectors or mount-provisioning tools in fhold.

- `excludePaths`: canonical absolute directory roots skipped even when absent
  or not mounted. Recovery never traverses/restores them. Existing linked paths
  and non-directories fail; redundant nested entries normalize away.
- `externalMounts`: exact required visible, readable **directory mount roots**,
  also excluded recursively. An ordinary directory is not a substitute. Missing
  mounts block initialization/startup/capture/restore without creating fallback
  directories. Roots outside the selected catalog work too. External tooling
  owns backing-volume identity and expected read/write permissions.
- `autoExcludeNetworkMounts`: opt-in discovery of visible `cifs`, `smb3`, `nfs`
  and `nfs4` mounts intersecting selected content, including nested, ancestor and
  file mounts. It never excludes `/` or guesses persistence for local volumes,
  tmpfs or unknown FUSE. Declare known required mounts explicitly: discovery
  cannot detect a mount absent on the first boot.
- `recoverMounts`: exact visible mount roots retained despite network discovery.
  These must exist, do not select otherwise unselected files, cannot override
  explicit exclusions, and do not opt in separately mounted descendants.
  Captured read-only files still require a writable empty restore target.
  This exception never permits network SQLite.

Ordinary local Compose home/data/workspace volumes retain their coverage. There
is no “ignore all mounts” switch. External read-only roots are never chmodded or
written; newer independent content survives cold restore and does not count as
unreceipted local runtime state.

Built-in and explicitly registered SQLite **and WAL/SHM paths** cannot be
excluded, even before a database exists. Recognized network placement fails even
with discovery off or a mount opt-in. Newly discovered SQLite in retained trees
also uses native snapshots and must remain local. Excluded content is not inspected/certified: relocate any
database an application opens there to local storage. See SQLite's
[network-filesystem guidance](https://sqlite.org/useovernet.html).

Linux `/proc/self/mountinfo` is read in this container's namespace. Parent
relationships resolve stacked/hidden and same-device binds; sources/credentials
are not stored or logged. See the [Linux mountinfo contract](https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html).
Mount IDs detect changes within this process, never durable identity across boots.
Topology is rechecked before accepted publication, SQLite snapshots and each
native restore write. Changes abort; partial restore journals remain and writers
are not admitted. This cannot protect against a privileged host racing remounts
between checks. Keep mounts stable; hung I/O needs external termination bounds.

Run the image's **private, read-only** `fhold-recovery inspect` with the same
configuration/mounts to see selected trees/databases, exclusions and required
mount read-only state. It never creates a namespace or claims ownership. Its
path-bearing output is for operators, not public health. `status` remains compact.

Versioned policies use catalog 3: normalized policy and effective automatic
exclusions are hash-bound to the immutable manifest and descriptor/receipt.
Catalogs 1/2 and legacy include files remain readable with original coverage;
old images reject catalog 3 rather than ignoring exclusions. Historical manifests
retain their recorded selection and hashes. Restore applies the current policy,
including current network-mount discovery, without overwriting newly excluded
or independently owned paths. Required mounts must still exist. These coverage
edits keep the same instance identity and checkpoint destination.

### Change an established recovery ownership policy

Coverage can change on restart without a policy-migration engine or new
checkpoint namespace. For an existing recovered directory moving onto an
independent drive, the external operator handles the data move:

1. Stop and externally confirm all old writers/publishers and descendants have
   stopped. Retain the checkpoint, original disk, private receipts and logs.
2. If necessary, restore/validate offline with the **original policy** into empty
   local native paths. Override the normal entrypoint
   and run `fhold-recovery restore --confirm-stopped` with the old destination,
   identity and mounts. It releases ownership after validation, without seeding
   defaults or starting writers. Valid surviving local state is preserved.
3. Transfer the relevant content offline to the independently provisioned drive;
   verify it and mount its exact declared root. External tooling owns this move.
4. Supply the new policy with the **same destination, instance ID and private
   recovery state**. Never edit receipts or historical manifests. The new policy
   keeps the independent drive out of restore and future capture.
5. Start normally; do not initialize again. Verify the independent content and
   an accepted checkpoint before retiring any old copies. Historical checkpoints
   retain their original members, even when the new selection omits them.

`--confirm-stopped` is an operator assertion, not proof that another writer is
dead. Selecting or excluding a path is not a data-copy operation; recovery never
migrates files onto an independent drive or provisions the mount.

## Qualification limits

### Reproduce local qualification

Use a checkout with installed Bun dependencies and an explicitly selected local
candidate Assistant image. Image tests require a usable Docker daemon; they never
use real provider/vendor accounts or an existing home.

```sh
bun run test:recovery
FH_RECOVERY_TEST_IMAGE=YOUR_EXACT_LOCAL_CANDIDATE_IMAGE bun run smoke:recovery
FH_RECOVERY_TEST_IMAGE=YOUR_EXACT_LOCAL_CANDIDATE_IMAGE bun run smoke:recovery:blob
# Exercise a published-image upgrade with empty storage, then a surviving home:
FH_RECOVERY_TEST_IMAGE=YOUR_EXACT_LOCAL_CANDIDATE_IMAGE FH_RECOVERY_UPGRADE_FROM_IMAGE=YOUR_PUBLISHED_SOURCE_IMAGE bun run smoke:recovery
FH_RECOVERY_TEST_IMAGE=YOUR_EXACT_LOCAL_CANDIDATE_IMAGE FH_RECOVERY_UPGRADE_FROM_IMAGE=YOUR_PUBLISHED_SOURCE_IMAGE FH_RECOVERY_TEST_SURVIVING_HOME=1 bun run smoke:recovery
```

`FH_RECOVERY_TEST_IMAGE` is required for both image commands; choose the exact
built digest/ID, not an assumed latest image. Blob smoke creates a disposable
Docker network, private fixtures and local Azurite 3.37.0 container; it does not
contact Azure. It uses emulator-only `--skipApiVersionCheck` because shipped
SDK 12.34.0 requests REST 2026-10-06, newer than that emulator's accepted versions.
Do not apply that workaround to a cloud endpoint or interpret it as cloud API
compatibility qualification.

Run the smokes as a non-root Linux user with Docker access. Their containers use
that user's numeric UID/GID, matching private bind-mount ownership without
weakening permissions or modifying the candidate image.

Smoke scripts retain private `/tmp/fhold-recovery-smoke-*` and
`/tmp/fhold-blob-smoke-*` fixtures/reports, including synthetic account/trust
state and runtime env. They clean only their own tracked test containers/network;
never use broad Docker pruning or wildcard directory deletion. Keep retained
fixtures private and out of searchable knowledge/commits. Review each report's
exact fixture path and confirm it is generated by that run before requesting
path-specific cleanup approval; use trash when practical. Failed-run state is
diagnostic evidence, not permission to erase backups or a live installation.

### Evidence scope

Local synthetic acceptance proves only exercised cases. Synthetic credential and
trust files establish file preservation, not token refresh, native-client account
readiness or sandbox support. Keep account and hosting qualification separate.
No real network-mounted filesystem or numerical RPO/RTO is qualified by these tests.

The reusable focused recovery suite covers explicit custom file/directory/database
lists, coverage edits, discovered SQLite, WAL/concurrent captures, empty-layout restoration,
workspace/Git/modes/deletions, all registered Codex databases, initialized-presence
enforcement, corruption/deadline/ownership refusal, safe errors and accepted
publication clocks, upgrades with changed dependency versions, surviving receipts
and backup warnings without stopping the agent. Entrypoint tests cover scheduler independence and separate
writer/final-checkpoint budgets. Exact-image directory and Blob-emulator smokes
exercise native session/shell/file APIs, restored state and all three offline
AKM harnesses without copying host accounts or repairing image behavior. Upgrade
smokes replace a published image in cold-storage and surviving-home modes, then
restore a checkpoint produced by the replacement image on its next restart.

See [Linux product qualification](operations/alpha-qualification.md) for exact
candidate evidence and remaining product gates. Host-specific deployment,
optional third-party setup and hosting qualification remain external operator
responsibilities, not additional fhold runtime features.

See the [runtime plan](technical/ephemeral-assistant-plan.md) and
[implementation review](technical/ephemeral-assistant-implementation-review.md)
for the general responsibility boundary and current code map.
