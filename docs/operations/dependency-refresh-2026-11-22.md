# AKM beta and credential custody MVP

## Final release update

For the authorized 0.4.1114-beta release, the final pins supersede the earlier
development pins below: AKM CLI/web **0.10.261130** and OpenCode/Claude/Codex
plugins **0.10.261136**. Actual npm availability and exact CLI dependencies were
verified on November 22. The native release archive is commit
`9d23be6b543479ce5c0bc037f8f44cffc1aebd79`, SHA-256
`54df415166019bf51341ef93810c7c1cc9632086a66d117e75cc022b938c4219`;
both native manifests and the bundled CLI agree with the selected versions.

The CLI promotion from beta.12 updates documentation, help/deprecation text and
release metadata. The plugin promotion pins the stable CLI. Existing native V5
task execution and per-step secret bindings remain the integration contract;
this update does not introduce an encrypted secret backend.

The targeted install changes only the three AKM package resolutions and owning
pins. The frozen install and reviewed source audit pass with the same three
owner-approved exclusions; no override or exception is added. The complete
workspace freshness review also found newer OpenCode 2.3.2, Claude Code 2.1.330,
Codex 0.171.0, Playwright 1.65.1, Effect 4.1.5, Electron 45.4.1 and routine
build/docs packages. These unrelated upgrades are deferred to a compatibility
batch. OpenCode remains 2.2.6 and Effect 4.1.0; the AKM plugin still declares
SDK 2.1.4 / Effect 4.0.1 peers, so real harness checks remain required.

Use the final canonical candidate's source, image, browser, keyring, custody,
native harness, security, recovery and packaged CLI/Admin checks as release
evidence. Earlier local results below describe the earlier beta dependency set
and do not substitute for the final candidate's checks.

## Earlier development review

This feature branch is based on PR #131's SSH and native keyring work. It does
not merge that PR or stamp/publish a release. The dependency review is scoped to
the requested AKM beta and its required web and native plugin integrations.

| Component | Previous | Selected published version |
|---|---|---|
| AKM CLI | 0.10.261125 | 0.10.261130-beta.12 |
| AKM web | 0.10.261125 | 0.10.261130-beta.12 |
| OpenCode AKM plugin | 0.10.261126 | 0.10.261135-beta |
| Claude/Codex AKM plugins | 0.10.261126 | 0.10.261135-beta |

Verified npm availability on November 22, 2026. The web package, OpenCode plugin
and bundled native plugin CLI all require the selected CLI exactly. Native
marketplace tag `v0.10.261135-beta` resolves to
`fb9cae5da4650d9e3181f3d3f2f48e93277e3ae6`; the commit archive SHA-256 is
`6d8b0c9083208a90bab2f7d1bf95c0a6d93db49616f0fab23403e075a2de29c9`.
The root lockfile changes only these three package resolutions and their owning
workspace pins. No transitive override, vendor patch or audit exception was added.

The published changelog's relevant changes are native V5 task execution, per-step
secret bindings and captured-result redaction, clean command-step environments,
new run/exec flags, and native task/workflow migration. The credential MVP uses
V5 command steps; it does not convert existing user tasks or install prompt steps
in the private credential identity. Agent steps inherit AKM's environment and
must not be used as the credential-bearing executor. Direct script/exec output
must not be treated as universally scrubbed.

The AKM OpenCode plugin still declares SDK 2.1.4 / Effect 4.0.1. fhold retains
its existing OpenCode 2.2.6 / Effect 4.1.0 pins and verifies the actual integration
instead of forcing peer resolutions. Unrelated dependencies remain unchanged.
The same three source-audit exceptions remain in place; the reviewed audit passes.

## Local verification

- Built actual Slim and AIO images through the normal Bake targets, using `dev`
  metadata and distinct local tags; no monthly release counter was consumed.
- `smoke-credential-custody.mjs` passed on both editions using the repository's
  actual Compose overlay. It covers default-off behavior, native provisioning,
  exact sudo grants, direct-read/tamper/flag/environment/cwd denial, OpenCode
  shell execution, Supercronic, replacement and disabling/re-enabling.
- The existing runtime smoke passed on both images: browser screenshots/PDF,
  AKM web authentication/Host/Origin checks, native AKM tools/recall/plugins,
  workspace preload protection and preserved existing AKM catalogs. AIO includes
  Claude and Codex native integration checks with synthetic provider fixtures.
- Full source suite: 1,275 passed, 10 skipped, zero failures. Type checks, lint,
  frozen installation, CLI build, Admin bundle and docs tests/check passed.
- Trivy 0.76.1 found zero unexcepted fixable HIGH/CRITICAL findings in the AIO
  image, using the existing `.github/trivy-ignore.yaml`. This is not a claim of
  zero advisories across all severities or of release qualification.

The MVP uses the published npm CLI through the image's ordinary `/usr/local/bin/akm`,
not the investigation's separate source-built executable. Native ACL isolation is
limited to the private integration-secret store. The optional Compose settings
change container hardening; normal deployment settings stay unchanged. See
[credential custody](../credential-custody.md) for operator setup and the explicit
plaintext-storage, recovery, identity and Docker-only limitations.

ARM64, ACA, full release lanes and encrypted private-store integration are not
qualified by this MVP. No live installation or recovery settings were changed.
