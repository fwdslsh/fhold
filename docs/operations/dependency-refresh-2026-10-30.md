# AKM update and Admin UI investigation — October 30, 2026

This updates AKM and the supported Azure Identity security fix for beta12.
Versions remain pinned in the Assistant image;
existing installations receive them through a container update, not a runtime
package upgrade.

| Dependency | Previous | Selected |
| --- | --- | --- |
| AKM CLI | 0.10.261019 | 0.10.261021 stable |
| AKM OpenCode, Claude and Codex plugins | 0.10.261017 | 0.10.261019 stable |
| Azure Identity / MSAL Node | 4.14.0 / 6.0.1 | 4.14.1 / 7.1.2 |

These are the newest published stable releases on npm's `latest` channel as
reviewed on October 30, replacing the earlier unpublished beta selection:
[AKM release](https://github.com/itlackey/akm/releases/tag/v0.10.261021),
[plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261019).
The plugin requires exactly the selected CLI version. AKM now uses Claude's
installation, scope and enabled metadata instead of guessing from cached versions.
It also fixes repeated fenced-code search bias and provides explicit native
channel switching; fhold does not invoke that updater at startup. The stable
release additionally fixes optional health failures, type-directory advisories,
transport timeouts, writable bundle promotion, path redaction and usage metrics.
fhold does not consume the removed `usage.selectRate` metrics JSON field.

The Claude/Codex marketplace comes from immutable commit
`fdef6c893ebfc855e70fdce5c9e8e842a1d53b69`, archive SHA-256
`9a73656529498c89d0cb00142320edbede6229be8f28d60833563c101b96b8e7`.
Both native manifests report `0.10.261019`. npm artifact integrity remains
in the root `bun.lock`. OpenCode 2.2.1 and Effect 4.0.1 are unchanged; the AKM
plugin still declares OpenCode SDK 2.1.4 as its peer, so the existing native
harness gates remain applicable.

Azure Identity 4.14.1 now supports MSAL Node `^7.1.0`; the lock resolves 7.1.2.
Remove GHSA-xcx6-jx8p-x3h5 / CVE-2026-109461 from source and image exceptions.
Native Blob recovery gates qualify the supported chain. MCPB 2.1.2 still owns
Zod 3.25.76, and npm 12.2.1 still owns Undici 6.29.0; their existing approved
exceptions and November 6 deadline remain unchanged.

The full release review covered all workspaces/overrides, marketplace manifests,
image/compiler bases, CI actions/scanner and docs dependencies. Bun 1.4.4,
Node 26.13.0, npm 12.2.1, Go 1.27.3, Supercronic 0.2.51, workflow actions and docs
dependencies remain current at review. Noncritical Claude 2.1.314, Codex 0.166.0,
OpenCode 2.2.4 and Electron 45.2.0 updates are deferred to a separate batch.
Effect 4.1.0 remains held for the selected SDK's 4.0.1 peer contract.

Source validation and the existing image gates are recorded on the update PR.
One stamped canonical candidate supplies native image and retained-artifact
evidence for the PR and publication; no duplicate release build or
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

The upstream contracts were inspected at the initial beta selection:
[UI command](https://github.com/itlackey/akm/blob/v0.10.261020-beta/src/commands/ui/ui-cli.ts),
[server security and binding](https://github.com/itlackey/akm/blob/v0.10.261020-beta/src/commands/ui/server.ts).
Admin's native browser-opening flow for OpenCode already has a running service
and shared provider transport; AKM UI does not share that endpoint. No Admin,
Compose, port or authentication changes are included. A future separately scoped
integration should reuse the native UI and token checks with an explicit private
transport, rather than duplicate its API or expose a new public service.

An external browser was subsequently verified against a disposable published
Assistant: native UI, authenticated reads/writes into its stash and reload pass.
It removes the framing problem but still needs a private runtime endpoint. AKM
rejects remapped ports, so SSH forwarding must preserve the port. See the
[browser experiment](https://github.com/fwdslsh/fhold/pull/91#issuecomment-6530864455).
That separate feature is not part of this dependency release.
