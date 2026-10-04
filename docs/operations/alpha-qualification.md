# Linux qualification and release limits

Canonical source is [fwdslsh/fhold on GitHub](https://github.com/fwdslsh/fhold).
Linux CLI/Admin downloads and signed multi-architecture container images are
published through GitHub releases. Alpha releases are not stable releases.
fhold owns the generic images, CLI/Admin, runtime contracts and reusable tests;
host deployment and third-party installers are outside the product boundary.

Release-specific gates run through the [GitHub release workflow](https://github.com/fwdslsh/fhold/actions/workflows/release.yml).
The workflow builds Linux x64/ARM64 CLI and AppImages, tests images on native x64
and ARM64 runners, signs published images and checks uploaded asset bytes before
publishing. ARM64 Admin is cross-built and is not native-startup-qualified.
The scoped [reviewed advisories](release.md#reviewed-runtime-advisories) remain
disclosed exceptions, not clean-scan claims.

## Alpha.4 scope

`0.1.2610041911-alpha.4` adds native managed harness policies, the global
`--name`/`-n` instance selector and a public Claude Desktop extension download
link. See [upgrade notes](../managing-fhold.md#upgrade-from-alpha3) for retained
homes, compatible image pins and custom-hook behavior. The
[managed-policy review](managed-harness-policy-verification.md) records source
and real-image checks; each alpha.4 artifact still requires its own release gate.
Do not treat historical alpha.2/alpha.3 counts below as alpha.4 results.

## Published alpha.3 evidence

[Alpha.3](https://github.com/fwdslsh/fhold/releases/tag/0.1.2610040821-alpha.3)
was published by successful [GitHub release run 37189889821](https://github.com/fwdslsh/fhold/actions/runs/37189889821).
Its standalone Linux CLI/Admin, MCPB, checksums and manifest are public. All three
Docker Hub images are signed and support amd64/arm64. Native x64/ARM64 runtime
gates, downloaded x64 CLI/AppImage startup, fresh CLI installation, authenticated
OpenCode access and conditional keep-alive passed. These immutable artifacts
predate managed policies and must not receive alpha.4's managed-only mounts.

## Dependency-refresh verification

On October 4, 2026, the refreshed candidate passed these Linux x64 checks:

- Frozen workspace install, type checks, lint and all 477 product tests, with no
  failures or skips. Native-history tests used the newly built Assistant image;
  loopback socket tests were enabled. No workspace dependency was reported
  outdated by `bun outdated --recursive`.
- CLI compilation and actual-binary configuration-boundary tests, Admin bundle
  and x64 AppImage startup, standard unsigned MCPB packing, all-profile Compose
  validation on a CLI-created empty home, shell syntax and workflow linting.
- All three image builds and normal startup smokes. Assistant verified npm/npx
  12.2.0 as non-root stdio launchers, all three native AKM recalls, preserved
  Codex decisions, changed-hook re-review and remote-worker failure isolation.
- Cold-container directory and Blob-emulator recovery, including native SQLite,
  custom paths, account/trust fixtures, final checkpoint and ownership release.
  These use synthetic data, not real vendor accounts. Azurite's API-version check
  is disabled because it does not yet implement the shipped SDK's service version;
  this proves emulator transport/recovery behavior, not live service compatibility.
- Trivy 0.75.0 found no critical advisories in any image and no fixable high
  advisories in Guardian or Portal. Assistant still has the three documented npm
  bundle findings. The reviewed unsigned-MCPB build-tool exception also remains.

The workspace uses the latest stable published direct dependencies checked that
day. Upstream packages retain their own nested pins: for example, `akm-opencode`
still depends on `akm-cli` 0.9.21 internally while the installed command is 0.9.24.
No override was added to force a different upstream SDK implementation.
No live deployment, provider request, remote-client pairing or native ARM64 run
is qualified by these local checks. Cross-version checkpoint restore remains
unsupported; refreshed native dependency versions require their own checkpoints.

## Qualified alpha.2 evidence

The previously locally qualified Linux artifacts and all three images are
`0.1.2610040221-alpha.2`. Qualification on October 4, 2026
covered the exact built artifacts, not subsequent source changes. Original
versions, bytes and verification receipts remain immutable.

- Frozen offline dependency installation, package type checks and lint passed.
- All 473 product tests passed without failures or skips, including real
  loopback sockets, image-backed security and native-history preservation.
- Assistant, Guardian and Portal passed their standard startup image smokes,
  including non-root execution, workspace Bun configuration isolation, baked
  helpers/skills and restart checks. Assistant received no Docker socket or
  Guardian/Portal credentials; services were non-privileged and dropped all
  Linux capabilities.
- Native Linux x64 compiled CLI build/startup and compiled configuration-boundary
  regressions passed. The x64 AppImage passed extraction/startup, renderer and
  bridge checks. The standard unsigned MCPB pack and manifest validation passed.
- Linux ARM64 CLI and AppImage cross-builds passed, with the extracted Admin ELF
  verified as aarch64. This is build-only evidence, not native ARM64 execution.
- Compose validated all three profiles on a CLI-created home. Real native API,
  authenticated Guardian MCP, provider readiness, restricted scheduler work and
  restart checks passed through ordinary product interfaces. Unauthenticated
  native API and MCP access were rejected; credential-scoped catalogs and a real
  guarded request were checked before and after restart.
- Native-history recovery preserved complete original conversations and later
  appended work across restart. Reviewed unfinished calls became terminal
  interrupted errors without replay; imported task definitions stayed inactive.
- Actual AKM recall passed in OpenCode, Claude Code and Codex. Native Codex hook
  decisions were preserved, and changed definitions required review. A real
  Claude native-client tool request and allowed Discord interaction were confirmed;
  these do not qualify every account, client or portal configuration.

The setup path used the packaged CLI and native provider flow. A real no-tool
readiness request succeeded, and only the untouched Guardian moderator
placeholder was replaced with the exact verified provider/model. Tests did not
repair image PATH, permissions or settings to conceal product defects.

Use [the testing workflow](../technical/testing-workflow.md),
[Admin verification](admin-setup-verification.md) and
[release operations](release.md) to repeat the relevant gates. Changed source
or artifact bytes require a new release identity and their own verification;
source cleanup does not re-certify existing images or deployments.

## Remaining gates

Native Claude/Codex workers remain experimental. Supervisors default on and
preserve explicit off decisions; native sign-in, consent and workspace trust remain
user choices. Alpha.4's built-in hooks use managed registration, not personal
approval. Process status is not client/tool readiness. Codex defaults to
`workspace-write`; outer container isolation must be explicit. Account renewal
and reconnect after recovery require separate live confirmation.

Windows/macOS packaging and native ARM64 Admin startup remain unqualified.
Public OAuth, a live Slack
account, target-host network mounts and measured recovery capacity/RPO/RTO remain
separate gates. The unsigned MCPB build-tool advisory exception is scoped to
packing, not a clean-audit claim; see [release operations](release.md).

Recovery requires exact recorded native dependency versions. It is not a schema
upgrade engine or zero-loss replication. SQLite remains local; directory backup
destinations need coherent atomic filesystem semantics. See
[Assistant recovery](../assistant-recovery.md) for scope and failure behavior.
No foreign-home adoption, compatibility layer, SSH management or cross-host
publishing bridge is implemented.
