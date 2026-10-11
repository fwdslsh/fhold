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
actions determine compatibility, not exact release-version equality. The machine
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

Initial remote management supports discovery, status, recent logs and lifecycle.
Installation, image updates, configuration/provider/native-worker setup and
import/export remain on the owning host's CLI. A loopback-only OpenCode API stays
loopback-only. To access it, use a native local SSH port forward with the instance's
configured port, for example `ssh -N -L 4810:127.0.0.1:3810 lab`, then open
`http://127.0.0.1:4810`. Its native authentication still applies. This release
does not manage tunnels or transfer native credentials.

## Azure Container Apps (experimental)

Install the native Azure CLI on this computer and explicitly sign in with
`az login`. Add a scoped connection; fhold never changes your global Azure account
selection and does not install extensions or create resources automatically.

```bash
fhold hosting add cloud --provider azure-container-apps \
  --subscription <subscription-uuid> --group <resource-group>
fhold hosting instances --connection cloud
fhold --connection cloud --name <app-name> status
fhold --connection cloud --name <app-name> logs
fhold --connection cloud --name <app-name> stop --confirm
fhold --connection cloud --name <app-name> start --confirm
```

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
client action and may wake it; native sign-in is still required. Logs default to
system logs, which do not require a live replica. Use `az containerapp logs show`
to select a specific revision/replica/container's console logs.

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

## Admin and shared preferences

Choose **Open another instance… → Open a hosted agent**, select a connection and
find instances. **Add a connection** offers the same SSH/ACA metadata as the CLI.
**Manage host connections…** is also available in the instance picker. The manager
offers Add, Edit, Check and Remove; SSH checks offer an explicitly confirmed
**Install / update remote CLI** action. Errors remain visible in the hosted-agent
picker, not hidden in the management sidebar. Display names, roots and SSH ports
can be edited. Changing a host or Azure scope requires confirmation, clears only
that connection's recent selections and closes its selected view. Removing a
connection forgets metadata only: no instance is stopped or deleted.

The same operations are available in the CLI:

```bash
fhold hosting edit lab --label 'Lab server' --roots '["/opt/stacks"]'
fhold hosting edit lab --host new-server --confirm
fhold hosting remove lab --confirm
```

Open one instance to view supported controls and recent logs. Unsupported settings
and transfer operations explain where to manage them rather than acting on a
local home. Lifecycle actions retain explicit confirmation. Status refreshes
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
