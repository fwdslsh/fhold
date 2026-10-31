# Managing hosted instances

Local Docker remains the default. Installing fhold does not require SSH, Azure,
a saved hosting connection or changes to its containers. These adapters run in
the CLI/Admin on your computer; host management credentials never enter the
Assistant. Hosting accounts are separate from AI provider accounts, app access
keys and recovery storage credentials.

## Docker over SSH

The remote Docker host needs Linux x64 or arm64, Docker/Compose and standard
shell utilities (`uname`, `sha256sum`, `mktemp`). No installed fhold CLI is needed.
The local CLI/Admin automatically supplies its exact management executable and
embedded managed files through SSH, without using or replacing a remote CLI.
Complete ordinary SSH authentication and
host-key review first, for example `ssh lab`. Native SSH configuration owns keys,
ports, jump hosts and known hosts; fhold never accepts host trust automatically.

```bash
fhold hosting add lab --provider ssh-docker --host lab --roots '["/opt/stacks"]'
fhold hosting check lab
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

The private management executable executes the existing lifecycle, lock, recovery drain, Compose
parsing and pending-settings receipt paths. Compose policy recommendations are
optional `fhold doctor` diagnostics, not lifecycle gates. Updating local tooling
selects its matching management bytes on the next connection. This does not update
an operator-installed CLI or change an instance until you request an operation.
The machine
endpoint accepts one typed operation on stdin; it is not a network server or
arbitrary remote command runner. SSH failures do not replay a mutation.

`hosting check` reports SSH, management helper/protocol, Docker and discovery
separately. It may populate the private executable cache but never changes host
trust or instance configuration. Cache preparation uses no sudo, shell startup
changes, release downloads, container operations or instance-home writes.

Both standalone CLI and Admin ship Linux x64 and arm64 helpers compiled from the
same source and embedded Skeleton as the local build, including unpublished PR
previews. Helpers are the existing CLI, not another protocol implementation.
The outer CLI compresses these resources; helpers do not recursively contain
other architectures. The target architecture comes from remote `uname -sm`.
The SHA-256 of the executable selects
`${XDG_CACHE_HOME:-$HOME/.cache}/fhold/management/<sha256>/fhold` on that host.
Each connection verifies the cached bytes and executability; cache hits reuse
them. Missing or corrupt entries are streamed into unique private staging files,
hashed, checked with `--version`, then atomically renamed. Concurrent clients
install the same immutable content, with no mutable current-version link. Failed
transfers leave the operator CLI and instance unchanged and never fall back to
PATH. Old content-addressed entries are retained; they may be removed manually
when no management session uses them. A noexec or unwritable cache requires
operator correction; fhold never changes mount permissions or uses another home.

Source development uses the normal `bun run packages/cli/src/main.ts` entrypoint;
run `bun run --cwd packages/cli build:helpers` after source changes first. Shipping
CLI and Admin builds always regenerate both helpers from their current source.

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
the optional discovery tag `fhold=assistant`. Custom images can use the tag or
be selected by exact Container App ARM resource ID with `--name`; jobs and
resources outside the saved subscription/resource group do not.
Management requires the selected resource to remain within the saved connection's scope. Discovery
labels are conveniences, not management-ownership claims: an explicitly selected
Container App can be managed without retagging or adopting it. Native agent
features still require a compatible running Assistant and authenticated access.

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
select its target. No Azure CLI is installed inside Assistant and no generated shell
script, stdin protocol or management port is added. Use ordinary image-baked
skills/commands there for Claude/Codex sign-in and agent diagnostics. Admin's
**Open deployment tools** link in System → Installation details provides the platform's own Console and deployment tools;
**Open OpenCode** provides the agent's native AI-account and chat interface.

**Restart** performs a completed app Stop followed by Start. It does not apply a
pending deployment draft or replace an image. This affects the selected app, not
only one revision. If CLI supplies `--revision <name>`, that selection must still
be active before the app-level operation begins. Restart interrupts active work;
native recovery status, vendor reconnect and runtime readiness are separate checks.

Start/Stop use the documented [ARM Start](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/start?view=rest-resource-manager-containerapps-2026-07-01)
and [ARM Stop](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/stop?view=rest-resource-manager-containerapps-2026-07-01)
APIs through the official Azure SDK, never scale-setting edits or revision
deactivation. Native long-running operations are observed to completion; a lost
observation retains its continuation instead of replaying the POST. Azure
completion does not independently prove a final recovery checkpoint or native
agent readiness. ACA lifecycle remains experimental until live platform
qualification; adapter tests do not establish actual signal, storage or
scale-to-zero behavior.

### Install and manage through the same wizard

Choose **New assistant** on the cloud connection. The shared Install → Connect →
Ready wizard asks for a name, environment and availability. New environment and
storage names are suggested and remain editable. Advanced holds region, storage,
timezone, CPU/memory, image and optional independent Files mounts. Each mount
names existing environment storage and its absolute mount path; it is not the
Assistant's native SQLite recovery store. Shared folders need their own backup.

**Review installation** lists the exact image, resources to create or reuse, and
recovery/cost warnings without creating resources. Installation requires a second,
explicit confirmation. **Always running** is the default; fresh **On demand**
installation disables user scheduling. Outbound Claude/Codex connections cannot
wake a zero-replica app. Changing availability later does not silently change the
scheduling preference.

Deployment settings keep image selection separate from Assistant preferences:
timezone, scheduling, native workers and recovery always affect the Assistant,
not a selected sidecar image. If the Assistant cannot be identified uniquely,
those fields remain disabled; explicit image updates still work. An Update
request does not silently apply a saved draft: apply or discard it first.
Correcting a failed apply retains the original running/stopped intent. Discard
does not undo an already applied update or restart an interrupted instance;
use **Start** explicitly when ready.

Initialization Jobs attach the Assistant's independent Files mounts so the
runtime sees the same required mount policy. Native API credentials and
unrelated service secrets are not included. Reused environments use Azure's
default workload placement rather than assuming a named profile exists; this
also supports legacy consumption-only environments.

The CLI uses the same typed connection-level workflow:

```bash
fhold hosting options --connection cloud
fhold hosting preview --connection cloud --input placement.json
fhold hosting install --connection cloud --input placement.json --confirm
fhold hosting resume --connection cloud --reference <returned-reference> --confirm
```

`placement.json` describes placement, not credentials. Use the options response
for the current region, exact bundled image, timezone and existing resource choices:

```json
{
  "kind": "azure-container-apps",
  "name": "personal-agent",
  "location": "centralus",
  "environment": { "name": "personal-agent-env", "create": true },
  "storage": { "name": "youruniquestorageaccount", "create": true },
  "availability": "always",
  "timezone": "America/Chicago"
}
```

Initialization uses a temporary native Container Apps Job, private Blob recovery,
managed identity and the reviewed runtime image. Failed jobs remain inspectable.
Closing Admin after submission stops observation, not accepted Azure work, and
does not delete created resources. Saved continuations stay bound to their
connection and target. Ordinary **Inspect and continue** observes existing work;
it does not resubmit a failed step. After inspecting and correcting a confirmed
infrastructure, initialization or app-deployment failure, **Retry failed step**
requires separate confirmation. CLI users add `--retry-failed-step` to the
confirmed `hosting resume` command. A retry reapplies the original reviewed
placement, which is retained without credentials alongside the continuation.
Unknown outcomes are not permission to replay installation or initialization.

Deployment completion opens the ordinary Connect stage; it is not model-provider
or native-worker readiness. A real native no-tool response is still required.

All providers use **System → Deployment settings** for supported image, timezone
and native worker-startup changes. Load settings, choose changes and save them.
The draft stays on this computer, bound to the selected target. **Later** changes
neither the instance files nor the running deployment. **Discard pending changes**
removes only this draft, not settings already saved to the instance by other
operations or an earlier failed apply. **Apply changes** always uses the same
confirmation and postponement flow, with an explanation of the host's effect.
Docker starts/recreates containers through its existing lifecycle path; Azure
updates its deployment and preserves the final stopped state when applicable.

Local and SSH Docker use the same editor and intent-saving implementation.
Docker image edits select a new tag in the current component repository; the
Portal pin is shared by Discord and Slack. Operator custom Compose overrides
remain authoritative and unchanged. Scale-to-zero and scheduler overrides are
not exposed by the Docker settings API: their controls remain visible, disabled
and explained (scheduling overrides still use custom Compose). Azure supports
these controls through native deployment fields. No new runtime feature or
configuration store inside an instance is introduced.

On Azure, **Apply changes** requires confirmation;
the adapter preserves unrelated fields and reports submitted, in-progress,
completed, failed or unknown outcomes without treating request acceptance as
runtime readiness. Availability, a selected container's image and allowlisted
native startup preferences are supported; there is no arbitrary secret editor.
Custom images need an explicit replacement reference. Overview distinguishes
configured/observed image references from the managing tool's update candidate.

```bash
fhold --connection cloud --name <app-name> update --confirm
fhold --connection cloud --name <app-name> update --confirm \
  --container assistant --image <exact-image-reference>
