# Ephemeral Assistant runtime and recovery plan

The same self-contained fhold Assistant runs on ordinary persistent disk or
ephemeral local storage. This document defines the general boundary; the
[operator recovery contract](../assistant-recovery.md) is authoritative for
inputs, catalog, initialization, ownership, limits and restore behavior.

## Ownership

- fhold owns startup/restore ordering, the generic recovery engine, directory and
  Azure Blob data-plane adapters, SQLite snapshots, native setup, health and
  graceful shutdown. Live SQLite remains local.
- External applications own deployment, image selection, mounts, identities,
  secrets, ingress, resource limits, wake/awake/scale, routing, retention and
  confirmed-stopped ownership recovery. None of those become CLI/Admin services.
- Native harnesses own plugin installation, accounts, trust, hook approval and
  client protocols. Installed/running is not evidence of account or tool readiness.

Host-specific examples and qualification are external operator responsibilities.
Adding a host does not change the runtime or add a platform mode, management SDK,
controller, plugin registry, startup installer or mandatory sidecar.

## Implemented runtime

1. Validate capability/deadline inputs, load the external recovery selection and
   verify the effective mount policy and required mounts before claiming ownership.
2. Acquire same-instance ownership and validate the accepted immutable manifest.
3. Restore empty local state before default seeding or any native writer starts;
   preserve validated surviving local state and refuse unresolved conflicts.
4. Start authenticated OpenCode and enabled native workers. User scheduling is
   independently controlled by `FH_SCHEDULER_ENABLED`; recovery does not use cron.
5. Capture each registered SQLite database consistently and ordinary selected
   files within fixed resource/deadline limits. Publish immutable content and
   conditionally accept a complete generation under ownership.
6. Admit requests only with ownership, restore and accepted-checkpoint health.
7. On TERM, stop writers/descendants, take a separately budgeted final checkpoint,
   and release ownership last. Forced termination can lose unpublished changes.

Directory storage requires coherent exclusive creation/atomic rename. Blob uses
leases plus persistent owner identity; lease expiry is not permission to take
over an old writer. Neither fencing nor snapshots provide exactly-once external
actions. Never initialize over an established missing/corrupt/incompatible head.

## Configuration and state

Retain the standard container roots and external include-file selection. Explicit
additional paths restore to their original locations; host `FH_HOME` does not
remap container paths. Additions are supported, but narrowing an accepted catalog
is refused. Native plugin caches/private state require deliberate coverage.

The external application separates recovery-owned ephemeral state, independently
persistent drives and external configuration/secrets. Declare required independent
roots with the [mount policy](../assistant-recovery.md#independently-persistent-mounts);
they are not traversed or restored. Ordinary local volumes retain their recovery
coverage. Pre-populated recovery-owned mounts without a valid receipt can block
restoration. SQLite cannot use a network mount. Arbitrary links, special files and
unregistered SQLite are not supported.

Portable user backup and offline native-history transfer remain different formats;
neither substitutes for sensitive same-instance runtime recovery.

## Remaining qualification

- Deployment-specific network filesystems, permission models and custom plugin/drive
  layouts. Local bind-mount smokes are not SMB/NFS qualification.
- Forced-stop/storage-outage recovery and readiness-aware external retry/admission.
- A deliberate compatibility workflow for native dependency/schema upgrades;
  current recovery requires exact recorded native versions.
- Representative capacity, operation duration, disk/memory headroom, loss windows
  and safe external retention. Per-database snapshots are not application-wide
  transactions or an SLA.
- Real native account refresh/reconnect and post-resume tool requests. Both remote
  integrations remain experimental until explicitly qualified for a future release.
- Future transports such as S3, only when implemented and independently tested.

See the [implementation map](ephemeral-assistant-implementation-review.md) and
[Linux product qualification](../operations/alpha-qualification.md). This runtime
contract does not qualify any particular host or external integration.
