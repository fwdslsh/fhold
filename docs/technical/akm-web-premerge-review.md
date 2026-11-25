# AKM Web pre-merge review — November 25, 2026

**Current state: stable AKM and matching plugins are integrated and locally
verified on Linux amd64. The PR is stacked on #135; canonical CI and release
qualification remain separate.**

## Stable release verification — November 25

- CLI/Web: `0.10.261133`; published web build provenance `594152334573`.
- OpenCode/Claude/Codex plugins: `0.10.261139`, each requiring/bundling CLI
  `0.10.261133`. Marketplace commit `faa365375171f6c5f35cd3d07120d85e20cbabae`,
  archive SHA-256 `a42f40046e05a63c8d6066cb5b99b76d77beffc0cb5c6c6819ffb755c07b2fe3`.
- Reviewed intervening #1814: AKM Web now uses AKM's native child registry
  instead of patching Node's global child process implementation. No additional
  fhold process registry or workspace API integration is needed.
- Included the pending #135 branch so its native flat bundle configuration,
  migration/cache fixes and custody corrections are preserved. Dependency
  conflicts were resolved to the stable set, without vendor overrides.
- Corrected stale session reuse: enabling persistent hosting now stops a cached
  on-demand child and returns the configured persistent URL and credential.

Checks on the combined branch:

- Full source suite: 1,302 passed, 11 opt-in cases skipped; workspace type
  checks, CLI/Admin builds, frozen lockfile, docs checks/tests and shell checks
  passed. Approved audit policy passed with the same three exceptions.
- Both locally built AIO and Slim passed native runtime smokes: browser/Web
  direct and forwarded authentication, OpenCode tools/recall, installed harness
  plugins, operator settings preservation and workspace execution boundaries.
- All eight native shutdown runtime regressions passed against the installed
  stable packages; the separate Desktop launcher assertion passed against
  exact-release source (Electron source is not shipped in the web npm package).
- A disposable Compose instance passed normal CLI activation, private single-file
  secret mounting, no secret value in Docker environment, authenticated native
  readiness, idle and active software-operation reporting, browser login/reload/
  logout, and an unresolved configured-secret reference overridden by fhold's
  dedicated secret. Native `frameParents` CSP and same-site cross-origin iframe
  login/reload passed in Chromium.
- The actual `KnowledgeUi` launcher and `AdminKnowledge` Electron view passed
  against the local image: bearer readiness, browser-origin writes, no Admin
  preload in the web renderer, persistent-server survival after view close and
  on-demand server termination on disconnect. Disabling persistent hosting
  removed its managed mount and published port while retaining the login file.
- The final AIO native custody smoke passed: the ordinary assistant could not
  read private files, delegate memory/environment or its open secret descriptor;
  approved tasks, redacted OpenCode/Supercronic results and replacement/disable/
  re-enable persistence still worked with stable AKM.

Verification limits: the full Admin-window click-through harness stalled at its
welcome-screen renderer wait under local Xvfb and was stopped. The focused real
launcher/view check above is narrower evidence, not a claim that full-window
navigation passed. Native ARM64/canonical candidate CI and release publication
were not run. No live instance or recovery settings were changed. Unrelated
tool upgrades and the existing OpenCode SDK/Effect peer-version difference were
held; actual native harness checks passed with the selected stable AKM set.

Earlier beta/source reviews below are historical, including their resolved holds.

## Published beta 2 verification

