# Scripts

Only a small script surface remains active.

| Script | Purpose |
|---|---|
| `dev-setup.sh` | Materialize an isolated `.dev` home for the stack |
| `release-version.mjs` | Validate UTC release versions, precedence and immutable retry identity |
| `set-version.mjs` | Stamp package/Compose versions using the shared release contract |
| `bump-release.mjs` | Stamp the complete product release |
| `smoke-image.sh` | Assert image startup and runtime security boundaries |
| `smoke-akm-harnesses.mjs` | Image-internal real-harness AKM hook and recall checks, without vendor credentials |
| `smoke-managed-policy.mjs` | Fresh image with supplied task policies; native Codex/Claude/OpenCode configuration and precedence checks |
| `smoke-recovery.mjs` | Real-image directory checkpoints, required/excluded mounts, cold replacement and offline restore |
| `smoke-blob-recovery.mjs` | Standard Blob transport conformance and native recovery against Azurite or an explicitly scoped live destination |
| `smoke-admin-artifact.mjs` | Extract and launch a fresh Linux Admin AppImage on its build runner |
| `test-isolate-fh-home.ts` | Force every Bun test into a throwaway `FH_HOME` |
| `validate-release-assets.mjs` | Verify the complete checksummed release set |
| `live-acceptance.ts` | Opt-in real-provider runtime acceptance after a retained Admin E2E run |

## Local development

```bash
./scripts/dev-setup.sh
./scripts/dev-setup.sh --enable-addon gateway
./scripts/dev-setup.sh --enable-addon discord
bun run dev:build
```

The adjacent test files cover release stamping, asset completeness, and
deterministic control-plane wiring. Provider and AKM boundaries in
`acceptance.test.ts` are fixtures; they do not prove real-model memory or timer
execution.

## Real-provider acceptance

Build runtime images with the version from the root `package.json`, then run
`bun run admin:e2e` with provider authentication and
`FH_ADMIN_E2E_KEEP_RUNNING=true`. Pass its exact retained private home to
`FH_LIVE_TEST_HOME` and an optional private output path to
`FH_LIVE_TEST_REPORT`, then execute:

```bash
FH_LIVE_TEST_HOME=/absolute/path/to/disposable-e2e/home \
FH_LIVE_TEST_REPORT=/absolute/path/to/private/live-report.json \
  bun run scripts/live-acceptance.ts
```

The thin entrypoint imports the runner beside Guardian's private MCP client
dependency. It verifies trusted-native automatic memory, natural-language task
creation and real timer history/output, recall after update/restart, MCP policy
boundaries, resumable job and identity isolation, explicit permission approval
with cross-identity rejection, and credential rotation.
Guarded remote and scheduled sessions are excluded from automatic capture.
It refuses normal operator projects and non-loopback fixtures.

The runner retains the test home and report, closes MCP clients, and attempts
to pause its generated task. It does not stop the stack or erase secrets.
`directModelRequests` excludes background memory and scheduled requests, so
allow budget headroom and stop the exact test stack after review. See the
[testing workflow](../docs/technical/testing-workflow.md) for version-matching
build commands, private-home setup, cleanup, and verification limits.
