# Managing hosted instances

Local Docker remains the default. Installing fhold does not require SSH, Azure,
a saved hosting connection or changes to its containers. These adapters run in
the CLI/Admin on your computer; host management credentials never enter the
Assistant. Hosting accounts are separate from AI provider accounts, app access
keys and recovery storage credentials.

## Docker over SSH

The remote Docker host needs a fhold CLI with hosting support. Its release may
differ from your local tooling. fhold checks `~/.local/bin` as well as the native
noninteractive SSH PATH. Complete ordinary SSH authentication and
host-key review first, for example `ssh lab`. Native SSH configuration owns keys,
ports, jump hosts and known hosts; fhold never accepts host trust automatically.

```bash
fhold hosting add lab --provider ssh-docker --host lab --roots '["/opt/stacks"]'
fhold hosting check lab
# If the remote CLI is missing/old (only the CLI is replaced, no restart):
fhold hosting repair lab --confirm
fhold hosting instances --connection lab
fhold --connection lab --name agent status
fhold --connection lab --name /opt/stacks/agent logs
fhold --connection lab --name /opt/stacks/agent stop --confirm
fhold --connection lab --name /opt/stacks/agent start --confirm
fhold --connection lab --name /opt/stacks/agent restart --confirm
```

`--roots` is an optional JSON array of absolute remote directories. Discovery
uses managed Docker Compose working-directory labels, including stopped
containers. Each candidate must already be a valid fhold installation; unrelated
Compose projects are not adopted. Root discovery also checks each root, its
immediate children and their `home/` subfolders, without recursively scanning
user files. Without roots it additionally uses the remote account's
`~/fhold/instances`. Short selectors
match the discovered, persisted instance name; use an exact absolute directory
when names are ambiguous. Remote paths are never resolved against this computer,
and remote commands never override this computer's `FH_HOME`.

The remote CLI executes the existing lifecycle, lock, recovery drain, Compose
audit and pending-settings receipt paths. The wire envelope and advertised
actions determine compatibility, not exact release-version equality. An older
RPC-only CLI can still provide host status and supported lifecycle operations;
an unavailable session method disables only its named agent/app/data operation.
The machine
endpoint accepts one typed operation on stdin; it is not a network server or
arbitrary remote command runner. SSH failures do not replay a mutation.

`hosting check` reports SSH, remote CLI/protocol, Docker and discovery separately.
It never changes host trust or instance configuration. `hosting repair` downloads
the local tooling version's Linux x64/arm64 CLI and verifies the published checksum
before atomically installing it in `~/.local/bin/fhold`. It does not use sudo,
change shell startup files, install Docker, restart containers or touch homes.
For offline/private development, `--cli-file /path/to/trusted-linux-cli` accepts an
operator-supplied artifact instead; the remote staged binary must run successfully
and support hosting before replacement. Unpublished versions need this option.

SSH instances use the same Admin pages and operations as local instances:
Overview, Agent settings, Apps and System. You can install into a remote folder,
configure providers and apps, complete native sign-in, save changes with a deferred
restart, update images, view logs, and import/export. The owning host executes the
same shared operations; settings are never copied into a shadow home on this computer.

The normal CLI also works with `--connection lab --name agent`. For example:

```bash
fhold --connection lab --name new-agent install --no-start
fhold --connection lab --name agent config assistant --timezone America/Chicago --no-apply
fhold --connection lab --name agent setup
fhold --connection lab --name agent update
fhold --connection lab --name agent connect opencode --show-password
fhold --connection lab --name agent backup --to ./agent-export --full --confirm-stopped
fhold --connection lab --name /opt/stacks/restored-agent restore \
  --from ./agent-export --full --confirm-stopped --apply
```

Admin opens OpenCode through an automatic, loopback-only native SSH forward.
Keep Admin open while using that browser connection. Switching instances or closing
Admin closes its forward, not the agent. `connect` creates the equivalent forward
for CLI users: leave the command running and use Ctrl+C when finished. Authentication
still applies; passwords/keys are revealed only by explicit actions. The forward and
provider operations use the running container's published address, not an unapplied
port setting. A forwarding problem reports a connection error without disabling settings.

Backup destinations and import sources refer to folders on **this computer**.
The normal stopped-writer confirmation, empty-target requirement, preview and
checksum checks still apply. Transfer uses SCP for a private PAX archive, preserving
file contents, permissions, exact timestamps and symbolic links without following them.
GNU `tar` must be available on both Linux computers for archive creation. Temporary
transfer files are private and scoped to the open SSH session. File-valued CLI input
options (configuration, keys, tokens and selection files, including stdin `-`) are
staged privately on the remote host. Other native command paths, such as history
export destinations, refer to the remote filesystem.

New names install under the remote account's `~/fhold/instances`; an absolute
path chooses another directory. Admin provides a remote folder picker for remote
instance/recovery locations and a native local picker for export/import archives.

## Azure Container Apps (experimental)

