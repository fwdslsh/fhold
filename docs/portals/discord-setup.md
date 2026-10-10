# Discord adapter

Discord is an optional adapter. It never calls Assistant directly; it is an MCP
client of Guardian.

## 1. Create the Discord application

In the Discord developer portal:

1. create an application and bot;
2. enable the Message Content intent;
3. invite the bot with **View Channels**, **Read Message History**, **Send Messages**,
   **Create Public Threads**, **Send Messages in Threads**, and **Add Reactions**; and
4. copy the bot token once.

Store the token through the CLI. `-` reads it from standard input and the value
is never written to Compose, stack intent, logs, or command output:

```bash
fhold portal token discord --bot-token-file -
```

Avoid putting the token in shell history; an interactive secret editor or
password-manager command is preferable.

In fhold Admin, **Apps → Discord** presents the same checklist and
opens the Discord Developer Portal. **Bot tokens → Save Discord token** stores
the value privately; it remains masked and is never shown again. Default access,
allowed-user rules and individual user mappings are in the same Discord section.
**Save Discord settings** does not save another app's drafts. Restart now or
later when prompted; enabling Discord also enables the MCP service it needs.

## 2. Configure a default-deny scope

Configure at least one allowlist through validated stack intent:

```bash
fhold portal access discord \
  --guilds 123456789012345678 \
  --roles 234567890123456789 \
  --no-apply
```

Values are comma-separated Discord snowflake IDs. Every non-empty allowlist must
match. For example, configured guild and role lists require both a permitted
guild and a permitted role. A blocked user always loses access.

For direct messages, configure users and leave guild/role lists empty; a DM
cannot satisfy a guild or role constraint. For a personal bot, explicitly
choose your own Discord user ID:

```bash
fhold portal access discord --users 123456789012345678 --no-apply
```

Bot ownership does not automatically grant access. A team-owned bot requires
an operator choice of permitted users. The adapter refuses all use when every
allowlist is empty; choose permitted users explicitly.

In the revised Admin preview, open **Apps → Discord → Who can use the bot**
and enter the same IDs. Choose Chat only, Read files or Full access under
**What can Discord do?**, then select **Save Discord settings**. Normal bot setup
does not ask you to choose or copy a fhold key; the existing credential remains
private plumbing. Full access requires confirmation. If a required scope or token
is missing, Admin opens and focuses the field that needs attention. The preview
has not yet been live-verified; see the [Admin runbook](../operations/admin-setup-verification.md).

**Different permissions for a person** lets you enter an exact Discord user ID
and choose their permissions with **Save person permissions**, without naming a
key. The user must still pass the
allowlist. Existing mappings retain their credential IDs. Editing saved
permissions affects every use of that identity and requires confirmation;
ordinary edits preserve the existing conversations and bot assignment. **Use bot
permissions** removes an override, not access checks. Existing permission editing
is under **Apps → Advanced access → Manage**. Key rotation, when needed,
is under **System → Connection keys**; it is not part of bot setup.

## 3. Enable and verify

```bash
fhold credential set-policy discord chat
fhold portal credential discord --credential discord --no-apply
fhold portal enable discord
fhold status
fhold logs
```

`chat` is the safe default for a shared chat platform. `read` additionally lets
the agent inspect non-secret content in `/stash` and `/work`; `full` inherits Assistant tool
permissions and should be used only when both the Discord allowlist and every
permitted user are trusted to trigger state-changing work.

In particular, default `chat` does not grant knowledge reads or task management.
For a trusted personal operator needing the complete tool interface, choose a
separate `full` credential and map only that exact allowed user:

```bash
fhold credential add personal-operator full
fhold credential map discord 123456789012345678 personal-operator
```

The selected credential is the fallback for every allowed Discord user. Map an
exact Discord user snowflake to another named credential when that user needs a
different policy:

```bash
fhold credential add support-read read
fhold credential map discord 123456789012345678 support-read
fhold credential mappings discord
```

Remove the override with `fhold credential unmap discord
123456789012345678`. All guild, role, user, and block-list checks still apply;
a credential mapping never grants portal access. The portal receives only a
generated keyring for its fallback and mapped credentials. Guardian OAuth
issuer/subject mappings resolve through the same registry for remote MCP
clients; Discord itself continues to use exact platform-user mappings.

Mention the bot in an allowed server channel or send an allowed direct message.
Channel mentions create a thread named after the request. Replies inside an
active thread do not need another mention. Existing threads are reused; DMs stay
in the DM. If thread creation is unavailable, the bot logs that limitation and
answers in the channel. Conversations remain credential-scoped.
Changing a user's mapping starts fresh policy continuity. Send
`/clear` or `!clear` to discard that local conversation handle.

Typing continues while work is running. Public answer text appears as throttled
message edits, followed by the complete answer. Tool kinds add reactions to the
request: 🔎 knowledge search, 🐚 commands, ✏️ editing, 🧠 memory and similar icons.
Missing reaction permissions do not stop replies. The bot keeps checking long
jobs; no MCP client or job ID is needed because work takes more than a few minutes. New messages in
that conversation remain queued behind the active request. The Portal must stay
running to deliver the response: restarting it does not cancel native agent work,
but automatic reply delivery is not recovered across a Portal restart. The agent's
work and history remain available in OpenCode.

The adapter stores only opaque Guardian session handles in
`data/portal/discord/portal.db`.

An existing bot token can be configured with
`fhold portal token discord --bot-token-file <private-file> --no-apply`.
Keep the file private and configure fhold's own allowlist and credential mappings
before enabling the adapter. A connected gateway verifies token/intents,
not user access or agent behavior: test an allowed DM/mention, a disallowed user,
and the configured policy.

Questions and native permission requests appear in the same thread with buttons.
Only the requester may answer, even when other users share their fhold credential.
Questions support options, multiple selections, sequential questions and free-text
replies where the agent allows them. Permission buttons offer Allow once, Always
allow and Deny only when permitted by the credential policy. Ordinary chat text
is never treated as approval. Full request text is split into messages rather than
hidden behind truncation. Buttons close after the response; answering resumes
the existing job, not a new request. No slash-command installation is needed.

## Troubleshooting restricted-session replies

If the bot replies but says it cannot save knowledge or perform work from a
restricted session, check `fhold credential mappings discord`. An allowlisted
user without a mapping still uses the default `discord` credential, normally
`chat`. Being the bot owner or being allowed into the portal does not select the
`owner` identity. In Admin, **Apps → Discord → Different permissions for
a person** can explicitly grant Full access to the exact Discord user;
the CLI equivalent is:

```bash
fhold credential map discord 123456789012345678 owner
```

Do this only for the trusted operator, keeping the shared default restricted.
Mappings are reread on each message and start a fresh credential-scoped
conversation; neither a bot restart nor deletion of old conversations is needed.
The shared Assistant instructions must distinguish explicit full-access saves
from automatic memory capture, which remains disabled for Guardian sessions.
If a native tool approval is requested, make the explicit decision using its
buttons; do not broaden permissions to bypass that approval.
