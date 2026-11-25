# AKM Web pre-merge review — November 25, 2026

**Recommendation: hold merge for the shutdown findings below.**

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
