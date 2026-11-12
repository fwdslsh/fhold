# AKM 0.10.261119 integration

Reviewed November 11, 2026. This focused dependency change builds on Assistant
0.4.1107-beta and prepares the next fhold beta.

| Dependency | Released baseline | Selected candidate |
| --- | --- | --- |
| AKM CLI / web | 0.10.261118 | 0.10.261119 |
| OpenCode AKM plugin | 0.10.261120 | 0.10.261121 |
| Claude / Codex marketplace | 0.10.261120 | 0.10.261121 |

These are the actual npm `latest` publications. The earlier development draft
used CLI/web 0.10.261119-beta.1 while waiting for plugins. The stable core keeps
the same CLI integration, with a web chart-tooltip correction and release/docs
updates. All selected plugins and web require CLI 0.10.261119 exactly.
[Plugin PR #176](https://github.com/itlackey/akm-plugins/pull/176)
adds include selectors; [PR #178](https://github.com/itlackey/akm-plugins/pull/178)
moves plugin calls to native replacement commands and handles deprecation-prefixed
error JSON. Both are included in the published 0.10.261121 plugins. No dependency
override or vendor patch is needed; retain the upstream bundled CLI and lockfile.

The native marketplace release resolves to immutable commit
`dee32179a954aac2db657b0df5dcb95d6536d5f8`; its codeload archive SHA256 is
`b74d84a3d5c97ce0d78f053f78b2a21c4d50ff586fc98e1b7d2de98b50725eda`.
Both harness manifests report 0.10.261121 and the bundled CLI reports 0.10.261119.
The Dockerfile URL, checksum and all extraction prefixes move together.

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
workspace API integration is needed. The plugin's include selectors and
project defaults remain native-owned; no fhold retrieval-policy layer is added.

Optional vector-cache fingerprinting uses the fixed native config root when no
file override is set, asking native `akm config path` once per attempt for an
explicit override. Native relative/empty `AKM_CONFIG_FILE` handling stays upstream;
path-resolution usage records remain in disposable cache staging. Later policy
checks re-read the same file without repeated CLI launches. Config and
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

Development and candidate verification are recorded on [PR #120](https://github.com/fwdslsh/fhold/pull/120). Required affected checks
include native task import with stale activation/no-overwrite/invalid source,
alternate config selection and optional vector restore, read-only durable-byte
preservation, existing recovery regressions, typechecks, lint and CLI/Admin builds.
Verify actual native OpenCode/Claude/Codex
recall and embedded web authentication/navigation in the production image.
Canonical candidate CI qualifies the final stamped SHA and retains its artifacts
for publication without rebuilding them.

The initial beta integration's local development checks passed: all six typechecks, configured lint (321 existing
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

Draft CI exposed unnecessary repeated config-path subprocesses exhausting the
five-second optional-cache deadline in two native credential cases. Resolve the
override once, retain fresh file-content checks, and avoid an extra CLI process
for the fixed default location. Keep the production deadline unchanged. With the
published dependency pair, all five alternate-config/native-credential tests pass
under a single-CPU constraint; credential cases complete in about 2.2 seconds
including their setup, checkpoint and restore. This is local regression evidence,
not a claim about production backup latency or final native image qualification.

OpenCode and unrelated dependencies are unchanged. Existing audit exceptions
are neither widened nor used to override incompatible dependencies. No running
instance, native consent, recovery setting or backup is changed.
