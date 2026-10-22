# Hosting and agent management verification

This record accompanies the [management architecture](../technical/hosting-agent-management-design.md).
It distinguishes library/transport evidence from actual hosting-platform behavior.
Verification date: October 22, 2026. No existing personal instance was used as a
disposable fixture and no Azure resources were created by this investigation.

## ACA native execution feasibility

The installed Azure CLI 2.91.0 implements `containerapp exec` as an interactive
console. Its `containerapp_ssh` function creates a WebSocket connection and starts
terminal reader/writer threads. The installed `_ssh_utils.get_stdin_writer` calls
`tty.setcbreak(sys.stdin.fileno())` on Linux without checking for a terminal.

A local, account-free experiment invoked that installed input-handler function
with stdin redirected from `/dev/null`. It printed:

```text
azure-cli=2.91.0
stdin_tty=False
noninteractive_writer=error: (25, 'Inappropriate ioctl for device')
```

This was a function-level test of the shipped Azure CLI, not a live Container App
test. It made no cloud requests and loaded no account credentials. Source review
also found that terminal output combines the remote stdout/stderr channels for
display. A reliably framed remote process exit result, long-lived private typed
stdin and cancellation were not established.

The official [container console guide](https://learn.microsoft.com/en-us/azure/container-apps/container-console)
documents an interactive terminal and choosing a custom executable already in the
image. The [upstream implementation](https://github.com/Azure/azure-cli/blob/dev/src/azure-cli/azure/cli/command_modules/containerapp/_ssh_utils.py)
illustrates that terminal behavior; the mutable upstream branch is not a version
pin for the local experiment.

Consequently, the supported native console is not qualified as an unattended
management transport. The refactor must not pipe secrets into command arguments,
scrape terminal prompts or add a generic image command on the assumption that the
console provides typed RPC. The ordinary explicit interactive console remains useful.

Authenticated native OpenCode HTTP access is independent of this limit. Its
account inventory/authentication and readiness operations can be bound through
the agent-management interface. Model/default and custom-endpoint writes still
require native watched preference documents, and custom endpoint model discovery
must run from the Assistant network. Claude/Codex guided setup requires the native
session process. Those operations need a separately qualified route before their
ACA capability can be enabled.

## Native CLI compatibility checks

In addition to synthetic wire tests, the retained released Linux x64 CLI
`0.3.261002-beta` was executed directly (artifact SHA-256
`129966cfd538a2af593ebf313bc92f1297f92943c78e1b6b7fafdb27d5890358`).
The released and new compiled CLIs each installed into a different generated
temporary home using `install --no-start`. No container was started.

| Check | Observed result |
| --- | --- |
| Released binary `hosting rpc` with version-1 `hello` | Advertised published actions and individual management methods. |
| New `SshInstanceManagement` client with its process factory bound to released `hosting session` | Passive snapshot returned the exact old test home and `setup_incomplete` phase; close ended the process. |
| New compiled `hosting session` receiving the published JSON-line `{id, homeDir, method:"snapshot", extra:[]}` envelope | Returned the matching request ID, exact new test home, compatible config and `setup_incomplete` phase. |

The process-factory check intentionally substitutes only the native transport
launcher, not domain operations or responses. It proves local stdin/stdout wire
compatibility with that released binary, not SSH authentication, live native
accounts or a real cloud environment. The existing RPC-only synthetic test also
retains a host that advertises no management session methods: status remains
usable without launching an unsupported persistent session.

## Implementation acceptance

The October 22 implementation uses typed composed host, agent, app and data
operations in CLI/Admin, one normalized snapshot and per-operation availability.
Standalone app permission editing no longer passes a Docker configuration through
the UI. Its concrete command adapter preserves the existing snapshot/saveConfig
wire contract and unrelated host intent. Public client links are whitelisted
separately from explicitly acquired agent access. Configured ACA image references
remain labelled configuration, not running-replica image observations.

Final local checks on the source-frozen implementation:

| Check | Result |
| --- | --- |
| `bun run check` | All six workspace typechecks passed. |
| `FH_SOCKET_TESTS=1 bun run test` | 1,009 passed, zero failed; five opt-in image-backed tests skipped. |
| Admin real-Chromium provider workflow | Passed, 298 assertions against the synthetic native API. No vendor account or billed inference. |
| `bun run lint` | Passed its configured gate; repository style warnings remain. This is not a warning-free lint claim. |
| CLI compile and Admin bundle | Both passed. |
| `bun run docs:test` | Both documentation tests passed. |
| Generated stopped test home: Compose `config --quiet`, all three profiles | Passed without starting containers. |
| `git diff --check` | Passed. |

Independent Terra architect and software-engineer reviews approved the final
solution. Their focused checks covered typed request/results, per-operation host
authority, normalized mutation replies, retained SSH compatibility, runtime
replacement, cancellation, late-result isolation, no replay, loaded-provider UI
retention and configured-versus-observed image provenance. Review findings were
fixed and regression-tested, including first-install setup, revision selection,
RPC-only remote status, recovery mutation rendering, app-policy editing and
one-click SSH access.

No dependency pins, runtime/image sources, backup formats or live deployments
changed. The skipped image tests and real ACA signal/storage/scale qualification
are not claimed by this tooling refactor. Dependency freshness and artifact/image
qualification remain the separately documented merge/release gates.

## Qualification boundaries

The implementation's shared contract tests establish operation dispatch, target
binding, independent optional failures, lifetime cleanup and presentation. Synthetic
HTTP/SSH/Azure fixtures do not establish native vendor sign-in, real cloud signal
delivery, scale-to-zero, persistence after replica replacement or exclusive recovery
ownership. Those remain explicit environment qualification tasks.

Do not infer a completed checkpoint or released owner from platform request
acceptance, zero replica count or successful revision provisioning. The existing
Assistant recovery engine remains authoritative for its own durability/ownership
facts. External deployment tooling retains provisioning and deployment-template
ownership.
