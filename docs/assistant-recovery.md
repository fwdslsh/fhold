# Assistant recovery

Recovery is an opt-in, same-instance runtime feature. It is separate from
portable backup/import and offline native-history transfer: recovery artifacts
can contain private provider credentials, conversations, workspace trust and
native approvals. Keep the destination private and protect it independently.
The private runtime format is not a portable user archive and adds no custom
per-object encryption. Use encrypted storage and narrow access externally;
hashes detect corruption, not malicious replacement by an authorized writer.

## Runtime configuration

These are standalone Assistant inputs, not cloud-management settings in CLI/Admin.

| Input | Default / purpose |
| --- | --- |
| `FH_RECOVERY_URL` | Unset keeps ordinary disk persistence; `file:///absolute/path` or `azblob://account/container[/prefix]` enables strict recovery. |
| `FH_INSTANCE_ID` | Required with recovery; stable lowercase slug, not a replica/revision name. |
| `FH_SCHEDULER_ENABLED` | `1`; set `0` to disable user scheduling only. |
| `FH_RECOVERY_INTERVAL_SECONDS` | `60`; capture cadence, 1–86,400 seconds. |
| `FH_RECOVERY_MAX_UNSAVED_SECONDS` | `300`; fail closed on unsaved age, at least the capture interval. |
| `FH_RECOVERY_OPERATION_TIMEOUT_SECONDS` | `120`; monotonic between-step/SQLite budget, 1–3,600 seconds. |
| `FH_RECOVERY_PROBE_PORT` | `0` (off); private health-only probe, not the native API port. |
| `FH_RECOVERY_STATE_DIR` | `/home/fhold/.fhold-recovery`; private staging/receipt, no arbitrary native-tree overlap. |
| `FH_RECOVERY_INCLUDE_FILE` | Unset keeps the native catalog; absolute JSON file listing additional container `paths` and `sqlite` databases. |
| `FH_RUNTIME_DIR` | `/tmp/fhold-runtime`; ephemeral private process/status files. |
| `FH_RECOVERY_CREDENTIAL_FILE` | Unset uses explicit managed identity; otherwise absolute private standard Blob connection-string file. |
| `AZURE_CLIENT_ID` | Unset uses system managed identity; UUID selects a user-assigned identity. |
| `FH_RECOVERY_ALLOW_INSECURE` | Off; exact `1` enables HTTP only for allowed emulator hosts. |
| `FH_RESTORE_TIMEOUT_SECONDS` | `300`; entrypoint wait for validated restoration before native startup. |
| `FH_SHUTDOWN_SECONDS` | `25`; writer-stop grace, not the final backup deadline. |

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
  --mount type=bind,src=/absolute/private-backups,dst=/recovery \
  --env FH_RECOVERY_URL=file:///recovery \
  --env FH_INSTANCE_ID=my-agent \
  YOUR_DIGEST_PINNED_ASSISTANT_IMAGE init --confirm-new-instance
