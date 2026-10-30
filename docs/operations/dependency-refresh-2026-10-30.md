# AKM update and Admin UI investigation — October 30, 2026

This is a targeted AKM update. Versions remain pinned in the Assistant image;
existing installations receive them through a container update, not a runtime
package upgrade.

| Dependency | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.261019 | 0.10.261020-beta |
| AKM OpenCode, Claude and Codex plugins | 0.10.261017 | 0.10.261018-beta |

These are the newest published releases on npm's `next` channel as reviewed on
October 30. The previous versions remain npm's stable `latest`. The beta is
selected deliberately to consume the upstream native plugin-health fix:
[AKM release](https://github.com/itlackey/akm/releases/tag/v0.10.261020-beta),
[plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261018-beta).
The plugin requires exactly the selected CLI version. AKM now uses Claude's
installation, scope and enabled metadata instead of guessing from cached versions.
It also fixes repeated fenced-code search bias and provides explicit native
channel switching; fhold does not invoke that updater at startup.

The Claude/Codex marketplace comes from immutable commit
`6fc29a5fc49390597c50ecf145d0193f99d943e6`, archive SHA-256
`ffc5d656451b23805e06674a256590c898e618ca99dca456bd21ef776044065e`.
Both native manifests report `0.10.261018-beta`. npm artifact integrity remains
in the root `bun.lock`. OpenCode 2.2.1 and Effect 4.0.1 are unchanged; the AKM
plugin still declares OpenCode SDK 2.1.4 as its peer, so the existing native
harness gates remain applicable. Unrelated dependencies are deferred.

Source validation and the existing image gates are recorded on the update PR.
The PR workflow supplies native image evidence; no duplicate release run or
signed-in, two-hour test is needed for this dependency change.

## Knowledge tab decision

Defer the embedded tab: the current native UI cannot be wired into Admin with
only a navigation item and iframe.

- `akm ui --no-open` starts a separate process, binds container loopback on a
  random port by default, and returns a private per-launch token URL. fhold
  currently exposes OpenCode's port, not an AKM UI endpoint. Admin would need to
  own the UI process and a private connection to the selected Assistant, including
  remote instances, and clean both up on instance switches and shutdown.
- AKM sends `frame-ancestors 'none'`, so a normal iframe is refused. Its API also
  validates Host, Origin and the session token. Stripping these protections is
  not an integration option. Electron's isolated `WebContentsView` could display
  the page without an iframe, but still requires new view and connection lifecycle
  handling; it does not solve access to the container's UI server.
- Starting a host-local `akm ui` would use the host's own configuration, paths and
  credentials. That does not represent the selected Assistant, especially over
  SSH or Azure, and is not a substitute.

The upstream contracts were inspected at the selected release:
[UI command](https://github.com/itlackey/akm/blob/v0.10.261020-beta/src/commands/ui/ui-cli.ts),
[server security and binding](https://github.com/itlackey/akm/blob/v0.10.261020-beta/src/commands/ui/server.ts).
Admin's native browser-opening flow for OpenCode already has a running service
and shared provider transport; AKM UI does not share that endpoint. No Admin,
Compose, port or authentication changes are included. A future separately scoped
integration should reuse the native UI and token checks with an explicit private
transport, rather than duplicate its API or expose a new public service.