fhold --connection cloud --name <app-name> setup \
  --password-file /private/opencode-password --provider <provider-id> --model <model-id>
```

Update/apply follows the shared deployment operation and ordered replacement
steps; it is not a rolling-update shortcut. The provider completes Stop before
patching a running app, then starts it again. An initially stopped app is left
stopped after application; Azure may briefly activate a new revision while
applying a template update, so applying is not a promise of zero execution.
A pending/unknown operation retains its native reference for inspection.
Native runtime recovery remains the
Assistant's existing implementation: no host-side Blob reader, automatic unlock
or ownership fallback is added. Portable/full-instance transfer is not exposed
for ACA.

Admin uses the same Overview, Agent settings, Apps and System pages for local,
SSH and cloud instances. Unsupported features remain visible but disabled, with
the reason next to their controls. Native preferences, remote-worker controls and
recovery settings use qualified native routes where available. Unsupported app
setup and import/export do not imply those runtime features are disabled.
Use OpenCode or deployment tools where indicated. System holds recent logs
and deployment details for every connection. Status checks and browsing these
pages do not contact or wake an idle agent.

### Explicit native agent access

Agent settings has a **Connect to agent** action. For HTTPS ingress, enter the
existing native OpenCode password if automatic resolution is unavailable. A denied
secret read leaves a manual password fallback; it does not require broadening
your Azure permissions. This is separate from Azure sign-in and is
kept only for the selected session, not in host connections, recents or backups.
Connecting is explicit and can wake an idle replica. Closing Admin or switching
instances discards the credential and pending native auth attempt, not the agent.

Once connected, native AI-account inventory, API-key sign-in, supported browser
OAuth and a real no-tool model test use the same agent operations as Docker
hosts. A model test is an explicit provider request and can incur provider usage.
HTTPS account writes and tests require one identifiable active running runtime;
runtime replacement requires reconnecting rather than reusing an old OAuth code.

The CLI supports the shared native operations without putting secrets in command arguments:

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

Default-model/custom-endpoint preference edits use the qualified native PTY route
over authenticated HTTPS; there is no separate settings API or management server.
Worker sign-in and trust remain
explicit native actions, separate from startup flags or process status. Recovery
coverage/settings use the same System controls when the native route is available;
no credential is put into the saved deployment draft. Guardian/Portal deployment
editing and portable/full-instance archive transfer remain unavailable through ACA.
See the
[transport investigation](operations/hosting-agent-management-verification.md).
The [qualification record](operations/azure-management-verification.md) separates
live read-only checks from adapter tests and unperformed cloud mutations.
The new provisioning, replacement, native access and recovery UI paths have
mock/unit/browser coverage, not live Azure end-to-end qualification. No claim is
made that these tests establish Azure identity propagation, storage behavior,
shutdown timing, real provider sign-in or paid inference readiness. ACA remains
experimental until those live checks are explicitly performed.

## Admin and shared preferences

Choose **Open another instance…**, then select a **Location**. On first launch,
use **Open an instance…**. Instances are discovered automatically; the folder
action opens an unlisted local/SSH installation. Browsing keeps the selected
instance and unsaved drafts intact; Back returns without a switch. **Settings →
Host connections** offers the same SSH/ACA metadata as the CLI. Settings is
available from Welcome and the management sidebar, without selecting an instance.
The instance picker contains only recent instances and Open another instance. The page
offers Add, Edit, Check and Remove; **Open instances** browses that host. SSH
checks automatically prepare the matching private helper. Errors remain visible in the hosted-agent
picker, not hidden in the management sidebar. Display names, roots and SSH ports
can be edited. Changing a host or Azure scope requires confirmation, clears only
that connection's recent selections and closes its selected view. Removing a
connection forgets metadata only: no instance is stopped or deleted.
**New assistant** and **Import assistant…** start separate workflows on the
selected location; neither action silently opens or starts an existing instance.
Overview reports the managing helper's bundled update image, never inferring an
image tag from the desktop application's version or an installed remote CLI.

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