Install the native Azure CLI on this computer and explicitly sign in with
`az login` or `fhold hosting login azure-container-apps`. In Admin, choose
**Settings → Host connections → Add connection → Azure Container Apps**. **Sign in
to Azure** opens the native browser flow; **Load subscriptions** uses an existing
login. Choose a subscription and resource group, then save the connection.
Add a scoped connection; fhold never changes your global Azure account
selection and does not install extensions or create resources automatically.

```bash
fhold hosting login azure-container-apps
fhold hosting scopes azure-container-apps
fhold hosting scopes azure-container-apps --subscription <subscription-uuid>
fhold hosting add cloud --provider azure-container-apps \
  --subscription <subscription-uuid> --group <resource-group>
fhold hosting check cloud
fhold hosting instances --connection cloud
fhold --connection cloud --name <app-name> status
fhold --connection cloud --name <app-name> logs
fhold --connection cloud --name <app-name> stop --confirm
fhold --connection cloud --name <app-name> start --confirm
fhold --connection cloud --name <app-name> restart --confirm
fhold --connection cloud --name <app-name> connect opencode
fhold --connection cloud --name <app-name> console
fhold --connection cloud --name <app-name> logs --type console --tail 100 \
  --revision <revision-name> --container <container-name>
```

The connection check names the failing layer: Azure CLI, sign-in, resource group,
or discovery. Sign in again or edit the connection to fix that layer; SSH repair
and instance-root advice do not apply to Azure. Native CLI/extension upgrades
remain explicit workstation operations, not hidden fhold installs.

Discovery lists apps in that resource group with an `fhold-assistant` image or
the deployment-owned tag `fhold=assistant`. Custom assistant images should use
the tag. Exact Container App ARM resource IDs also work with `--name`; jobs and
resources outside the saved subscription/resource group do not.
An explicitly selected unrecognized app remains inspect-only. Start/Stop require
the deployment's `fhold=assistant` declaration or a fhold-assistant image, checked
again when the action runs; fhold does not retag or adopt a foreign app.

Status shows native platform/revision observations, not a fabricated local
instance folder or Compose intent. Stopped and scaled-to-zero are distinct;
successful Azure provisioning is not verified agent readiness. Status checks
do not contact OpenCode or wake a zero-replica app. **Open OpenCode** is an explicit
client action and may wake it; native sign-in is still required. A platform-stopped
app needs **Start** first. Logs default to system logs, which do not require a
live replica. Admin lets you choose platform/agent logs, revision and container;
CLI additionally accepts `--replica`. Read-only refresh preserves that selection.
Console logs and interactive terminals need a running replica; fhold does not
silently start one to satisfy a read.

