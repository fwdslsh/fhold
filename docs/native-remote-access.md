# Experimental Codex and Claude Code remote sessions

Both integrations remain experimental.
Both supervisors default on. Both have native
account, consent, host and client requirements, and either can be disabled.
Only a future release with explicit end-to-end validation may remove that label.
This status does not apply to the core fhold agent or Claude Desktop MCPB.

Use matching CLI/Admin and Assistant releases. Guided setup uses the image-baked
helpers; built-in recall hooks use native managed registration. Replacing source
or one frontend does not update a running image. See [upgrading](managing-fhold.md#upgrade-from-alpha3)
and [managed configuration](managed-harness-configuration.md).

These options start **separate native coding agents** in the Assistant's
workspace. They do not turn Codex or Claude Code into clients of OpenCode, expose
its conversation history, or apply Guardian credential policies. Use OpenCode
or Guardian MCP if you want the fhold personal agent and its existing sessions.

Both supervisors default on and wait for native sign-in/consent.
The existing supervisor checks `claude auth status` or `codex login status`
before launching a worker. Confirmed missing subscription sign-in reports
`sign-in-needed` and retries without keeping an otherwise idle instance awake.
Completing the built-in setup flow restarts the worker immediately; ordinary
native sign-in is picked up on the next retry. Status failures do not prevent
native startup or affect OpenCode. Signed-in worker activity remains unknown
until native hooks establish coverage; account presence is not proof of idle,
valid tokens, consent or a working client connection.
Explicit off choices are preserved. No public URL, extra container, SSH daemon, published
port, host-home mount, or runtime package installation is added. The release image
bakes exact CLI versions. Native account state stays in `FH_HOME/data/assistant`
under the vendor's normal files; it is not included in portable knowledge backup
or imported as an OpenCode provider credential. Pairing output is private and
bounded under the container's `/tmp/fhold-runtime/remote`; restart replaces it.

`FH_CODEX_REMOTE` and `FH_CLAUDE_REMOTE` are container startup switches, not
vendor authentication requirements. Leave them unset for normal startup.
Setting either to `0` disables that worker without deleting its account state;
managed CLI/Admin saves the same choice in StackConfig. There is no additional
remote configuration file or sign-in credential store. Existing explicit off
choices remain off during updates.

## Codex (experimental)

```sh
fhold remote enable codex
# Optional: limit native tools to read-only access
fhold remote enable codex --sandbox read-only
# Explicitly use the container as the isolation boundary (only when explicitly intended):
fhold remote enable codex --sandbox danger-full-access
fhold remote status codex
fhold remote pair codex
```

Guided enable first checks automatic knowledge recall as described below. It
then pauses the selected worker, checks native sandbox support for workspace/read-only
modes with a harmless local command, and then uses Codex device sign-in. Explicit
container isolation skips only that bubblewrap prerequisite. It opens the native
sign-in URL in the host browser; enter the one-time code there. Use
`--no-browser` over SSH and open the printed link on your own computer. If device
login is unavailable, enable it in your ChatGPT account/workspace settings.
Successful setup automatically saves sandbox intent and enables startup.
It then requests a fresh private pairing code from the background service.
Startup runs native
`codex app-server --remote-control --listen unix://` in the foreground with the instance task permission policy and
`workspace-write` (default), explicitly selected `read-only`, or explicitly selected
`danger-full-access`. The first two require native sandbox support; neither is
a namespace-error workaround. `danger-full-access` removes the inner filesystem
and network sandbox and uses the surrounding container as the isolation boundary.
Codex can then access any files, credentials or network available inside that
container. Approvals default to `on-request`; operators can supply native policy
as described in [managed configuration](managed-harness-configuration.md).
No bypass-approvals flag, privileged container, extra
capability, automatic fallback or host-platform detection is used.
Pair requests a fresh short-lived code from the
running native service. Treat that code as private.
The private Unix socket is the upstream control transport used by native pairing;
it is not a published listener. The pinned CLI supports this foreground mode.
Using `remote-control start` instead would start a separately managed daemon with
its own runtime package installation/updater, which this image intentionally avoids.

Codex labels this command experimental. A pairing code is **not** a guarantee
that a particular app can connect to a Linux container. OpenAI's published mobile
setup currently starts from a supported Mac/Windows desktop app; desktop/SSH and
CLI remote-control availability differ. Follow your client's native pairing flow
if it supports manual codes. fhold does not add an SSH server or an
unauthenticated app-server transport to work around availability limits.
Workspace/read-only modes require native sandbox support for tool execution.
Explicit container isolation follows
[OpenAI's container guidance](https://learn.chatgpt.com/docs/agent-approvals-security#run-codex-in-dev-containers).
See [OpenAI's command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
and [remote connection requirements](https://learn.chatgpt.com/docs/remote-connections).

Codex may refuse workspace/read-only tool execution on a host that cannot
create the required namespaces. A running worker or pairing code does not
resolve that prerequisite. Choose container isolation explicitly only when
the surrounding container is the intended boundary; never make Assistant privileged
or mistake successful pairing for a real tool request.

### Set up from an OpenCode conversation

Ask **“Help me set up Codex remote access.”** The built-in
[`codex-remote-setup` skill](../packages/skeleton/system/assistant/skills/codex-remote-setup/SKILL.md)
ships a runnable `scripts/setup.sh` backed by the same native setup helper as
CLI/Admin, retaining the device
login process while you open its link and enter the one-time code in your browser.
It reuses existing ChatGPT sign-in, preserves configured sandbox intent and guides
managed AKM hook verification. It installs nothing.

The skill requires Bash-capable access. The background supervisor already starts
by default and retries while waiting for native sign-in/consent. No startup
variable is required after sign-in. Only an explicitly disabled worker needs
CLI/Admin enable or an external deployment change and safe restart. Keep the
reviewed `FH_CODEX_SANDBOX`; changing a shell variable is not a deployment update.
Pairing and a real native-client tool request are separate
readiness checks, and remain experimental. Automated tests execute the shipped
recipes using a disposable CLI fixture and the real native prompt bridge; they
do not exchange a real user's device code or qualify vendor-client availability.

## Claude Code Remote Control (experimental)

```sh
fhold remote enable claude
fhold remote status claude
fhold remote pair claude
```

Guided enable pauses the selected worker and opens native subscription sign-in
in your host browser. Complete sign-in and, if requested, paste the native code
back into the CLI or Admin dialog. It then starts native Remote Control inside
`/work`: read the workspace-trust and one-time Remote Control consent prompts
and answer `y` to accept or `n` to decline. fhold never answers them for you
or rewrites native trust settings. Once the native connection URL is produced,
the setup worker stops and normal background startup is enabled automatically.
The guide waits for and opens the **background worker's** connection URL, not
the temporary setup server's URL. A startup/pairing failure rolls startup back
off; a connection link still does not prove your remote client or tools work.
Remote Control needs subscription sign-in, not
an Anthropic API key or an OpenCode provider login.

Startup runs native `claude remote-control` in server mode, with one concurrent
session, default interactive permissions, and Chrome access off. The pair command
shows the private native output containing the connection link, or the sign-in /
consent error if startup failed. Open the link in claude.ai/code or use Claude's
mobile app. Claude Code uses outbound HTTPS and does not need an inbound listener.
See [Anthropic's requirements and troubleshooting](https://code.claude.com/docs/en/remote-control).

Enabled means automatic remote startup, not just an installed CLI. `assistant.claudeRemote`
is saved by CLI/Admin enable and materializes `FH_CLAUDE_REMOTE=1`; standalone
hosting defaults to that value and can set `FH_CLAUDE_REMOTE=0` to disable it.
The supervisor starts
on every boot after recovery, including with `FH_SCHEDULER_ENABLED=0`, and retries
vendor failures without stopping OpenCode. Native browser sign-in alone does not
change deployment intent. Complete `claude auth login --claudeai` inside `/work`,
verify `claude auth status`, and explicitly accept workspace trust and Remote
Control consent through `claude remote-control --spawn same-dir --capacity 1`.
API keys, `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` cannot authenticate
Remote Control; it requires the full-scope native subscription login.

### Sign in from an OpenCode conversation

Ask the assistant: **“Help me sign in to Claude Code.”** The built-in
[`claude-code-login` skill](../packages/skeleton/system/assistant/skills/claude-code-login/SKILL.md)
uses the normal native login, shares its authorization link, and waits across
separate agent tool calls for your browser response. Paste the **complete
`code#state` value**, including the part after `#`, when requested.

The skill preserves an existing subscription sign-in. A new attempt runs in a
private temporary directory, keeps its native process and FIFO alive, accepts
one callback, and expires after 15 minutes. A dead process, invalid exchange,
timeout, or container replacement needs a fresh attempt and URL—not a retry of
the old code. Scratch files are removed after completion/cancellation; native
account files are never removed by the skill.

This skill is image-baked and also included in the CLI/Admin managed assets;
the assistant loads it through OpenCode's standard skill tool. It adds no
OAuth implementation, daemon, dependency, or startup installation. It requires
an agent session with Bash access; Guardian chat/read policies cannot sign in.
Workspace trust and Remote Control consent remain separate native user choices.
Account sign-in alone is not proof that a remote client or its tools work.

The skill now ships runnable `scripts/login.sh` and `scripts/remote.sh` rather
than inline process recipes. The background worker has a native PTY and reports
`approval-needed` while waiting for workspace trust or Remote Control consent.
The remote script relays only an explicit operator yes/no to that exact live
worker. It never starts another server or edits native trust/approval files.
Native choices are preserved in the usual account files across restart/restore.

For container-level diagnosis, the built-in
[`fhold-admin` skill](../packages/skeleton/system/assistant/skills/fhold-admin/SKILL.md)
ships a redacted status script and routes sign-in/pairing to these two native
setup skills. All three skills and their scripts share the release-owned asset
manifest used by the image, CLI and optional Admin; no plugin download or startup
installation is needed. It has no Docker/cloud authority and cannot update the
deployment with shell exports. Scoped worker restart requires permission to
interrupt that native tool, without restarting OpenCode or recovery.

Automated tests execute the shipped Bash recipes across separate calls with a
disposable native-CLI fixture, covering callback binding, single submission,
bare-code rejection, expiry, and cancellation without changing account files.
Image smoke tests verify native skill discovery and identical baked/mounted
bytes before and after restart. They do not exchange a real user's OAuth code.

The image includes AKM for all three harnesses: OpenCode, Claude Code, and Codex.
Claude/Codex use their standard native marketplace installers during image
build against the same checksum-verified release. No startup install, inline
loader, or marketplace download is needed. Native generated defaults are seeded
into the persistent home and refreshed only while untouched; your edited
settings, accounts, additional plugins, and trust decisions are preserved.

Run `claude plugin list`, `claude plugin details akm`, or
`codex plugin list --json` inside Assistant to inspect `akm@akm-plugins`.
Claude provides the five discovery/feedback/remember commands and AKM skill;
Codex uses the AKM skill and CLI forms. The built-in lifecycle hooks are
registered as native system-managed handlers and need no personal approval.
Task permissions follow the operator's native policy; account sign-in and
remote consent remain separate.
All harnesses use `/stash` knowledge and aligned AKM versions. Automatic learning
and session extraction remain off in the native remote workers
(`AKM_AUTO_LEARNING=0`, `AKM_AUTO_MEMORY=0`). Image tests verify real session hooks
and knowledge recall in each harness, separately from vendor sign-in.
See [Claude's standard plugin installation](https://code.claude.com/docs/en/discover-plugins)
and [Codex plugins](https://developers.openai.com/plugins/build/plugins).

## Codex automatic knowledge recall

On current images, automatic knowledge recall is managed by instance policy.
AKM executes a session-start command to
check its CLI and load bundle hints, then a pre-prompt command that passes the
prompt to `akm curate` and adds relevant knowledge to Codex. Configured search or
embedding services may be contacted. This does not enable automatic memory
writes, approve tools, or bypass Guardian/native sandboxing.

Admin **Apps → Codex → Review knowledge recall** checks the native managed
inventory independently from remote startup and sign-in. **Managed · ready**
means all expected handlers are enabled by policy; personal approve/disable
controls are unavailable. CLI setup also skips the personal approval question.

Older images without managed hooks retain these states and the review flow below:

- **Installed**: hooks are installed but automatic recall is off.
- **Approval needed**: hooks are new/changed, not yet trusted, or only partly enabled.
- **Ready**: every AKM hook is enabled and trusted by Codex.

Approval is bound to the exact definitions displayed. Changed definitions or
native-config write conflicts reject a stale review; review again rather than
reusing the old confirmation. Codex's native `hooks/list` and version-checked
`config/batchWrite` interfaces persist trust in its normal configuration. No
separate trust store, blanket approval, or bypass flag
is used. Unrelated user/project/plugin hooks are left alone. Approval and opt-out
survive container recreation and apply to new sessions. Admin also offers
**Turn off automatic knowledge recall** without changing remote startup.

On older images CLI setup/enable offers the same choice. To review separately:

```sh
fhold remote recall codex
# Read-only inventory, including the current review digest:
fhold remote recall codex --status
# Explicit automation consent, only after reviewing that inventory:
fhold remote recall codex --approve --review CURRENT_DIGEST
fhold remote recall codex --off --review CURRENT_DIGEST
```

`--trust` confirms native workspace access only, never hook approval. Declining
the recall prompt leaves the previous native decision unchanged. In Admin's
Codex setup, clearing an already-enabled recall choice turns recall off when
you continue. An unsupported/stopped image is reported as not checked, not Ready.
See [Codex's hook trust model](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

## Toggles, recovery, and trust

In Admin, open **Apps → Claude → Claude remote connection** and choose
**Set up remote connection**,
or **Apps → Codex → Set up Codex**. Confirm trusted workspace access and select
**Continue**. Codex uses workspace-write by default; read-only and explicit
container isolation are under **Advanced settings**. The latter explains full
container access before you confirm trust. The browser handles account login;
the private dialog displays native prompts and
accepts your answers. Cancellation or a failed prerequisite leaves startup off.
No terminal is required for the guided Admin flow. CLI enable requires a
terminal for prompt answers; `--trust` explicitly confirms fhold's trust
warning but does not accept any vendor prompt.
After setup or restart, use Admin's **Open in Claude** for Claude or
**Get pairing code** for Codex to refresh private connection details.

During initial CLI onboarding, optionally use:

```sh
fhold setup --claude-remote
fhold setup --codex-remote
```

Provider readiness runs first; these separate native accounts are never inferred
from the provider login. Only one guided setup or lifecycle operation runs at a
time. A 15-minute deadline and closing Admin cancel unfinished native setup.

Disable startup without deleting native account state:

```sh
fhold remote disable claude
fhold remote disable codex
```

### Advanced/manual controls

If you prefer the native terminal directly:

```sh
fhold remote setup codex
fhold config assistant --codex-remote on
fhold remote setup claude
# Accept trust, /login, /remote-control consent, then /exit
fhold config assistant --claude-remote on
```

Manual switches save intent and recreate Assistant; add `--no-apply` to defer.
They do not run guided prerequisite checks or sign in for you.

```sh
fhold config assistant --codex-remote off --claude-remote off
```

Turning a switch off stops its container processes, but keeps native account
state and does not revoke paired devices in the vendor account. Manage account
sign-out and device revocation through the vendor's own controls. To repeat setup,
turn that agent off first to avoid competing background and interactive sessions.

These agents have trusted access to the workspace and Assistant's mounted
knowledge, like native OpenCode. Guardian's `chat`/`read`/`full` credential registry
does not control them. Do not enable them for untrusted users. They keep their
own histories and permissions; fhold's automatic OpenCode memory capture and
restricted scheduled profile do not implicitly apply to vendor-native sessions.

`process-running` means only that the local process started, not that sign-in,
pairing, a remote client, or a tool call succeeded. `sign-in-needed` identifies a
supervisor waiting for the required native account, not a disabled worker.
It includes the next account-check time. `waiting-to-retry` includes an
exit code and next attempt time. Failures retry every five minutes without
stopping OpenCode or scheduled work. Inspect native output with `fhold remote
logs codex` or `fhold remote logs claude` when pairing fails. Do not paste those logs into
public issues without removing pairing links and account details.

## Acceptance checklist

1. Fresh install: both supervisors default on. Without subscription sign-in,
   both report `sign-in-needed` and neither remote worker starts. Once OpenCode
   activity is idle, enabled keep-alive sends no requests.
2. Use guided enable in CLI and Admin. Verify only the selected worker pauses,
   a native sign-in link opens in the host browser (with a printed fallback),
   and trust/consent are explicit human answers. Do not copy host authentication.
   Cancel once and verify startup stays off with no lingering setup process.
3. Complete setup for one vendor. Verify OpenCode and scheduler remain healthy;
   the other unsigned-in vendor still waits. Inspect status, then pair a supported
   client. Explicitly disabled workers must remain off.
4. From that client, create a session, inspect a workspace file, request a harmless
   file edit, and exercise both approve and deny. Confirm approvals are not bypassed.
   For Codex, verify sandboxed execution works on this host; report unsupported
   sandbox/client limitations rather than weakening security settings.
5. Restart Assistant. Verify native sign-in persists and the remote agent starts
   again. Confirm session continuation using the vendor's own supported flow;
   no OpenCode session or Guardian policy should appear in the vendor history.
6. Test missing sign-in/consent in an isolated fresh home. Missing sign-in waits
   without a worker; native consent waits keep activity unknown. Both leave
   OpenCode and scheduler healthy, with no pairing link in Docker logs. A failed
   account-status check must not silently classify an enabled worker as idle or
   prevent native startup. Fix through the ordinary interactive setup flow.
7. Disable both switches. Verify all remote child processes stop and no additional
   port, privileged mount, or Guardian/portal credential reaches Assistant.

Automated tests cover config intent, CLI argument validation, private bounded
output, environment separation, retry behavior, and child-process shutdown.
Image smoke tests exercise the baked vendor CLIs. Native prompt fixtures test
the PTY bridge, human answers and refusal, native-account reuse, sandbox failure,
cancellation, split-output URL redaction, and activation
gating. Admin E2E checks dialog navigation, focus, and safe choices. A live
credential-free container probe verified Claude's browser sign-in URL and
cancellation, and Codex's unsupported-sandbox failure before sign-in on the
tested host. Alpha.2 additionally confirmed a real Claude native-client tool
request; see [product qualification](operations/alpha-qualification.md). Consent,
pairing and account renewal still require human/account-supported acceptance for
each selected client. Codex end-to-end client readiness is not established by
the offline harness. Package versions and process health are not connection tests.

Maintainers can run missing-sign-in image acceptance without any real account:

```sh
docker build -f containers/assistant/Dockerfile \
  --build-arg PLATFORM_VERSION="$(node -p 'require("./package.json").version')" \
  -t fhold/assistant:guided-remote-dev .
FH_SMOKE_REMOTE=1 ./scripts/smoke-image.sh fhold/assistant:guided-remote-dev assistant
```