On November 25, npm supplied `akm-cli` and `akm-web` at
`0.10.261133-beta.2`. The web package's `build-info.json` identifies
`766d342dd684`, matching the [release commit](https://github.com/itlackey/akm/releases/tag/v0.10.261133-beta.2).
Both direct Assistant pins and the root lockfile now select this version.
No override, startup download, or upstream package modification was added.

Beta 2 adds [PR #1813](https://github.com/itlackey/akm/pull/1813): commands an
operation starts during forced termination are stopped too. The installed
package contains that correction. Its native thirteen-second shutdown bound
still fits fhold's fifteen-second wait, without another runtime change.

Verification against the actual npm packages, using disposable homes:

- Direct and TCP-forwarded Chromium smoke: authenticated readiness, bearer
  access, Host/Origin rejection, navigation and reload passed.
- Fhold's actual `AdminKnowledge` Electron view: authenticated readiness,
  browser-origin writes and renderer isolation passed.
- All eight upstream runtime shutdown regressions passed, including the new
  command-started-during-termination case and descendant process groups.
  The separate Desktop launcher source assertion initially could not run because
  Electron source is intentionally absent from the web package; it passed when
  checked against the exact release commit's source files.
- Frozen lockfile install, workspace type checks, all 16 focused fhold tests
  (socket tests enabled), CLI build and Admin bundle passed. The approved audit
  policy reported no unexcepted vulnerabilities; its three existing exceptions
  were unchanged.

**Plugin hold at the beta 2 check (now resolved):** npm's latest `akm-opencode-v2` was `0.10.261138`, requiring
CLI `0.10.261132`; the repository has no open plugin update PR at this check.
Fhold's existing `0.10.261136` plugin pins and native marketplace archive remain
unchanged, with their own published CLI `0.10.261130`. The lockfile preserves
that dependency rather than forcing it to beta 2. This is an intermediate
feature branch, not a qualified mixed-version release. Before merge, select
the published plugin set supporting beta 2 (OpenCode, Claude and Codex), update
the immutable marketplace revision/checksum, regenerate the lockfile, and run
the affected harness/image and final Admin smoke checks. No live instance,
release tag or image was changed.

## Fix verification at 675ad5e6

Both PR findings are fixed and acknowledged on GitHub; the inline shutdown thread
is resolved. The eight updated shutdown tests pass. Both independent probes
(detached and caller-requested non-detached parent) now report the leader exited
and no descendant writes after termination returned. The locally packed npm
package smoke passes, including staged README checks and authenticated startup.
Unchanged core/UI build artifacts from the prior verified revision were reused;
no dependency or core/UI source changed in this update.

Native shutdown still has the documented limitations for Windows child trees and
processes escaping into independent sessions. These were not qualified by the
Linux process-group tests. Fhold's bearer/readiness contract and fifteen-second
wait need no further runtime change. Published pins and final image qualification
remain pending release; this review did not merge, publish, or deploy anything.

Earlier findings and verification are retained below for history.

## PR #1804 follow-up at ba1e5ca

Reviewed `ba1e5ca53b0975da02eb2c826461ba503dd5f44c`. The earlier direct-child
shutdown finding and the five-second Desktop timeout described below are fixed.
The new native bound is thirteen seconds; Desktop and fhold both allow fifteen.

Two findings were posted on the PR: [descendant shutdown](https://github.com/itlackey/akm/pull/1804#discussion_r4692063156) and [generated npm documentation](https://github.com/itlackey/akm/pull/1804#issuecomment-7156735392).

- **P1:** `desktop/server/shutdown.mjs:41` removes process-group ownership when
  the direct child exits. A TERM-exiting leader with a TERM-resistant grandchild
  leaves that grandchild writing after `terminate()` returns; the SIGKILL pass
  no longer knows its group. Independently reproduced with the exact module in
  isolated Linux Node processes, for both detached and non-detached parents.
  Synthetic descendants were explicitly cleaned up. The existing regression
  where the leader ignores TERM does not cover this case. Retain ownership and
  verify the entire tree/group has stopped; keep this fix in AKM.
- **P2:** `desktop/scripts/package-web.mjs` still generates a quick start without
  a secret and describes a printed token-bearing `url`. Fresh startup now fails
  without a secret, and ready output contains only `type` and `origin`. Update
  the generated npm README, not only the source documentation.

Validation on the exact PR revision: 293 Desktop unit tests, 54 native
web/browser/shutdown tests, 34 native configuration/migration tests, a clean core
and Desktop build, and Desktop type/format checks passed. Fhold's actual
`AdminKnowledge` Electron view loaded the native server, authenticated readiness,
performed a browser-origin write, and had no Admin preload exposed to its
renderer. No published-image or live-instance qualification is implied.

The existing fhold implementation matches the revised protocol and timeout.
No additional runtime workaround was added. Published dependency pins and final
image qualification remain pending the corrected upstream release.

The following records the earlier review and its reproduction, for history.


Reviewed `itlackey/akm` branch `feature/akm-web-access` at
`61e4352850d32fea3d5177eee9ce69ba8706429c`, compared with `release/0.10.261133`.
This is a source-build review; no published dependency, image, or live instance
was changed. Fhold integration is on `feat/akm-web-hosting`.

## Findings

### P1 — shutdown leaves a native host-tool writer running

[Server close](https://github.com/itlackey/akm/blob/61e4352850d32fea3d5177eee9ce69ba8706429c/desktop/server/server.mjs#L155)
drains HTTP connections only. Its caller then exits the process.
[Native host tools](https://github.com/itlackey/akm/blob/61e4352850d32fea3d5177eee9ce69ba8706429c/desktop/src/lib/server/features/host-tools.ts#L179)
run in detached process groups; their termination timers disappear when the web
server exits. An accepted installer can outlive the server and keep writing.

Reproduced against the built branch using the real software route and a synthetic
held `akm upgrade` executable. Before SIGTERM, `/api/session` reported active.
After SIGTERM, the server exited 0; the follow-up observation approximately
221 ms after the signal found the child still alive with advancing file writes. The fixture cleaned up
the child process group afterward. No real upgrade or credentials were used.

Required upstream correction: include pending host-tool operations and their
process groups in shutdown. Stop admitting operations, allow a bounded drain,
terminate remaining trees, and await their exit before reporting shutdown
complete. Add coverage for an operation already acknowledged over HTTP and a
child/grandchild continuing to write. Apply this to signal and IPC shutdown.

This affects standalone web hosting and fhold's on-demand Admin session cleanup.
Fhold's container shutdown traversal is not a substitute for AKM's process
ownership; it cannot be assumed to discover a writer after its parent has exited.
Do not add a second fhold process supervisor to compensate.

### P2 — Desktop kills the server before its native drain budget

[Desktop stopServer](https://github.com/itlackey/akm/blob/61e4352850d32fea3d5177eee9ce69ba8706429c/desktop/electron/main.mjs#L48)
uses SIGKILL after five seconds, while the new server allows ten seconds to drain
HTTP requests. An ordinary in-flight write taking between five and ten seconds
is forcibly interrupted when Desktop closes. The host-operation dialog does not
cover ordinary HTTP writes.

Align the Desktop parent deadline with the native grace plus process cleanup,
preferably using a shared constant. Test closing Desktop during a request that
finishes after five seconds but within the server's grace. Fhold had the same
five-second transport cutoff; this review changes it to fifteen seconds and adds
a regression test that drains for six seconds.

## Fhold alignment

- Keep the existing host-owned login file, single-file Compose secret mount,
  native `AKM_WEB_SECRET` override, and exact-origin private Electron headers.
- Native secret override precedence was exercised: an unreadable configured
  reference does not break an explicit environment override.
- Keep bearer values out of renderer IPC, ordinary snapshots, URLs and logs.
- Accept the additive `/api/session.session` field; native browser smoke now
  checks `session: false` for bearer access without rejecting extra fields.
- Keep native framing and allowed-host settings in AKM configuration. No CORS,
  proxy, authentication service, or workspace secret resolver is added to fhold.
- Keep root-path hosting for the first fhold implementation. Upstream prefix
  support passed its browser tests; expanding fhold's route contract is optional
  follow-up work.
- Keep exact published dependency pins unchanged until the corrected CLI/web
  and compatible plugins are actually published.

## Evidence

- Built core and Desktop from the exact revision with frozen dependencies.
- 41 upstream native tests passed: authentication, login/logout/session expiry,
  single-use links, secret environment removal, override precedence, Host/Origin
  enforcement, framing in Chromium, proxy path prefixes, readiness/activity,
  HTTP draining and runtime behavior.
- Fhold's native browser smoke passed for direct and forwarded access against
  the built branch: bearer auth, readiness, Host/Origin rejection and reload.
- Independently exercised the upstream Electron header hook using real Electron
  and disposable servers: no Authorization credential reached a cross-origin
  redirect target.
- Additional held-host-tool shutdown regression **failed**, confirming P1.
- Remaining release qualification: corrected shutdown regressions, published
  package/image integration, and the final Admin image smoke. Passing source
  tests is not a published-image qualification.
