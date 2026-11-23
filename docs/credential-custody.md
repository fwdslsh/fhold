# Experimental task-only credential access

This Docker-only MVP lets an Assistant invoke an operator-approved AKM task
without reading its credential files. It uses the image's ordinary AKM CLI,
native sudo rules, and a separate Linux user. There is no new service, proxy,
secret format or task runner. Admin manages the existing native files through
its host administration connection. The interfaces may change or be
removed. It is not enabled by default and is not qualified on ACA.

The default Assistant identity is `fhold` (UID/GID 1000). The private identity is
`fhold-credentials` (UID/GID 1101), with home `/var/lib/fhold-credentials` and no
login shell. This MVP supports those identities only. Do not run Assistant as
UID 1101 or share that UID with untrusted processes. All image editions contain
the account and sudo, but no task grants are baked into the image.

Only credentials placed in this private AKM home are protected by this boundary.
OpenCode, Codex, Claude Code and the Assistant's own OS keyring keep their native
auth handling. Their agent-readable credentials do not become protected.

## Which credentials belong here

| Credential | Current owner and boundary | Use this private task home? |
| --- | --- | --- |
| Token for an operator-approved task | Private AKM account; Assistant can invoke only its exact granted task | Yes, after reviewing the task and arranging private backup coverage. |
| Discord or Slack bot token | The corresponding Portal container, outside Assistant | No. Keep its existing Portal-only mount; copying it into Assistant would expand its exposure. |
| Portal-to-Guardian access keys | Adapter-scoped Portal mounts and Guardian's credential store | No. Preserve the existing service boundary. |
| OpenCode provider credentials | OpenCode's native credential database, owned by the Assistant user | Not with this MVP. Moving the files to the task account breaks native provider access; copying them leaves the original readable. |
| Codex or Claude Code sign-in | The harness's native authentication store | Not with this MVP. Keep native sign-in and do not represent task isolation as harness credential isolation. |

A successful synthetic probe proves the task boundary, not migration of these
other credentials. Provision real task credentials only for a specific reviewed
operation. An approved script can disclose a credential deliberately, so review
its destinations and output as well as its local file access.

## Enable on a disposable instance first

Build this branch's image and select its tag using the normal fhold image
settings. Merge [the example overlay](examples/credential-custody.compose.yml)
into that instance's `config/stack/custom.compose.yml`, preserving existing
customizations. Docker Compose 2.24.4 or later is required for `!override`.
Apply the overlay using the normal instance restart/recreate flow.

The overlay keeps `cap_drop: [ALL]`, adds only `SETUID` and `SETGID`, and disables
`no-new-privileges` so sudo can change identity. This trades some container
hardening for separation of credential ownership. It mounts two private named
volumes: the credential home and root-owned sudo policy. It does not grant
general sudo, mount the Docker socket or run the Assistant as root.

For the commands below, use Bash and host-side `jq` to select the persisted
instance project explicitly. Check its actual identity before provisioning:

```sh
export FH_HOME=/absolute/path/to/disposable-instance
dc() {
  local project
  project="$(jq -er '.deployment.projectName | strings | select(length > 0)' "$FH_HOME/state/stack.json")" || return
  docker compose --project-name "$project" --project-directory "$FH_HOME/system/stack" \
    --env-file "$FH_HOME/state/stack.env" \
    -f "$FH_HOME/system/stack/stack.compose.yml" \
    -f "$FH_HOME/config/stack/custom.compose.yml" "$@"
}
cred() {
  dc exec -T --user 1101:1101 --workdir /var/lib/fhold-credentials assistant /usr/bin/env -i \
    HOME=/var/lib/fhold-credentials PATH=/usr/local/bin:/usr/bin:/bin "$@"
}
test "$(dc exec -T assistant /usr/bin/id -u):$(dc exec -T assistant /usr/bin/id -g)" = '1000:1000' || {
  printf 'Unsupported Assistant identity; stop before provisioning credentials.\n' >&2
  exit 1
}
cred akm setup --yes --no-probe --embedding off --dir /var/lib/fhold-credentials/akm
```

