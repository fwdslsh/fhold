# Ephemeral Assistant implementation map

The generic feature is implemented, not a proposed host-specific runtime.
See the [runtime plan](ephemeral-assistant-plan.md),
[operator contract](../assistant-recovery.md) and
[product qualification](../operations/alpha-qualification.md).
Host-specific feasibility and hosted acceptance are separate from reusable
product qualification and do not establish current account or service readiness.

## Code ownership

| Source | Responsibility |
| --- | --- |
| `containers/assistant/entrypoint.sh` | Validate capabilities, restore before seeding/writers, scheduling independence, native startup and separate writer/final-checkpoint shutdown budgets. |
| `containers/assistant/fhold-recovery.mjs` | Runtime configuration, init/inspect/offline-restore/status/unlock interfaces, worker timer, private HTTP probes and the engine's accepted-publication clock. |
| `containers/assistant/recovery/engine.mjs` | Bounded inventory/snapshots, integrity validation, immutable generations, receipt/journal authority, compatibility, ownership and conditional publication. |
| `containers/assistant/recovery/catalog.mjs` | Explicit native trees/databases, versioned custom selections, additive catalog validation and permanent transient/private exclusions. |
| `containers/assistant/recovery/selection.mjs` | Pure selection normalization/ownership policy shared by the image engine and host settings; no host authority or second backup writer. |
| `containers/assistant/recovery/mounts.mjs` | Linux mount visibility, required mounts, network exclusions, local SQLite placement and topology fencing. |
| `containers/assistant/recovery/sqlite-worker.mjs` | SQLite-native bounded snapshot and integrity subprocess operations. |
| `containers/assistant/recovery/directory-store.mjs` | Artifact filesystem safety, exclusive ownership, atomic writes and non-destructive namespace handling. |
| `containers/assistant/recovery/blob-store.mjs` | Azure Blob data plane only: explicit credentials/managed identity, bounded requests, immutable objects, descriptor conditions, leases and persistent owner identity. |
| `containers/assistant/recovery/storage.mjs` | Destination adapter selection; no cloud provisioning/control. |
| `containers/assistant/healthcheck.sh` | Runtime health plus scheduling checks only when scheduling is enabled. |
| `containers/assistant/Dockerfile` | Standard non-root image-baked tools, assets and helpers; no cloud management client or third-party-specific plugin. |
| `packages/lib/src/control-plane/recovery-config.ts`, `recovery.ts` | Optional managed intent, private credential file, coverage editing, audited mounts/shutdown budget and explicit native operator operations under the lifecycle lock. |
| `packages/cli/src/commands/recovery.ts`, `packages/electron/admin/recovery.js` | CLI/Admin over the same library: save-only settings, checkpoint status/inspection, and confirmed stopped initialization/restoration. Portable archives retain their separate scope. |

## Reusable verification retained in fhold

`scripts/recovery-engine.test.ts`, `recovery-acceptance.test.ts`,
`recovery-wrapper.test.ts`, `recovery-mounts.test.ts`, `blob-store.test.ts` and
`assistant-recovery-runtime.test.ts` cover generic contract/engine/entrypoint
behavior. `smoke-recovery.mjs` and `smoke-blob-recovery.mjs` exercise the actual
image against directory/Blob destinations, including optional explicitly scoped
real Blob data-plane fixtures. Native history, security, scheduling, provider,
AKM harness and product setup tests remain product tests.

No hosted deployment fixture or external-vendor installer belongs here. External
acceptance should use ordinary image/native APIs and a read-only standard-SDK
checkpoint observer, without importing internal fhold modules or implementing a
second recovery writer.

## Limits and unresolved work

One instance has one writer. Never auto-take-over an unreleased owner. Restore
refuses corrupt/incompatible heads and unresolved existing target data rather than
creating a blank agent. Exact native dependency versions are required; updates
need a deliberate compatibility procedure. Known initialized databases cannot
silently disappear. Extra SQLite is registered explicitly, never discovered and
copied as ordinary files.

Fixed limits and monotonic deadlines are acceptance bounds, not measured capacity.
SQLite consistency is per database; sequential files/databases are not one
transaction. Normal TERM allows a final checkpoint; forced termination/outages
can lose unpublished changes. Retention and independent protection against an
agent with same-UID access are external storage responsibilities.

Real network mounts, custom plugin/drive matrices, native-client account readiness,
upgrade transitions and representative RPO/RTO remain separate qualification
gates. Keep native approvals and real image behavior intact when testing.