`console` opens the native [Azure container console](https://learn.microsoft.com/azure/container-apps/container-console)
with inherited terminal input/output. `--revision`, `--replica` and `--container`
select its target. No CLI is installed inside Assistant and no generated shell
script, stdin protocol or management port is added. Use ordinary image-baked
skills/commands there for Claude/Codex sign-in and agent diagnostics. Admin's
**Open deployment tools** link in System → Installation details provides the platform's own Console and deployment tools;
**Open OpenCode** provides the agent's native AI-account and chat interface.

**Restart** uses Azure's documented [revision restart](https://learn.microsoft.com/cli/azure/containerapp/revision#az-containerapp-revision-restart),
not Compose recreation, image replacement or settings application. The app must
have exactly one active revision; otherwise choose revisions using your deployment
tooling. CLI optionally binds confirmation to `--revision <name>` and refuses a
stale selection before sending the request. Restart interrupts active work and is
not proof of a completed checkpoint, vendor reconnect or runtime readiness.

Start/Stop use the documented [ARM Start](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/start?view=rest-resource-manager-containerapps-2026-07-01)
and [ARM Stop](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/stop?view=rest-resource-manager-containerapps-2026-07-01)
APIs through native `az rest`, never scale-setting edits or revision deactivation.
The result is **accepted/pending**, not proof of replica drain or agent readiness.
The adapter does not consume long-running-operation headers or claim completed
shutdown; inspect the platform with your deployment tooling before replacing
writers. Lost transport does not retry the POST. ACA lifecycle is experimental
until live platform qualification; adapter tests do not establish actual signal,
storage or scale-to-zero behavior.

No ACA deployment editing, image upgrade/recreate, provisioning, mount/secret
management, portable/full-instance transfer or local Admin setup is exposed.
External deployment tooling owns these. Runtime recovery remains entirely with
the existing Assistant: no host-side Blob reader, new recovery gate, automatic
unlock or ownership fallback is introduced. Ordered stop/drain/replacement is an
external responsibility; there is no rolling-update shortcut.

Admin uses the same Overview, Agent settings, Apps and System pages for local,
SSH and cloud instances. Unsupported features remain visible but disabled, with
the reason next to their controls. For example, native preference-file writes, app setup,
import/export and checkpoint editing cannot be managed through this adapter yet;
their disabled sections do not mean those features are disabled inside the agent.
Use OpenCode or your deployment tools where indicated. System holds recent logs
and deployment details for every connection. Status checks and browsing these
pages do not contact or wake an idle agent.

### Explicit native agent access

Agent settings has a **Connect to agent** action. For HTTPS ingress, enter the
existing native OpenCode password. This is separate from Azure sign-in and is
kept only for the selected session, not in host connections, recents or backups.
Connecting is explicit and can wake an idle replica. Closing Admin or switching
instances discards the credential and pending native auth attempt, not the agent.

Once connected, native AI-account inventory, API-key sign-in, supported browser
OAuth and a real no-tool model test use the same agent operations as Docker
hosts. A model test is an explicit provider request and can incur provider usage.
HTTPS account writes and tests require one identifiable active running runtime;
runtime replacement requires reconnecting rather than reusing an old OAuth code.

The CLI supports this HTTP subset without putting secrets in command arguments:

```bash
fhold --connection cloud --name <app-name> provider list --password-file /private/opencode-password
fhold --connection cloud --name <app-name> provider key <provider-id> \
  --password-file /private/opencode-password --key-file /private/provider-key
fhold --connection cloud --name <app-name> provider login <provider-id> \
  --password-file /private/opencode-password --method <native-method-index>
fhold --connection cloud --name <app-name> provider test <provider-id> \
  --password-file /private/opencode-password --model <model-id>
```

`--password-file -` reads stdin; do not use stdin for both password and API key.
Code-based OAuth requires an interactive terminal and keeps the original native
attempt alive in that command. Providers with extra sign-in fields can use Admin
or OpenCode. These commands close their session when finished. They do not
provision an app or activate new deployment settings.

Default-model/custom-endpoint preference edits still require a qualified owned
file route; HTTPS is not a writable settings API. Guided Claude/Codex setup,
Guardian/Portal configuration and archive/recovery management remain unavailable
through ACA. Their existing runtime features still work when configured through
deployment tools or the native agent interface. See the
[transport investigation](operations/hosting-agent-management-verification.md).
The [qualification record](operations/azure-management-verification.md) separates
live read-only checks from adapter tests and unperformed cloud mutations.

## Admin and shared preferences

Choose **Open another instance…**, then select a **Location**. On first launch,
use **Open an instance…**. Instances are discovered automatically; the folder
action opens an unlisted local/SSH installation. Browsing keeps the selected
instance and unsaved drafts intact; Back returns without a switch. **Settings →
Host connections** offers the same SSH/ACA metadata as the CLI. Settings is
available from Welcome and the management sidebar, without selecting an instance.
The instance picker contains only recent instances and Open another instance. The page
offers Add, Edit, Check and Remove; **Open instances** browses that host. SSH checks offer an explicitly confirmed
**Install / update remote CLI** action. Errors remain visible in the hosted-agent
picker, not hidden in the management sidebar. Display names, roots and SSH ports
can be edited. Changing a host or Azure scope requires confirmation, clears only
that connection's recent selections and closes its selected view. Removing a
connection forgets metadata only: no instance is stopped or deleted.
**New assistant** and **Import assistant…** start separate workflows on the
selected location; neither action silently opens or starts an existing instance.
Older host CLIs may not report image versions. Overview explains this and links
to host connections; explicitly update the remote CLI, then reopen the instance.
It reports the host CLI's bundled update image, never the desktop app's version.

The same operations are available in the CLI:

```bash
fhold hosting edit lab --label 'Lab server' --roots '["/opt/stacks"]'
fhold hosting edit lab --host new-server --confirm
fhold hosting remove lab --confirm
```

Open an SSH instance to use the normal Admin pages; no manual tunnel is needed.
ACA shows its native platform controls, revision/log selectors and direct access
links, with explicit explanations for unsupported
operations, never substitutes a local home. Lifecycle actions retain explicit confirmation. Status refreshes
automatically without waking the agent; switching never changes window size or
starts/stops an instance.

The shared host preference file is `$XDG_CONFIG_HOME/fhold/hosting.json`, default
`~/.config/fhold/hosting.json` on Linux. It contains connection locators and recent
targets, not credentials, copied instance settings or a registry of authoritative
instances. It is outside instance backups. Existing Admin local-folder recents
are read without changing them, then brought into this file on the next explicit
selection. A corrupt preference file is reported without stopping local management
or overwriting that file automatically. Native SSH/Azure failures affect their
connection, not local Docker or other connections.

Local Docker operations use the current native Unix/named-pipe endpoint, including
Desktop/rootless contexts, pinned per subprocess without changing the global
context. A remote daemon/context cannot receive local bind paths: select an SSH
connection instead. Explicit alternate `FH_DOCKER_BIN` transports remain
operator-owned.

See the [hosting architecture](technical/hosting-provider-architecture.md) for
the boundary and deferred feature-parity/qualification work.