`cred` is an operator-side convenience for Docker administration. It is not an
Assistant tool or a new credential execution wrapper. Its clean environment
keeps the Assistant's AKM locations out of the private user's setup. Keep the
absolute `/usr/bin/env` and private working directory: the Assistant can replace
commands in its own PATH or put runtime preloads in `/work`. Operator commands
must not execute either of those as the private user or root.

AKM's daily anonymous usage reporting defaults to on for this separate account
too. Its setting is independent of the Assistant's embedded AKM UI. To opt this
account out after setup, use the operator-side helper above:

```sh
cred akm config set usage.report false
cred akm config get usage.report
```

Set it to `true` to opt back in. The choice lives in the private home and survives
container replacement; it does not change local usage capture or task grants.

## Provision a synthetic proof task

### Admin

With the overlay enabled and Assistant running, open **System → Private task
access → Load private task access**. This experimental panel works with local
Docker and SSH-managed Docker; it is unavailable for ACA.

1. Enter a credential name and value. **Save credential** sends it over the
   existing host transport and Docker stdin to native `akm secret set`. It
   initializes the private AKM home if needed. The password field clears on
   submission, including failure, and values are never returned in snapshots,
   logs or a reveal action. Saving the same name rotates its value for all
   tasks using that name.
2. Create a new task draft with a credential name and a shell script beginning
   with `#!/bin/sh`. The native AKM V5 task binds that credential to `CREDENTIAL`
   for its single script step. Never paste the credential value into the script.
3. Review the exact saved task and script, check the review acknowledgement,
   and choose **Approve task**. A changed definition requires another review.
   Before writing the grant, Admin runs native `akm doctor explain` as the
   private account. AKM validates the task and its referenced
   assets without executing it. A validation failure or timeout prevents the
   grant; repair the references and review again. Diagnostic output is not
   returned to Admin because it may contain private details. This check does
   not establish that the script is safe or that a remote service will accept
   its credential; the operator still reviews its behavior. Native CLI usage
   bookkeeping follows that account's settings. Unlike `akm doctor` health
   inspection, `doctor explain` does not accept a `--read-only` flag.
   Copy the displayed command to the Assistant. Approval permits repeated use.
4. **Revoke task access** removes the native sudo grant for future invocations;
   it does not terminate already-running tasks or delete credentials.
   The task list also offers revocation when a definition or script is missing
   or unreadable, so damaged task files do not prevent removing a grant.

Admin-created native task/script names have an `admin-` prefix. Existing manual
tasks and grants are preserved and managed separately. Draft names are immutable:
use a new name for revised code and revoke the prior grant. This first panel does
not enable the overlay, restart containers, migrate ordinary credentials, or add
encryption or backup coverage. The restrictions and recovery exclusions below
still apply. Trusted Admin/host processes necessarily handle credential entry;
the boundary protects it from the Assistant, not from a compromised host.

### Operator terminal

Start with a fake credential. Do not put a real value in command arguments,
prompts, shell history, a task definition or this example script.

```sh
printf '%s' 'synthetic-custody-token' | cred akm secret set secrets/probe
cred sh -eu -c 'mkdir -p "$HOME/akm/scripts" "$HOME/akm/tasks"'
cred sh -eu -c 'cat > "$HOME/akm/scripts/probe.sh"; chmod 700 "$HOME/akm/scripts/probe.sh"' <<'SCRIPT'
#!/bin/sh
set -eu
test -n "${TOKEN:-}"
printf 'Credential available to the approved task.\n'
SCRIPT
cred sh -eu -c 'cat > "$HOME/akm/tasks/probe.yml"' <<'TASK'
version: 5-beta.1
steps:
  - name: probe
    run: scripts/probe.sh
    secret: [secrets/probe:TOKEN]
TASK
```

The operator reviews the entire task and its scripts, destinations, dependencies
and input handling. Never execute agent-writable code, load its configuration,
or use caller-selected network destinations in a credential-bearing step.
Do not put credentials on agent/prompt steps or task-wide environment bindings.
Known-value redaction is useful, but it does not stop a trusted script deliberately
encoding or sending a token elsewhere. A task grant permits repeated use.

