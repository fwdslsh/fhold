# Assistant checkpoint packages

The desired model is one Assistant backup representation: a validated checkpoint.
An export packages that checkpoint; an import restores a reviewed package. A
persistent disk and a replaceable container should not need different backup
settings or competing Assistant capture implementations.

Directory packages, bounded preview and same-Assistant empty-home import are
implemented through `fhold recovery export`, `recovery preview` and `recovery
import`; `backup` and `restore` no longer accept checkpoint packages. With
automatic backups enabled, export packages the last accepted generation; with
backups off it captures once through the same native engine and a temporary
local destination. No recurring setting or configured source authority changes.

```sh
fhold --name original recovery export --to /private/assistant-backup
fhold recovery preview --from /private/assistant-backup
fhold recovery import --from /private/assistant-backup --home /absolute/empty-home \
  --backups /private/new-independent-backups --preview-digest <digest> --confirm-stopped
```

Use the matching release's Assistant image. Preview/import can use the CLI's
pinned image when the original home is gone; the image must already be available
locally. An existing selected instance supplies its exact resolved image instead.
Admin exposes **System → Backup and recovery → Export / import Assistant backup**.
Package and target paths in this form belong to the selected instance host,
including SSH. Local and SSH CLI use the same operations; with `--connection`,
paths likewise belong to the selected host.
ACA package transfer to a management-host folder is explicitly unavailable;
automatic mounted backups and startup restoration remain available.

An import requires an empty home and unused independent backup directory. Native
restore runs before host defaults are seeded, writes its own real receipt, and
leaves containers stopped. An interrupted import retains the existing startup
blocker; it is not silently resumed or overwritten. Review the partial target
and retry with another empty home. Original writers must remain stopped.

Existing archives remain readable. `backup` (optionally `--portable`) retains
reviewed-content export; `backup --full --confirm-stopped` retains whole-home
preservation. Admin keeps these under **Other export options**. No live migration or archive
conversion runs automatically.

## Reuse the existing implementation

`containers/assistant/recovery/engine.mjs` already owns inventory, SQLite-native
snapshots, staged local capture, hashes, immutable objects, accepted-generation
publication, restore staging, SQLite integrity checks and interrupted-restore
journals. `catalog.mjs` owns native roots, registered databases, exclusions,
custom selection and mount boundaries. `directory-store.mjs` and `blob-store.mjs`
already provide the same object/descriptor interface. Reuse these pieces rather
than creating another snapshot writer or putting a second recovery engine in
Admin or on the management host.

A checkpoint consists of its accepted manifest and content-addressed objects.
Members identify a catalog root and relative path, file/SQLite kind, byte count,
hash and mode. The manifest also records selection, native database presence and
optional AKM cache reference. The descriptor selects the accepted generation.
Temporary uploads, unrelated generations and unreferenced objects are not part
of the exported checkpoint.

The engine's `manifestFrom`, `validateManifest` and `savedCatalog` validation are
reused by the package operations. They retain bounded
reads, catalog/path checks, selection identity, member uniqueness and hashes;
SQLite validation stays in the image's native SQLite worker. Do not call
`acquireRestore` merely to preview or export: it claims destination ownership and
may write a receipt or restore files.

## Implementation map

1. Export reads an existing accepted Assistant checkpoint's descriptor and pins
   its generation, validates the referenced manifest and copies only its objects
   plus any included optional cache object to a new private destination. Verify
   the copied bytes and publish package completion last. A checkpoint published
   concurrently after that read does not alter this immutable generation. No
   source ownership claim or source rewrite is needed. Retention must not remove
   the pinned objects during export if garbage collection is added later.
2. Shared package preview used by CLI and Admin reports capture time,
   Assistant identity, selected coverage, member/byte counts and warnings about
   private sign-ins, approvals, active task intent and excluded host data. It
   validates every selected member before target writes; incomplete imports stay
   blocked. It does not inspect or disclose native credential values.
3. **Restore the same Assistant** imports into empty native roots and a
   genuinely unused independent recovery destination. Import the validated
   immutable manifest/objects through the existing storage interface, then
   publish its accepted generation through a deliberate native import operation.
   Do not hand-edit JSON hashes or fabricate a private receipt. The native
   restore path creates the receipt/journal only after normal validation. The
   source identity is retained; no original writer may run concurrently.
