# Discord adapter

Discord is an optional adapter. It never calls Assistant directly; it is an MCP
client of Guardian.

## 1. Create the Discord application

In the Discord developer portal:

1. create an application and bot;
2. enable the Message Content intent;
3. invite the bot with permission to view channels, read message history, and
   send messages; and
4. copy the bot token once.

Store the token through the CLI. `-` reads it from standard input and the value
is never written to Compose, stack intent, logs, or command output:

```bash
fhold portal token discord --bot-token-file -
```

Avoid putting the token in shell history; an interactive secret editor or
password-manager command is preferable.

In fhold Admin, **Connections → Discord** presents the same checklist and
opens the Discord Developer Portal. **Add Discord token** moves directly to the
private token form; the value remains masked and is never shown again.

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

In Admin, expand **Who can use it**, enter the same IDs, choose the default
access identity, and select **Save connections**. If a required scope or token
is missing, Admin opens and focuses the exact field that needs attention.

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
Replies continue within a per-user channel/thread and credential-scoped
conversation. Changing a user's mapping starts fresh policy continuity. Send
`/clear` or `!clear` to discard that local conversation handle.

The adapter stores only opaque Guardian session handles in
`data/portal/discord/portal.db`.

An existing bot token can be configured with
`fhold portal token discord --bot-token-file <private-file> --no-apply`.
Keep the file private and configure fhold's own allowlist and credential mappings
before enabling the adapter. A connected gateway verifies token/intents,
not user access or agent behavior: test an allowed DM/mention, a disallowed user,
and the configured policy.

The Discord adapter is intentionally a conversational subset of the MCP
catalog. If a `full` agent pauses for a permission decision, the adapter tells
the user to complete that explicit decision with a full MCP client; chat text
is never treated as permission approval.

## Troubleshooting restricted-session replies

If the bot replies but says it cannot save knowledge or perform work from a
restricted session, check `fhold credential mappings discord`. An allowlisted
user without a mapping still uses the default `discord` credential, normally
`chat`. Being the bot owner or being allowed into the portal does not select the
`owner` identity. In Admin, **People & access** can map the exact Discord user
to an existing full-access identity; the CLI equivalent is:

```bash
fhold credential map discord 123456789012345678 owner
```

Do this only for the trusted operator, keeping the shared default restricted.
Mappings are reread on each message and start a fresh credential-scoped
conversation; neither a bot restart nor deletion of old conversations is needed.
The shared Assistant instructions must distinguish explicit full-access saves
from automatic memory capture, which remains disabled for Guardian sessions.
If a native tool approval is requested, use a full MCP client to complete it;
do not broaden permissions to bypass that approval.
