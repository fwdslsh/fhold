# Portable backup and restore review

Reviewed 2026-10-01. This is a dated source review and focused disposable-fixture test run, not a live recovery certification. Follow the current linked implementation and persistence contract for changes since the review. No implementation, real homes, credentials, containers or existing backups were changed.

## TL;DR

Follow-up design review, 2026-10-04: keep portable backup and same-instance
[runtime recovery](../assistant-recovery.md#choose-the-right-operation) separate.
Their different credential/authority, task-review, path namespace and native
version guarantees are useful product boundaries, not duplicate functionality.
The current recovery mount policy belongs to the container catalog and is not
automatically mapped into portable host archives. Native history also retains
its explicit cross-installation authority handling. No generic archive abstraction
or format conversion is justified by this feature.

fhold's backup is a private **directory of portable user files**, with a required size/hash manifest. Restore accepts only its own supported format and a fresh, not-yet-completed target; it does not clone deployment settings, credentials, native conversations or runtime authority. Tasks are staged inactive. Conflicts fail closed, and partial apply is recorded rather than rolled back. This is useful for moving knowledge/workspace into a fresh instance, but is neither disaster-recovery coverage nor an engine-downgrade rollback point. Native history has a separate offline workflow.

The implementation largely follows the [persistence contract](core-principles.md#persistence-and-recovery). The most important operator cautions are that backups are not encrypted or secret-scanned, a live backup is not a whole-home consistent snapshot, and CLI apply revalidates the current plan rather than binding it to an earlier preview. Admin does enforce that binding.

## What actually travels

The writer's selection and limits are in [backup.ts](../../packages/lib/src/control-plane/backup.ts); destination selection is independently allowlisted in [restore.ts](../../packages/lib/src/control-plane/restore.ts).

| Content | Backup | Restore/result |
| --- | --- | --- |
| Knowledge, inbox, authored AKM assets and durable file-based task results | Default, except top-level `secrets`, `env`, `.git`, `.akm` | Same locations, except active task sources |
| `knowledge/tasks/` | Default | Supported YAML basenames go to `knowledge/imported-tasks/`, never active scheduling |
| Workspace regular files | Default, including dotfiles and `.git` regular files | Same relative paths |
| `config/assistant/persona.md`, `user-profile.md` | Default | Missing or pristine seeded files only; edited target files conflict |
| `config/assistant/opencode.json` | Only portable native preferences | Byte-preserved; no automatic filtering/rewrite of an otherwise nonportable configuration |
| Native provider `auth.json` and approved referenced key files | `--include-provider-auth` | Requires the same restore opt-in; unrelated files in `knowledge/secrets/` are not swept in |
| `knowledge/env/user.env` | `--include-user-env` | Explicit opt-in, private non-executable file |
| Discord/Slack `config/portal/<adapter>/credentials.json` | `--include-portal-maps` | Parsed and checked against target named identities |
| Guardian `oauth.json`, `oauth-identities.json` | `--include-oauth` | Parsed; identity-map usernames must exist in target |
| `system/`, other `config/`, `state/`, `data/`, dependency trees and link targets | Not copied | Fresh release/runtime settings; separate preservation required |

`node_modules` is pruned everywhere rather than copied incompletely. Nested symlinks and special files are skipped with warnings; symlinked selected roots can be rejected before destination creation. Empty directories, exact POSIX ownership/modes and link topology are not represented. Files retain only executable versus non-executable intent: private directories are `0700`, files `0600`, ordinary executable files `0700`.

The manifest contains the source stack intent as `stackConfig` and the schema number as `sourceConfigVersion`; **restore does not apply this intent**. Names, ports, timezone, automatic-memory settings, optional-worker consent, gateway enablement, credential policies, default portal selection and allowlists must be reviewed/configured on the new target. Metadata includes identity names, paths and source settings, so keep even a default backup private. Generated env, credential keys and delegated portal bundles are rebuilt by [ensureRuntime](../../packages/lib/src/control-plane/state.ts), not replayed from source.

## Provider and access portability

[provider-files.ts](../../packages/lib/src/control-plane/provider-files.ts) permits only `$schema`, `model`, `small_model` and `provider` top-level native settings. Any additional setting omits the entire native config, including otherwise useful model preferences; any nested provider `npm` SDK selector is also nonportable. Thus MCP/plugin/code activation is not transferred implicitly. Review omitted configuration separately from a private full-home preservation copy.

Recognized literal credential fields in provider values require provider-auth opt-in. Safe native file references must be exact `{file:/stash/secrets/<contained-relative-file>}` values; no traversal, symlink or external path is accepted. At most 128 referenced files are allowed, with 1 MiB bounded provider config/secret reads. Invalid references omit native config without opt-in and fail when opting in. Unused references from an omitted native configuration are not followed. Exact user `{env:VARIABLE}` references are allowed only outside reserved runtime/authority namespaces; restoring the declaration does not supply the variable. The separate user-env opt-in or new configuration/sign-in is still needed.

Literal detection is deliberately limited to recognized fields, not arbitrary secret discovery. Knowledge and workspace can contain `.env`, private Git content, tokens in notes or custom headers; default backup does not guarantee their absence. Opt-in data remains plain files: restrictive permissions are not encryption. Transfer/storage should be private and encrypted independently.

Portal maps preserve **assignments by username**, not keys or policies. Recreate each referenced named identity with a deliberately reviewed target policy first; a matching name alone does not prove equivalent permission. OAuth files are settings/maps, not a replay of Guardian handle authority. Assistant auth, Guardian keys, bot tokens, native worker host logins and old encrypted handles are not imported by these map options. Reconnect clients/portals and repeat real provider readiness after restore. [Managing fhold](../managing-fhold.md#access) documents named-identity setup.

## Integrity, planning and failures

Backup requires valid fhold stack intent and a new/empty destination outside the source, checks containment, regular-file type and private paths, then writes files atomically and writes `fhold-backup.json` last. Limits are 100,000 files, 256 MiB per ordinary file and 20 GiB total. The manifest records SHA-256 and byte count for each file, omissions and source preservation inventory. A failure after copying starts can leave an incomplete nonempty backup directory; it is not automatically erased or resumable by the backup command. Preserve/inspect it and select a new destination for retry.

Restore requires disjoint real source/target directories, format `product: "fhold"`, `version: 1`, `scope: "portable"`, and a manifest no larger than 16 MiB. It validates every manifest file (even a category not selected for restore), duplicate/unsafe paths, exact file sizes/hashes, aggregate total and bounded warnings/preservation metadata. Selected source files must appear in that verified manifest. Hashes detect corruption relative to the manifest, **not provenance**: there is no signature, and an attacker able to replace both files and manifest can reseal them. Use only trusted, privately retained backups.

The plan uses `copy`, `stage-task`, `skip-identical`, `replace-pristine` and `conflict`. Replacement is limited to exact current seed bytes, empty/`{}` provider auth and empty user env; an edited regular file or incompatible target object conflicts. There is no merge/force-overwrite switch. Missing files are copied and identical files skipped, enabling re-preview retries. `setup_incomplete` is required, not arbitrary restore into a running/completed installation.

Apply acquires the target lifecycle lock, recomputes the plan, rejects conflicts and requires `acknowledgeUnrestored` when review-required omissions exist. When an expected preview digest is supplied, changes to the plan reject apply. Admin requires it, invalidates previews when choices change and asks for explicit confirmation; CLI calls `applyRestore(options)` without an earlier digest, so its separate dry-run is advisory rather than a frozen approval. During apply each written source hash and target pre-write hash are rechecked, then the output hash is verified. The source is preserved.

Private `state/restore-receipts/<digest>.json` records phase and completed paths. On failure, earlier copies remain; the receipt reports `partial-failure`, and the operator must re-preview before retry. Runtime reconciliation also occurs inside this failure boundary. Receipt writes themselves can fail (for example a full disk); retention is not guaranteed under every filesystem failure. Per-file atomic writes are not an all-or-nothing transaction.

## Repeatable operator flow

Use exact private paths you control. These are templates, not commands executed by this review; select an unused destination/name and locally available trusted images as normal installation requires. Fresh setup chooses available ports unless you explicitly override them.

```bash
FH_HOME=/absolute/source-instance fhold backup --to /private/backup-2026-10-01
FH_HOME=/absolute/new-instance fhold install --no-start
FH_HOME=/absolute/new-instance fhold restore --from /private/backup-2026-10-01 --dry-run --json
```

Inspect the full plan, especially preservation, warnings and conflicts. Privately preserve omitted runtime/link/external sources before acknowledging them. Choose another fresh target or resolve only specifically reviewed target conflicts; do not delete the source or force an overwrite.

```bash
FH_HOME=/absolute/new-instance fhold restore --from /private/backup-2026-10-01 --apply --acknowledge-unrestored
FH_HOME=/absolute/new-instance fhold setup
FH_HOME=/absolute/new-instance fhold provider test
```

`--acknowledge-unrestored` is required only when the plan says review is required; it is not a history-recovery command. Add any sensitive flags deliberately **at both backup and restore**; restore cannot recover something absent from the backup. For portal/OAuth maps, recreate referenced identities before preview/apply. Do not place actual secrets on command lines.

After the Assistant is available, inspect individual staged task sources, then adopt and test reviewed prompt-only work:

```bash
FH_HOME=/absolute/new-instance fhold task adopt /absolute/new-instance/knowledge/imported-tasks/project-news.yaml
FH_HOME=/absolute/new-instance fhold task show project-news
FH_HOME=/absolute/new-instance fhold task run project-news
FH_HOME=/absolute/new-instance fhold task resume project-news
```

[Task CLI](../../packages/cli/src/commands/task.ts) confines adoption to directly staged files; the [Assistant helper](../../containers/assistant/fhold-task.mjs) validates AKM input, rejects command/workflow tasks, disables the ID before making the source visible, and installs paused. Manual execution itself can have effects: review before `run`, not just before `resume`.

Admin: choose/create the fresh instance, use System's portable-backup/restore controls, select the directory and optional data, Preview, inspect the visible preservation inventory, acknowledge separate recovery when required, then Apply. [Admin backup controller](../../packages/electron/admin/backup.js) ties apply to the preview. Its one map checkbox requests both portal and OAuth files; CLI offers independent flags. Native history is exposed separately through CLI, not this Admin panel.

## Native history is a separate acceptance step

[history.ts](../../packages/lib/src/control-plane/history.ts) and [history CLI](../../packages/cli/src/commands/history.ts) preserve native conversations with a distinct `native-history` archive. They use trusted installed images, non-root read-only/network-disabled workers, WAL-inclusive SQLite snapshots, stripped session authority, reviewed workspace directory mapping, collision checks, existing-target session preservation, verified content and private retry journals. Restore/preview requires the selected target stack stopped; preview writes private recovery evidence but does not import into its native database. Source export checks snapshot consistency; keep the source stopped as [operator documentation](../managing-fhold.md#native-history-and-updates) instructs.

```bash
FH_HOME=/absolute/source-instance fhold stop
fhold history export --from /absolute/source-instance --image <trusted-source-assistant-image> --to /private/native-history-archive
FH_HOME=/absolute/new-instance fhold stop
FH_HOME=/absolute/new-instance fhold history restore --from /private/native-history-archive --directory-map /private/reviewed-directory-map.json
FH_HOME=/absolute/new-instance fhold history restore --from /private/native-history-archive --directory-map /private/reviewed-directory-map.json --apply --same-instance
```

Use `--same-instance` only for a same-owner continuation, never an unrelated history merge. The JSON map must cover old contexts with `/work` or existing `/work/...` destinations; linked runtime storage needs explicit resolved `--runtime` selection on export. Keep archives outside both homes/searchable knowledge. Restart and verify session visibility/content in the intended native client. Native history alone still omits snapshots, external artifacts, dependencies and old portal handles; it is not full runtime rollback or proof that an older engine can read newer state.

## Evidence and grounded improvements

Executed in disposable synthetic fixtures:

```bash
bun test packages/lib/src/control-plane/backup.test.ts packages/lib/src/control-plane/restore.test.ts packages/lib/src/control-plane/history.test.ts
bun test packages/lib/src/control-plane/portable-reference-security.test.ts
```

Combined result: **52 passed, 2 skipped, 0 failed**, 339 assertions across two invocations. The skipped cases require a real Assistant image and cover native WAL/history recovery and linked runtime export. No Docker-backed history recovery, installed CLI flow, provider readiness or Electron journey was executed in this review. Existing [qualification](../operations/alpha-qualification.md) reports prior real-image/Admin checks; those are historical evidence, not new execution here. The [backup tests](../../packages/lib/src/control-plane/backup.test.ts), [restore tests](../../packages/lib/src/control-plane/restore.test.ts) and [independent reference-security tests](../../packages/lib/src/control-plane/portable-reference-security.test.ts) cover private opt-ins, integrity, reference containment, conflicts, omitted executable config, inactive task staging and source preservation. The latter also executes an injected second-file write failure, verifies a private partial receipt, rejects reuse of the old digest, and completes a freshly previewed retry while skipping the already copied identical file.

Prioritized improvements within the existing boundary:

1. **Make operator limitations explicit at the normal entry points.** Document that ordinary workspace/knowledge secrets are included, maps do not carry policy, sensitive backups are unencrypted, and live portable backup is not a consistent whole-home snapshot. The existing managing guide correctly separates history but its shortest apply example omits the frequently required omission acknowledgment. Clarify it conditionally, without encouraging blind acknowledgment.
2. **Align CLI preview assurance with Admin, or describe the difference precisely.** CLI has no input for the previously reviewed digest, although the shared library supports one. Current guide wording “verifies hashes/preview” can imply stronger CLI approval binding than implemented. Admin's digest path is already the correct reference behavior; no new recovery subsystem is needed.
3. **Reject duplicate mapped task destinations before apply.** Recursive task discovery flattens nested sources to `basename` under `imported-tasks`. Two distinct manifest entries with the same basename can both plan as writable to an absent destination; the second then fails after the first copy because apply's destination precondition no longer holds. Add direct duplicate-destination coverage rather than relying on partial-failure handling. This is a source-derived finding, not an executed collision reproduction.
4. **Extend existing fault tests to incomplete backup and reconciliation failures.** The independent reference-security suite already verifies injected per-file restore failure, completed-path receipts and fresh-preview retry. Complement that demonstrated behavior with failure after backup copying starts and failure in final runtime reconciliation; clarify retained output and retry expectations without adding a rollback claim.
5. **Keep bounded reads strict under concurrent mutation.** Generic `readRegularSource` checks size with `fstat` and then reads to EOF, unlike the stronger bounded provider read. A concurrently growing ordinary file can exceed the checked allocation before later totals reject it. Backup also runs without the target lifecycle lock or a whole-home snapshot. Document quiescence and consider bounded generic reads/relevant mutation tests; do not claim multi-file consistency from atomic destination writes.

The [preservation inventory](../../packages/lib/src/control-plane/preservation.ts) deliberately detects known runtime roots and links without recursively following them; it does not discover every external mount or repository. Its explicit excluded category is honest. Full recovery therefore remains an operator inventory plus private preservation exercise, not a property conferred by the portable manifest.