4. Manual Assistant backup invokes the same engine's local capture
   pipeline even when repeating backups are off. It must not enable recurring
   backups, initialize or claim the configured remote destination merely to make
   an export. Reuse the capture code with a private package target and explicit
   operation lifecycle; do not implement SQLite capture again in host code.
5. The ordinary Assistant backup journey uses checkpoint export/import. Existing
   archive readers remain explicit input support
   while users retain those backups. No automatic live-data migration is needed.

A directory package holds the existing manifest/object graph and a small
completion inventory. It is transport packaging, not a new Assistant snapshot
format. Adding compression must preserve bounded extraction, link/path
containment, empty-target and verified-manifest protections.

## Restore purpose and authority

The package is not an ownership token. Never export a live owner nonce/lease,
private local receipt or partial restore journal. A new destination gets new
ownership through normal native operations. Copying an archive does not clear
the original owner, prove stopped writers or authorize overwriting surviving
data. Preserve the original destination and original disk until verification.

**Create a different Assistant** is a separate restore purpose, not a separate
capture format. It needs a fresh identity and destination, reviewed credentials
and trust, workspace mappings and an explicit decision about task activation.
Do not obtain that behavior by rewriting an instance ID inside a native database
or checkpoint. Reuse native AKM/OpenCode export/import or scheduling features
where selective transfer is needed; investigate upstream gaps before writing
schema-specific filtering. Existing reviewed-content import remains available
until this purpose has equivalent verified behavior.

Directory destinations are canonical file URLs. Docker settings refer to host
paths mounted at `/recovery`; ACA settings refer to a persistent path already
mounted inside the selected container. Keep this placement in the host adapter,
not in a container-lifetime mode. Custom coverage includes absolute container
paths and hash-derived catalog roots; importing onto a different layout requires
an explicit reviewed mapping, not arbitrary manifest-provided filesystem roots.

## Optional whole-stack additions

An Assistant checkpoint does not contain host `state/stack.json`, generated
deployment files, image bytes, Guardian/Portal state or independent drives.
Package those as optional separately inventoried sections when whole-stack
preservation is requested. Host paths and generated home metadata must be
reconciled by the existing host installation operations. ACA has no host home
to archive, and an offline Job cannot restore another replica's writable layer.

Whole-instance export currently includes arbitrary home files, caches, symlinks,
credentials and active task intent and requires all writers stopped. Keep that
fallback with its actual guarantees until optional package sections cover those
needs. Do not silently call an Assistant-only package a full-instance export.
External mounts need their own explicit coverage and access review.

## Remaining consolidation

- Retire `createBackup` and its independent file collection/capture in
  `packages/lib/src/control-plane/backup.ts` with checkpoint packaging for normal
  reviewed-content exports once native selective import covers their actual
  semantics. Assistant exports (`recovery export`) already use the checkpoint engine.
  Retain reviewed-content selection rules as an import-purpose
  operation until native selective transfer covers them.
- Replace duplicate Assistant payload planning/copying in `restore.ts`
  (`planRestore`/`applyRestore`) with the engine's validated staging/restoration.
  Preserve preview digests, conflict checks, empty-target guarantees and explicit
  task/credential choices; those are real data-safety behavior.
- Reduce `instance-backup.ts` to optional host/whole-stack preservation and home
  reconciliation after the package covers its actual scope. Its raw full-home
  inventory is not a substitute for native live SQLite snapshots.
- Remove the Admin export-scope selector when package export plus explicit import
  purposes covers its uses. Keep one shared location/cadence/coverage form and
  capability-driven host placement. Do not add a parallel scheduler or service.

Required tests include a real committed-WAL checkpoint/package/empty-target
restore, interrupted/short copy and corrupt-object rejection, original-owner
isolation, custom paths, file URLs, unreviewed task/credential decisions,
stopped-writer full-stack sections and source/target preservation. Test the same
shared operations through local Docker, SSH and the supported ACA actions; do
not equate synthetic Admin IPC with live cloud qualification.
