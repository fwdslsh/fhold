# Native harness configuration

fhold supplies prebuilt AKM/OpenCode tools and minimal setup/maintenance.
Native platforms own agents, tools, permissions, memory, hooks, skills and MCP.
fhold adds no local agent-name allowlist, recall prompt filter, restricted
scheduled agent or duplicate memory extractor.

## Deployment inputs

Release-owned defaults are image-baked and selected by the managed asset
allowlist. Install/update refreshes those bytes; operator preferences remain
writable and are not converted or overwritten.

| Host file | Container file | Owner |
|---|---|---|
| `system/assistant/opencode.json` | `/etc/opencode/opencode.json` | Product schema declaration, no extra task restrictions |
| `config/assistant/opencode.json[c]` | `/home/fhold/.config/opencode/opencode.json[c]` | Native operator preferences |
| `system/codex/config.toml` | `/etc/codex/config.toml` | Native built-in plugin registration |
| `system/codex/requirements.toml` | `/etc/codex/requirements.toml` | Empty product requirements, no hook/task restriction |
| `system/claude/managed-settings.json` | `/etc/claude-code/managed-settings.json` | Empty product settings |
| `data/assistant/.codex/config.toml` | `/home/fhold/.codex/config.toml` | Native operator settings and exact-hash hook approvals |
| `data/assistant/.claude/settings.json` | `/home/fhold/.claude/settings.json` | Native operator settings |
| `config/akm/config.json` | `/etc/akm/config.json` | Native operator AKM catalog, harnesses and task activation |

Normal user/project settings and hooks need no custom policy mount.
For an explicit system-level policy, operators can supply native files through
their existing Compose overlay. That optional policy is their choice and
maintenance responsibility, not an extra fhold requirement. Keep credentials
private, and mount individual system files rather than hiding the installed
native plugin directories.

Existing unused `config/opencode`, `config/codex` and `config/claude` policy
copies are not mounted by the default stack. They remain untouched; fhold does
not interpret or convert their historical beta syntax.

## Task permissions

OpenCode, Codex and Claude enforce their own native/operator permissions and
approval/consent. fhold does not force approval bypasses, impose shell command
denials or disable project, Claude-compatibility or external-skill discovery.

OpenCode's supported configuration includes native `permissions` and optional
system resource policies. Use the native documentation for policy precedence;
fhold adds no policy interpreter or format converter. Native user preferences
are editable under `config/assistant`; OpenCode's watcher applies ordinary
changes without a reload service.

Recurring tasks forward the operator's prompt unchanged and use native AKM harness
selection. `fhold-task create ... --harness <name>` selects an existing harness;
omitting it leaves selection to AKM. AKM owns scheduling and durable task history.
Portable imported task definitions remain paused until reviewed; that preservation
rule does not impose a tool ceiling on an approved native run.

Guardian is a separate authenticated ingress boundary. Its chat/read credential
ceilings, moderation, ownership and path containment remain enforced. Automatic
AKM context executes server-side, outside model tool checks, so limited
credentials do not receive private bundle/workflow/proposal context or write
learning implicitly. Guardian reapplies the current credential's authority
before every turn/interaction; full credentials inherit native AKM behavior.
Local custom agent names and mixed histories never determine eligibility.

## Hooks and MCP servers

AKM and fhold use one native plugin registration path per harness:

- OpenCode loads the pinned image registrations in `/etc/opencode/plugins`.
- Claude loads its installed native plugins.
- Codex loads its installed native plugins and requires native hook trust.

There are no duplicate system-managed handler copies and no managed-only
exclusion. User/project hooks and third-party native plugins remain available.
MCP configuration uses each platform's normal native settings; fhold does not
maintain a parallel MCP registry.

Use `/hooks` inside native Codex, or fhold's existing review UI/helper, to review
the exact native plugin commands. Only explicit operator consent writes their
native trusted hashes. Changed definitions need a fresh review; fhold neither
manufactures approvals nor approves unrelated hooks. Claude likewise retains
native plugin/workspace trust and consent.

AKM owns automatic recall, prompt learning and reviewable transcript proposals.
Native `AKM_AUTO_MEMORY` and `AKM_AUTO_LEARNING` options apply normally.
Fresh instances select the native `opencode` harness (`run --standalone`), which reuses
OpenCode's provider/model/auth. AKM owns its bounded utility agent and recursion
prevention; fhold adds no extraction subprocess wrapper or model pipeline.
The pinned Codex plugin has prompt learning but no SessionEnd extractor;
fhold does not invent unsupported parity.

The existing instance `assistant.automaticMemory=false` intent maps to both
native features off in managed Compose. Standalone `FH_AUTOMATIC_MEMORY` intent
also supplies native defaults; explicitly supplied native AKM options take
precedence. An operator overlay can set the native features independently.

## Startup, recovery and verification

Native plugin caches/default settings are seeded only when missing or still
untouched generated defaults. Account state, custom plugins, user settings and
hook decisions remain operator-owned. Nothing is installed at startup.
Optional AKM/worker failures report native diagnostics and do not stop the main
Assistant. Authentication, restore integrity and actual recovery ownership
remain essential boundaries.

Recovery preserves native account/settings state; it does not grant consent or
turn disabled native features on. Current image-baked plugin bytes still own
the built-in integration. Local image capability checks protect actual recovery
semantics, not a second task-policy compatibility layer.

Review native recall explicitly:

```sh
fhold-codex-recall.mjs review
fhold-codex-recall.mjs review --plugin=fhold@fhold-plugins
```

The result reports `approval-needed`, `ready` or `installed`, along with the exact
native definitions. Native hook approval, account sign-in, worker startup and
an actual remote request are separate observations.

## Existing beta installations

Updates preserve operator-owned `config/akm/config.json` byte for byte. They do
not convert an old engine or silently replace an explicit off setting. An
existing catalog may still select the removed product `scheduled` engine and
`fhold-opencode-run` launcher. Inspect the catalog inside Assistant with
`akm config list`. Review native AKM's migration plan before explicitly applying
it, then select the installed OpenCode harness when appropriate:

```sh
akm migrate status
akm migrate apply --dry-run
akm migrate apply
akm config set harnesses.opencode '{"args":["run","--standalone"]}'
```

Review the resulting catalog and task sources that explicitly name `scheduled`;
remove the obsolete harness and select the intended native harness before
running them. Native `akm migrate` owns format conversion and backups; fhold
does not run it automatically. Custom harness choices remain yours.
Without a usable harness/provider, native AKM reports an actionable error;
optional learning/tasks do not block the primary Assistant.

Ordinary updates archive removed, unchanged product agents/helpers under private
`state/retired-managed/<sha256>/` and remove those paths from native autoload.
Operator-modified or unknown files and archives are preserved with an update
warning/receipt entry for explicit review. There is no recursive directory
cleanup, historical agent emulation or configuration migration framework.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[OpenCode configuration](https://opencode.ai/docs/config/).