```

The mount must be writable by the image's non-root user. Configure ordinary
startup with the same destination and instance identity, separate writable local
native state, and native password secret. Perform native provider/vendor sign-in
through the image's existing private exec/setup flow after restoration; no Azure
management CLI or copied host login is involved.

Only one owner may serve an instance. Directory ownership does not expire
automatically. After a crash, an external operator must confirm the old writer
and its descendants have stopped before explicitly transferring ownership.
A timeout or replica count of one is not proof that the old writer is stopped.
Never manually remove a lock while an old writer may still run.

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
route it publicly. Recovery environment must be removed from native worker/tool
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
intervals must be recorded. Readiness depends on restoration, ownership and
durability status, not a recovery worker PID alone. Accepted-checkpoint age is
owned by the engine after conditional publication and its private receipt write;
the supervisor uses that same monotonic clock. A later staging-cleanup error must
not make an accepted, receipted checkpoint disappear from health bookkeeping.
An older restored checkpoint alone does not count as a fresh boot publication.

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
Oversized/unknown native
SQLite members fail closed rather than becoming plain file copies. These are
acceptance caps, not promised capacity: captured buffers, databases, temporary
snapshots, downloads and application WAL growth consume additional memory/disk.
Use externally enforced filesystem quotas and headroom; a free-space check is
not a quota. A dense catalog can hit file-count limits before byte limits.
Recovery preserves ordinary file contents and owner executable bits, not full
ACLs/xattrs/group permissions or empty-directory metadata. Unsupported state
must be reviewed explicitly rather than advertised as a perfect home clone.

Restore validates identity, versions, member hashes, SQLite integrity and path
containment before admitting writers. An empty replacement layout restores
manifest membership, including deletions. Surviving local state must not be
silently overwritten by an older remote point; unresolved authority fails
closed. Corruption does not authorize automatic rollback to an older generation.

Container recovery retains the existing native roots (`/home/fhold`,
`/stash`, `/work`, `/opt/akm/data`, `/etc/akm`). Explicit additional paths restore
to their original absolute container locations. Container `FH_HOME` does not
remap them; host CLI/Admin home selection remains separate. Symbolic links and
unregistered SQLite state are refused rather than silently followed or copied.
Directory artifacts can live on qualifying local or network mounts, but no real
network-mounted filesystem was exercised in the current qualification.

## Which files are included?

The image owns an explicit, versioned catalog in
[`catalog.mjs`](../containers/assistant/recovery/catalog.mjs). It recursively captures
ordinary files in these trees, plus the individually registered SQLite databases:

| Tree | Included state |
| --- | --- |
| `/work` | Workspace files, Git metadata and other regular files. |
| `/stash` | Knowledge, task sources/results and private native provider files. |
| `/home/fhold/.config/opencode`, `.local/share/opencode`, `.local/state/opencode` | Native OpenCode configuration, sessions, account and supporting files. |
| `/home/fhold/.codex` | Codex configuration, account, sessions, approvals and registered databases. |
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
  need not also appear in `paths`. Either list may be omitted or empty. No other
  keys are supported. There is no fixed entry-count limit; existing capture,
  manifest-size and deadline bounds still apply. The include file is at most 4 MiB.
- Entries are literal, canonical absolute **container** paths. Spaces and Unicode
  are supported; globs, tilde/environment expansion, trailing slashes, dot segments,
  relative paths, links and special files are not. Repeated/overlapping entries
  capture each physical file once. Missing paths/databases may initialize later;
  once a database is captured, its unexpected disappearance blocks publication.
- Each registered SQLite file uses the same bounded native `VACUUM INTO` snapshot
  and integrity validation as the built-in databases. Committed WAL changes are
  included, but live `-wal`/`-shm` files are never ordinary backup members. Additional
  SQLite found in an ordinary directory must also be listed in `sqlite`, even if
  its filename has no database extension. Databases must remain on local storage.
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
- To add entries, stop/restart with the expanded file. Existing default checkpoints
  and previously selected files/databases are retained; the first new accepted
  checkpoint records the expanded selection. Reordering/duplicates do not change
  its identity. Restore from an older point supports the additional missing paths.
  Removing/narrowing an accepted selection is refused before claiming or writing
  targets; keep the old entries or deliberately use a new recovery namespace.
  Before the first checkpoint of a newly initialized custom namespace, use the
  same selection used for `init`. Never reinitialize an existing namespace.

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

## Qualification limits

### Reproduce local qualification

Use a checkout with installed Bun dependencies and an explicitly selected local
candidate Assistant image. Image tests require a usable Docker daemon; they never
use real provider/vendor accounts or an existing home.

```sh
bun run test:recovery
FH_RECOVERY_TEST_IMAGE=YOUR_EXACT_LOCAL_CANDIDATE_IMAGE bun run smoke:recovery
FH_RECOVERY_TEST_IMAGE=YOUR_EXACT_LOCAL_CANDIDATE_IMAGE bun run smoke:recovery:blob
```

`FH_RECOVERY_TEST_IMAGE` is required for both image commands; choose the exact
built digest/ID, not an assumed latest image. Blob smoke creates a disposable
Docker network, private fixtures and local Azurite 3.37.0 container; it does not
contact Azure. It uses emulator-only `--skipApiVersionCheck` because shipped
SDK 12.34.0 requests REST 2026-10-06, newer than that emulator's accepted versions.
Do not apply that workaround to a cloud endpoint or interpret it as cloud API
compatibility qualification.

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
lists, additive catalogs, WAL/concurrent captures, empty-layout restoration,
workspace/Git/modes/deletions, all registered Codex databases, initialized-presence
enforcement, corruption/deadline/ownership refusal, safe errors and accepted
publication clocks. Entrypoint tests cover scheduler independence and separate
writer/final-checkpoint budgets. Exact-image directory and Blob-emulator smokes
exercise native session/shell/file APIs, restored state and all three offline
AKM harnesses without copying host accounts or repairing image behavior.

See [Linux product qualification](operations/alpha-qualification.md) for exact
candidate evidence and remaining product gates. Host-specific deployment,
optional third-party setup and hosting qualification remain external operator
responsibilities, not additional fhold runtime features.

See the [runtime plan](technical/ephemeral-assistant-plan.md) and
[implementation review](technical/ephemeral-assistant-implementation-review.md)
for the general responsibility boundary and current code map.
