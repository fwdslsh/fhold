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

A Portal restart does not cancel native work. Recovery requires the original
Guardian job to remain valid and its current owner to retain access. If Guardian
also restarts or a handle expires, rejection is reported without resubmitting work.
Blocked receipts remain private for review; terminal receipts expire after seven
days. This does not alter native history retention. Missing/deleted source messages,
revoked access, changed bot identities and rotated connection keys stop automatic
delivery rather than redirecting private answers.

This applies to requests received by beta.12 or later. Allow beta.11 work to
finish before updating its Portal: the older version did not write delivery
receipts, and a new version cannot reconstruct those pending notifications.

Automated tests cover reopened adapters, pending permission controls, repeated
replacement, unknown sends/submissions, current access checks and a native Node
process killed after its SQLite checkpoint. Controlled SDK tests are not evidence
of a new live Slack or Discord conversation; qualify real bot delivery separately.
