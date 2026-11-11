# Checkpoint packages: implementation brief

The desired model is one Assistant backup representation: a validated checkpoint.
An export packages that checkpoint; an import restores a reviewed package. A
persistent disk and a replaceable container should not need different backup
settings or competing Assistant capture implementations.

This is the next backend simplification, not a feature shipped by the Admin
layout change. The current manual export actions remain accurately scoped and
working. Nothing automatically converts existing archives, adopts a destination,
copies recovery authority or changes a running instance.

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

Extract the existing closure-private `manifestAt`, `validateManifest` and
`savedCatalog` validation into a reusable read-only path. It must retain bounded
reads, catalog/path checks, selection identity, member uniqueness and hashes;
SQLite validation stays in the image's native SQLite worker. Do not call
`acquireRestore` merely to preview or export: it claims destination ownership and
may write a receipt or restore files.

## Smallest migration-free delivery

1. Package an existing accepted Assistant checkpoint. Read one descriptor, pin
   its generation, validate the referenced manifest and copy only its objects
   plus any included optional cache object to a new private destination. Verify
   the copied bytes and publish package completion last. A checkpoint published
   concurrently after that read does not alter this immutable generation. No
   source ownership claim or source rewrite is needed. Retention must not remove
   the pinned objects during export if garbage collection is added later.
2. Add a shared package preview used by CLI and Admin. Report capture time,
   Assistant identity, covered paths, omitted/external data, private sign-ins and
   approvals, active task intent and optional extra sections. Validate every
   selected member before target writes; keep incomplete imports blocked.
3. First support **restore the same Assistant** into empty native roots and a
   genuinely unused independent recovery destination. Import the validated
   immutable manifest/objects through the existing storage interface, then
   publish its accepted generation through a deliberate native import operation.
   Do not hand-edit JSON hashes or fabricate a private receipt. The native
   restore path creates the receipt/journal only after normal validation. The
   source identity is retained; no original writer may run concurrently.
4. Allow a manual Assistant backup to invoke the same engine's local capture
   pipeline even when repeating backups are off. It must not enable recurring
   backups, initialize or claim the configured remote destination merely to make
   an export. Reuse the capture code with a private package target and explicit
   operation lifecycle; do not implement SQLite capture again in host code.
5. Replace the ordinary Assistant export/import journey with **Export backup**
   and **Import backup**. Keep existing archive readers as explicit input support
   while users retain those backups. No automatic live-data migration is needed.

A single archive container can hold the existing manifest/object graph and a
small package inventory. The archive wrapper is transport packaging, not a new
Assistant snapshot format. A directory package is sufficient for the first
delivery; adding compression must preserve bounded extraction, link/path
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

## Code to retire after equivalent behavior is verified

- Replace `createBackup` and its independent file collection/capture in
  `packages/lib/src/control-plane/backup.ts` with checkpoint packaging for normal
  Assistant exports. Retain reviewed-content selection rules as an import-purpose
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