Install an exact native sudo rule as the operator:

```sh
dc exec -T --user 0 --workdir / assistant /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/bin /bin/sh -eu -c '
  umask 077
  candidate=$(mktemp /etc/sudoers.d/.fhold-credentials.XXXXXX)
  trap '\''rm -f "$candidate"'\'' EXIT
  cat > "$candidate"
  chmod 0440 "$candidate"
  /usr/sbin/visudo -cf "$candidate"
  mv -f "$candidate" /etc/sudoers.d/fhold-credentials
  /usr/sbin/visudo -cf /etc/sudoers
' <<'POLICY'
Defaults:fhold env_reset
fhold ALL=(fhold-credentials) CWD=/var/lib/fhold-credentials NOPASSWD: NOSETENV: /usr/local/bin/akm run tasks/probe
POLICY
```

The candidate is validated before replacing the active rule. The root-owned
policy volume is outside Assistant's writable home. **Keep the
fixed `CWD=`:** a caller-controlled working directory can load runtime startup
configuration before AKM applies task bindings or redaction. Do not allow
`sudo -D`, `SETENV`, wildcard command arguments, a general shell or arbitrary
AKM commands. Native sudo argument regex can support narrowly validated inputs
later; the first example deliberately authorizes one fixed task.

The Assistant can now invoke this from a native shell tool or scheduled job:

```sh
sudo -n -H -u fhold-credentials /usr/local/bin/akm run tasks/probe
```

It should succeed. These Assistant commands should fail:

```sh
cat /var/lib/fhold-credentials/akm/secrets/probe
sudo -n -H -u fhold-credentials /usr/local/bin/akm secret list
sudo -n -H -u fhold-credentials /usr/local/bin/akm run tasks/probe --cwd /work
sudo -n sh
```

Native harness consent still applies. No AKM plugin read-only setting, shell
deny list, automatic approval, or restriction on ordinary Assistant memory/tasks
is installed. The private AKM environment has no configured agent program.

## Persistence and disabling

Container replacement preserves the named credential and policy volumes. Stop
new credential jobs and let active ones finish before changing grants or removing
the overlay. Recreate the service with the ordinary config to restore the normal
capability/no-new-privileges settings. Keep both volumes; disabling is not deletion
or a migration of secrets into the Assistant. Re-enabling reattaches the same data.
Never use `docker compose down -v` unless intentionally deleting those volumes.

This MVP stores native AKM secret files as plaintext with private ownership.
The existing GNOME keyring does **not** encrypt these AKM assets. The separate
encrypted-file/tmpfs approach has been investigated, but automatic unlock and
encrypted AKM storage are not implemented here.

An unlocked keyring available to the Assistant user does not provide this
separate-user boundary. Mounting a desktop wallet file also does not make it a
native AKM secret store: AKM currently resolves these assets as files. Do not
expose the host's session bus or personal keyring to Assistant to bridge that gap.
Native host storage encryption can protect the underlying volume at rest, but
its unlock, unattended-start and backup arrangements must be established by the
host operator. It does not remove the need for the private runtime identity or
protect values from a trusted host administrator.

These two volumes are **outside fhold's automatic recovery and full-instance
export**. The Assistant cannot read the private home, and its recovery process
must not gain that permission. Until dedicated recovery integration is designed,
back up both volumes separately using trusted host tooling while credential tasks
are stopped; preserve UID/GID, modes and native policy. Review restored task grants
before use. Backups contain plaintext secrets and must remain private. This MVP
does not migrate, rotate or remove credentials already in an agent-readable store
or an older backup. Do not adopt it for irreplaceable credentials without that
independent backup plan.

## Verify an image

```sh
node scripts/smoke-credential-custody.mjs IMAGE
```

The smoke uses the actual Compose overlay and published AKM package in the image,
disposable named volumes and synthetic credentials. It checks default-off behavior,
the documented operator commands against hostile PATH/preload files, persisted
project selection, direct-read/tamper/argument/environment/cwd attacks, native
OpenCode and scheduled execution, and persistence across replacement. It makes no model requests or
changes to existing instances. Run it on both Slim and AIO.
