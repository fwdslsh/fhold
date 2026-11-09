# Guardian image

Guardian is an optional authenticated MCP security gateway.

The image contains the Bun Guardian service and the OpenCode client SDK. Its
entrypoint validates the credential registry and strong file secrets, then starts
Guardian. It runs no OpenCode server or AKM installation and performs no
installation at boot. OpenCode and AKM run in Assistant.

Guardian exposes only:

- `GET /health`
- MCP Streamable HTTP at `/mcp`
- RFC 9728 protected-resource metadata at the standard discovery paths when
  OAuth is enabled

It authenticates named credentials reusable by MCP, Discord, and Slack; rate-limits and
bounds requests; encrypts expiring session/message/job/interaction handles; screens every message;
and sends allowed messages to Assistant with the configured class policy.
`chat` is tool-disabled, `read` permits bounded filesystem inspection, and
`full` inherits Assistant permissions. Suspicious input is classified through
Assistant's authenticated, tool-free OpenCode `generate.text` API, using the model
selected in `config/guardian/opencode.json`. This call creates no agent session
and cannot execute tools. Provider credentials and native global configuration
remain in Assistant. Any moderation failure, invalid result, `flag`, or `block`
verdict fails closed.

Guardian runs non-root with all capabilities dropped. It mounts operator
moderation configuration, the named credential registry, secret files and `/work`
read-only; only its audit-log directory is a read/write bind mount. It receives
the Assistant API password, but no model-provider credentials. Its direct MCP file reader
uses the read-only workspace mount to reject symlink escapes before returning
content.
