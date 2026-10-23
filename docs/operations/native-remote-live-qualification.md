# Native remote recovery and activity qualification

The startup activity correction for [#38](https://github.com/fwdslsh/fhold/issues/38)
shipped in [beta.12](https://github.com/fwdslsh/fhold/releases/tag/0.2.2610154-beta.12),
from commit `12ad7fde5c2eec5d72f2dc1107eee7dc6f8e3267`.
The signed-in native-client checks below remain unqualified as of October 21,
2026. Keep the issue open until the applicable cases pass with retained evidence.
An unsupported client/account combination is a blocker, not a successful test.

The automated harness smoke runs the actual image-baked CLIs with disposable
profiles and no vendor credentials. It verifies fresh/replacement empty Codex
inventory, a real loaded native thread refusing initial coverage, a missing
server refusing coverage, and real native hooks. Unit tests additionally reject
partial/malformed inventories and a worker replaced during inspection. These
checks do not prove vendor connectivity, a long model turn or cloud scale-to-zero.

## Prepare an isolated target

An operator needs a disposable instance, explicitly authorized disposable vendor
accounts, a supported Codex client and Claude Remote Control client, and time to
complete native pairing/consent. Do not borrow a management host's credentials or
use an existing personal instance. Obtain account access through normal guided
setup described in [native remote access](../native-remote-access.md).

Use the selected release's normal install and deployment path. Enable keepalive
to an operator-controlled HTTP(S) receiver before qualification, using the normal
configuration and a dedicated secret if required. Keep user schedules disabled
to make activity attribution clear. The receiver must record request timestamps,
not Authorization headers. Preserve the selected native sandbox and approval
policy; do not weaken them to make a test work. Unrelated workers may be explicitly
disabled before the test, but the worker under test must remain enabled.

Use the normal recovery lifecycle and a private, unique recovery destination
already initialized for this disposable target. Read [the recovery contract](../assistant-recovery.md).
Confirm checkpoint publication and recovery ownership release before starting a
replacement. Never run both copies, force takeover or delete ownership records.
This protocol does not authorize altering an existing deployment's recovery
settings or restoring live user data.

Record release, immutable image digest/revision, CLI versions, client versions,
hosting type, intended hostname, approval/sandbox policy and test start time.
Keep account identity privately; public evidence should say whether the intended
same account was verified, not identify the account or include token bytes.

## Capture activity without exposing native logs

Set `QUAL_CONTAINER` to the exact disposable Assistant container, never a wildcard
or a production container selected by guesswork. The following commands only
read container metadata and selected runtime fields. Run the snapshot repeatedly
while the operator performs the cases below. Capture externally so evidence
survives replacement; select the replacement's exact container after each boot.

```sh
QUAL_CONTAINER=the-disposable-assistant-container
docker inspect --format '{{.Id}} {{.Config.Image}} {{.Config.Hostname}}' "$QUAL_CONTAINER"
docker exec "$QUAL_CONTAINER" codex --version
docker exec "$QUAL_CONTAINER" claude --version
docker exec -i "$QUAL_CONTAINER" node --input-type=module <<'JS'
import { readFileSync, readdirSync } from 'node:fs';
const root = '/tmp/fhold-runtime';
const read = (file) => {
  try { return JSON.parse(readFileSync(`${root}/${file}`, 'utf8')); }
  catch { return null; }
};
let files = [];
let readable = true;
try { files = readdirSync(`${root}/activity`); } catch { readable = false; }
const workers = Object.fromEntries(['codex', 'claude'].map((tool) => {
  const status = read(`remote/${tool}.json`);
  return [tool, { state: status?.state ?? 'unreadable', pid: status?.pid ?? null,
    ready: files.includes(`${tool}.ready`),
    busyMarkers: files.filter((name) => new RegExp(`^${tool}-[a-f0-9]{64}-[a-f0-9]{64}$`).test(name)).length }];
}));
const tick = read('keepalive-status.json');
console.log(JSON.stringify({ observedAt: new Date().toISOString(), readable,
  unknown: files.includes('unknown'), opencodeReady: files.includes('opencode.ready'), workers,
  keepalive: tick && { activity: tick.activity, enabled: tick.enabled,
    sent: tick.sent, checkedAt: tick.checkedAt } }));
JS
```

An unreadable snapshot or missing tick is a failed observation, never proof of
idle. Require a fresh `checkedAt` after the phase change and compare it with
receiver timestamps. A stale `sent: false` from before a turn proves nothing.
Do not publish raw native logs, pairing links, prompts, session IDs or credentials.
The selected snapshot is supporting evidence: it cannot replace the real client
transcript or prove that a client reached the intended instance.

## Execute the acceptance cases

1. **Unused enabled worker.** After normal boot with native account and required
   consent already enrolled, send no user turn. Verify the selected worker is
   enabled and `process-running`, its ready observation appears, and the whole
   otherwise-unused instance reaches fresh `activity: idle`, `sent: false`.
   Observe at least three keepalive intervals with no receiver requests. Empty
   busy-marker counts alone do not prove coverage. For Claude, document any
   native activation step that is required; do not call an activation turn
   "unused idle before any turn."
2. **Real client identity and history.** Pair through the actual supported clients.
   Have each client run `hostname` and `pwd` in a harmless request. Compare with
   the intended target; a reply from another running instance is a failure.
   Record a harmless unique conversation canary and finish the turn. Check native
   account/provider and configured permissions. OAuth refresh may change token
   bytes; verify identity and behavior rather than byte equality.
3. **Cold recovery and reconnect.** Stop through the supported lifecycle, wait for
   a successful final checkpoint, zero writers/replicas and released ownership,
   then restore into the same-instance replacement with an empty runtime home.
   Repeat case 1 before sending a turn, then reconnect both real clients. Resume
   the saved native conversation, recall the canary and repeat the identity/tool
   check. A warm restart with a surviving data directory is a separate test.
   Repeat cold recovery at least twice. Record checkpoint/replacement identities
   privately and do not claim success if the latest completed turn is missing.
4. **Quiet long work.** Through the real Codex client, explicitly request a harmless
   two-hour foreground shell wait followed by a fixed completion message, such
   as `sleep 7200; printf 'fhold quiet-work complete\n'`. Confirm actual execution
   has begun using the native client, not just that the model promised to do it.
   Keep the normal approval policy, and have the operator approve only the
   intended request. Sample activity at least every keepalive interval throughout
   the silent period; receiver requests must continue without a gap beyond the
   configured cadence plus request timeout. Record maximum gap and any hosting
   deactivation. After completion, require established idle and three quiet
   intervals. Repeat the applicable work/activity test for Claude and record its
   actual duration. A tool forced into background, interrupted or timed out early
   does not satisfy the foreground quiet-work case.
5. **Question, permission and reconnect.** In actual native clients, leave a
   question pending, then a harmless policy-controlled permission request pending.
   Verify work remains protected from idle shutdown while input is outstanding.
   Disconnect/reconnect the client while keeping Assistant running. Only the
   operator answers; exercise approve and deny, then verify work completes or
   cancels and returns to idle. Never replay an approval automatically.
6. **Replacement boundary.** Stop/restore is not a promise to resume in-flight
   vendor execution or pending approvals. Document the native outcome for a
   pending question/permission only in the disposable fixture. Confirm no command
   or approval is silently replayed, then require the normal explicit client flow
   to continue. Separate supported completed-conversation recovery from unsupported
   active-turn continuation; failure to resume an active turn must not be hidden
   by resubmission or a fabricated history entry.
7. **Observation failure.** On a separate disposable Codex fixture, copy
   `system/codex/requirements.toml` to an operator-owned policy file and explicitly
   mount that file at `/etc/codex/requirements.toml`, following the
   [custom policy instructions](../managed-harness-configuration.md#deployment-inputs).
   Set its native `[hooks] managed_dir` to a separate empty directory mounted
   read-only at startup. Keep managed-only hooks enabled.
   This deliberately withholds the expected managed inventory;
   do not change the image or cover `/etc/codex` with a directory mount.
   Confirm native hook review reports the missing inventory and the enabled running
   worker remains `unknown` with fresh successful keepalive requests. Record the
   policy change privately. If native policy validation prevents the worker from
   launching, this case is blocked; an inactive worker is not a failed observation
   of a running worker. Do not manually delete ready/busy markers, expire a
   busy marker, force idle or run a second server. Restore the ordinary fixture
   configuration only through its normal stopped lifecycle after collecting the
   failure evidence. This deliberate fault is not evidence for the healthy case.

## Report and close the gate

For every case, record pass, fail, blocked or unsupported; exact versions and
revision; UTC start/end; fresh before/during/after activity; receiver request count
and maximum gap; correct-instance native tool result; retained conversation; and
any operator consent. Retain redacted client evidence separately from the runtime
snapshot. Never infer a pass from process state, saved sign-in files, mocked
transport, a synthetic thread or unrelated OpenCode work.

Post the redacted matrix to #38. Any false idle during genuine work or a failure
to establish healthy unused idle needs a reproducible defect report. Missing
disposable account access, unsupported native pairing, or unavailable two-hour
execution remains an explicit acceptance blocker. Close the issue only when the
healthy and conservative-failure cases are demonstrated with real native clients;
otherwise retain its open qualification status and list the remaining cases.
