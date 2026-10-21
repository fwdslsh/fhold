# Portal restart recovery

Discord and Slack keep private delivery receipts in their existing `portal.db`.
No additional service or configuration is needed. Existing conversation mappings
remain intact. Keep this database private: unfinished receipts contain queued
requests, credential-scoped Guardian handles, public reply text, and platform
message IDs. API keys, bot tokens and approval decisions are not stored in receipts.

Before submitting work, the adapter creates and acknowledges a Working message.
It records submission intent before calling Guardian and saves the accepted job
handle before sending progress. A final answer is saved before editing platform
messages. Native SQLite commits use WAL with full synchronization.

After replacement, the adapter checks its bot identity, current requester mapping,
connection-key fingerprint and platform allowlists. Discord also fetches the original
request and current guild roles. It resumes inspection of accepted jobs with
`fhold.job.get`, preserving the original conversation and editing acknowledged
messages in place. Requests that were queued but never submitted retain their order.
Completed request tombstones suppress repeated platform events for seven days.

Credential ownership is checked again before each answer, activity or prompt
write, including a saved final result and every chunk of a long answer. A changed
mapping, rotated key or unreadable credential bundle blocks that delivery and
stops further job inspection at the next MCP response. It does not cancel native
work or undo messages already sent while access was valid. Previously visible
controls may remain on the platform, but cannot authorize a response after the
delivery loses access. Check the original session in OpenCode; restoring the old
key does not automatically replay blocked work or publish its saved answer.

Current questions and permission requests are fetched again from Guardian. Existing
prompt messages receive fresh requester-owned controls; old button IDs cannot
approve anything. Partial selections not yet submitted to Guardian must be entered
again. Saved decisions are never replayed. Slack Stop controls target the same job.

## Delivery guarantees and boundaries

Known message edits are safe to repeat after an interrupted acknowledgment. New
message posts and native submissions are recorded before the request is sent. If
their outcome is unknown, the Portal does not retry them automatically: a platform
post may have succeeded even when its response was lost. The receipt is marked
blocked, an actionable warning is logged, and an existing acknowledged reply is
updated when possible. Check the original conversation in OpenCode before explicitly
asking for new work. This is bounded duplicate prevention, not an exactly-once
transaction spanning SQLite, Guardian and the messaging platform.
If a final snapshot is shorter than earlier streamed text, surplus acknowledged
answer messages are edited to a replacement notice. They are not deleted, reused
for another request or left displaying an obsolete answer. Interrupted cleanup
can be retried against those same known message IDs.

A Portal restart does not cancel native work. Recovery requires the original
Guardian job to remain valid and its current owner to retain access. If Guardian
also restarts or a handle expires, rejection is reported without resubmitting work.
Blocked receipts remain private for review; terminal receipts expire after seven
days. This does not alter native history retention. Missing/deleted Discord source
messages, revoked configured access, changed bot identities and rotated connection
keys stop automatic delivery rather than redirecting private answers. Slack uses
the saved original channel/thread and configured access; it does not refetch the
source message or prove that workspace membership is unchanged. Native Slack API
access failures stop the attempted write. Deleting a Slack request alone is not a
revocation mechanism; revoke its configured access or connection key instead.

This applies to requests received by beta.12 or later. Allow beta.11 work to
finish before updating its Portal: the older version did not write delivery
receipts, and a new version cannot reconstruct those pending notifications.

Automated tests cover reopened adapters, pending permission controls, repeated
replacement, unknown sends/submissions, current access checks and a native Node
process killed after its SQLite checkpoint. Controlled SDK tests are not evidence
of a new live Slack or Discord conversation; qualify real bot delivery separately.

## Live replacement qualification

This checklist requires an explicitly authorized disposable instance, test bot and
private test channel/server on **each** platform. Use separate requester and
non-requester test accounts, including a pair mapped to the same Guardian
credential. The operator sends the test messages and decisions. Do not use a
production conversation, production connection key or an existing user home.
Keep Guardian and Assistant running while replacing **only** the test Portal;
replacing Guardian is a separate handle-expiration case, not ordinary recovery.
Use the same image digest and the same private Portal volume on replacement.

Record the source SHA, image digest, native Node version, platform SDK version,
test platform, redacted case ID, interruption method and outcome. Keep platform
message IDs, Guardian handles and database copies private; public issue comments
need only the case/outcome and artifact hash, never tokens or transcript contents.

| Case | Operator action and interruption | Required observation |
| --- | --- | --- |
| Accepted work | Request a harmless long task that writes a unique marker in its disposable workspace, then produces a long answer. Wait for an accepted job/visible progress; replace Portal normally, then repeat with abrupt termination in a new case. | Resume the original job and native session; marker created once; original thread/channel and acknowledged reply IDs retained. No second submission. |
| Questions | Ask for a sequential question with multiple selections. Select part of an answer, then replace Portal before submitting it. | Current question controls return, partial local selections reset, old buttons fail, and only the original requester can answer. Another account sharing the credential cannot answer. |
| Permissions | Use a harmless operation that actually triggers the configured native permission policy; never weaken the policy to manufacture a pass. Replace Portal while approval is pending. | Fresh explicit requester decision required. Old/foreign controls and ordinary text cannot approve. Record one native response; no replay after another replacement. If the policy cannot elicit approval, record the case as unqualified. |
| Slack Stop | Replace Portal during accepted work and click its restored Stop, first as the other test user and then as requester. | Other user refused; requester cancels the original job; one cancellation, no new work, final controls removed. |
| Final delivery | Use a long answer spanning messages; interrupt Portal while final messages are being updated, then replace it twice. | Known IDs edited in place; no duplicated final posts or stale answer tails. A genuinely unacknowledged new post is blocked with guidance rather than resent. Do not claim an exact crash window unless observed. |
| Revoked access | During accepted work, rotate the disposable connection key or remap the requester; separately repeat while recovering a saved final answer. | No further answer/prompt chunks after the next authorization check; private receipt blocked; no submission, decision or cancellation replay. Already accepted network writes cannot be recalled. |
| Current policy | Change the test instance's configured requester allowlist before replacement; for Discord also remove the test role/member or delete the test source message. | Recovery blocks before inspecting or publishing private work. Record Slack source-deletion/membership checking as the boundary described above, not a supported revocation test. |
| Guardian loss | In a separate disposable case replace Guardian or expire its accepted job before replacing Portal. | Explicit continuation guidance, no native work replay, and existing native history/mappings retained. |

Observe Guardian audit events and the disposable marker/session for submission,
decision and cancellation counts; a screenshot of one reply cannot prove absence
of replay. Do not log request bodies or credential-scoped handles. Repeat normal,
abrupt and repeated replacement cases on both platforms, and retain failed case
evidence before changing code. Until this matrix is actually executed, report
live Slack/Discord replacement as **unqualified**, even when all automated tests
and image smokes pass.
