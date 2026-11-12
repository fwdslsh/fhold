# AKM 0.10.261119 beta integration

Reviewed November 11, 2026. This focused dependency change builds on Assistant
0.4.1107-beta; no release version is reserved or stamped.

| Dependency | Released baseline | Selected candidate |
| --- | --- | --- |
| AKM CLI / web | 0.10.261118 | 0.10.261119-beta.1 |
| OpenCode AKM plugin | 0.10.261120 | Waiting for matching publication |
| Claude / Codex marketplace | 0.10.261120 | Waiting for matching publication |

CLI and web are available on npm. [Plugin PR #176](https://github.com/itlackey/akm-plugins/pull/176)
adds include selectors; [PR #178](https://github.com/itlackey/akm-plugins/pull/178)
moves plugin calls to native replacement commands and handles deprecation-prefixed
error JSON. Neither changes the old exact CLI pin yet. Keep this integration draft
until the published OpenCode package and immutable native marketplace pin the
selected CLI. Update both OpenCode workspace pins, marketplace commit/checksum
and extraction prefixes together; regenerate the root lockfile. Do not override
the plugins' dependencies, vendor patches, or pin unpublished versions.

## Native ownership and simplification

The [AKM beta](https://github.com/itlackey/akm/releases/tag/v0.10.261119-beta.1)
provides native task import and unified execution. Adoption delegates to
`akm import --type task`, without `--force`. Remove fhold's custom YAML target
restriction and copy/disable/explain/reconcile sequence. Native parsing,
no-overwrite handling and disable-before-publication under the scheduler lock
own that work. Fhold retains only staged-file selection and the operator's
review-before-enable workflow. Ordinary task execution uses `akm run`; task
creation retains native `task add` until an equivalent native authoring command
exists, using its current `--timeout` flag rather than generating YAML ourselves.

The published web package includes library maps, activity replay and workflow
traces. Continue embedding upstream web; no duplicate fhold views or new
workspace API integration is needed. The pending plugin's include selectors and
project defaults remain native-owned; no fhold retrieval-policy layer is added.

Optional vector-cache fingerprinting asks native `akm config path` for the
selected file. Native relative/empty `AKM_CONFIG_FILE` handling stays upstream;
path-resolution usage records remain in disposable cache staging. Config and
credentials are read in place, with credentials remaining under AKM_CONFIG_DIR.
Existing unsupported-source checks and optional cache failure isolation remain.

## Read-only diagnostics hold

The beta records local CLI invocation usage in metrics.db, including otherwise
passive commands. Explicit health `--read-only` suppresses this. Fhold uses
`akm doctor --read-only --no-probe` and the existing native standalone
`akm-migrate status`, which does not start CLI usage capture. The image exposes
that upstream executable through its ordinary binary link.

`akm task doctor` has no read-only flag. Do not invoke it from passive fhold
diagnostics or add a temporary config, vendor patch, usage override, or sandbox
wrapper to hide its writes. Task-binding checks report `NOT CHECKED` with an
explicit native action until upstream supplies a read-only interface. Native
health still reports state integrity and task-history checks. Operators can use
all native task commands normally; their usage preference is unchanged.

The existing recovery engine already identifies newly introduced SQLite files
by content and snapshots them natively, so metrics.db needs no special catalog
entry or raw-file-copy exception. SQLite remains local and complete checkpoints
are copied to the configured destination. Redaction default initialization also
remains: this beta does not replace its missing-key preservation contract.

## Verification

Development verification is recorded on the draft PR. Required affected checks
include native task import with stale activation/no-overwrite/invalid source,
alternate config selection and optional vector restore, read-only durable-byte
preservation, existing recovery regressions, typechecks, lint and CLI/Admin builds.
After the matching plugins publish, verify actual native OpenCode/Claude/Codex
recall and embedded web authentication/navigation in the production image.
Mixed CLI/plugin pins are preparation only, not a qualified release candidate.

Local development checks passed: all six typechecks, configured lint (321 existing
warnings), CLI build, Admin bundle, frozen-lockfile install and documentation link
tests. The full suite passed 1,299 tests with 10 opt-in skips and zero failures.
Native import tests cover preserved source, invalid definitions, no overwrite,
stale enabled refs, paused shell-task adoption and explicit manual execution.
Actual published doctor/migration entrypoints preserve config, knowledge and
database bytes with usage capture enabled; only ordinary SQLite shared memory
and empty WAL coordination files are excluded from the durable comparison.
Native optional vector tests exercise absolute, relative and empty config-file
selection through checkpoint capture and restored-index admission. Reviewed audit
passes with the same three approved exceptions and no additional findings.

OpenCode and unrelated dependencies are unchanged. Existing audit exceptions
are neither widened nor used to override incompatible dependencies. No running
instance, native consent, recovery setting or backup is changed.
