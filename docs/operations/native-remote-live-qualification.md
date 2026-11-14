# Native remote recovery qualification

The signed-in native-client checks below for [#38](https://github.com/fwdslsh/fhold/issues/38)
remain unqualified as of October 21, 2026. Keep the issue open until the
applicable cases pass with retained evidence. Conditional keep-alive and its
activity cases were removed from the product; they are no longer part of this gate.
An unsupported client/account combination is a blocker, not a successful test.

The automated harness smoke runs the actual image-baked CLIs with disposable
profiles and no vendor credentials and verifies real native hooks. These checks
do not prove vendor connectivity or a long model turn.

## Prepare an isolated target

An operator needs a disposable instance, explicitly authorized disposable vendor
accounts, a supported Codex client and Claude Remote Control client, and time to
complete native pairing/consent. Do not borrow a management host's credentials or
use an existing personal instance. Obtain account access through normal guided
setup described in [native remote access](../native-remote-access.md).

Use the selected release's normal install and deployment path. Preserve the
selected native sandbox and approval policy; do not weaken them to make a test
work. Unrelated workers may be explicitly disabled before the test, but the
worker under test must remain enabled.

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

## Execute the acceptance cases

1. **Real client identity and history.** Pair through the actual supported clients.
   Have each client run `hostname` and `pwd` in a harmless request. Compare with
   the intended target; a reply from another running instance is a failure.
   Record a harmless unique conversation canary and finish the turn. Check native
   account/provider and configured permissions. OAuth refresh may change token
   bytes; verify identity and behavior rather than byte equality.
2. **Cold recovery and reconnect.** Stop through the supported lifecycle, wait for
   a successful final checkpoint, zero writers/replicas and released ownership,
   then restore into the same-instance replacement with an empty runtime home.
   Reconnect both real clients. Resume the saved native conversation, recall the
   canary and repeat the identity/tool check. A warm restart with a surviving data directory is a separate test.
   Repeat cold recovery at least twice. Record checkpoint/replacement identities
   privately and do not claim success if the latest completed turn is missing.
3. **Question, permission and reconnect.** In actual native clients, leave a
   question pending, then a harmless policy-controlled permission request pending.
   Disconnect/reconnect the client while keeping Assistant running. Only the
   operator answers; exercise approve and deny, then verify work completes or
   cancels. For Codex, also interrupt a pending native `request_user_input`
   question without answering and cancel a pending command approval: confirm
   the interrupted turn. Never replay an approval automatically.
4. **Replacement boundary.** Stop/restore is not a promise to resume in-flight
   vendor execution or pending approvals. Document the native outcome for a
   pending question/permission only in the disposable fixture. Confirm no command
   or approval is silently replayed, then require the normal explicit client flow
   to continue. Separate supported completed-conversation recovery from unsupported
   active-turn continuation; failure to resume an active turn must not be hidden
   by resubmission or a fabricated history entry.

## Report and close the gate

For every case, record pass, fail, blocked or unsupported; exact versions and
revision; UTC start/end; correct-instance native tool result; retained
conversation; and any operator consent. Retain redacted client evidence. Never
infer a pass from process state, saved sign-in files, mocked transport, a
synthetic thread or unrelated OpenCode work.

Post the redacted matrix to #38. Missing disposable account access or unsupported
native pairing remains an explicit acceptance blocker. Close the issue only when
the cases are demonstrated with real native clients; otherwise retain its open qualification status and list the remaining cases.
