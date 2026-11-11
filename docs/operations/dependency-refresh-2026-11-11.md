# AKM dependency refresh — November 11, 2026

PR #117 updates Assistant's exact AKM pins together:

| Package | Previous | Selected |
| --- | --- | --- |
| akm-cli / akm-web | 0.10.261117 | 0.10.261118 |
| akm-opencode-v2 | 0.10.261119 | 0.10.261120 |
| Native Claude / Codex AKM plugins | 0.10.261119 | 0.10.261120 |

These are the published npm `latest` versions at review, rather than the older
`next` prereleases. Both web and OpenCode require CLI 0.10.261118 exactly.
The native marketplace also carries that CLI for offline hook execution; retain
its upstream dependencies and lockfile without vendor patches.

The [plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261120)
resolves to commit `dafb297ddd0cb67787fc4a9f2e72401f5e826776`. Its codeload
archive SHA256 is
`ddcfb9f8527beaa75f482c0261a34b023d13c8c32f6a4c7d2dae637212578fb9`.
Both native manifests report 0.10.261120 and the bundled CLI reports 0.10.261118.
The Dockerfile URL, checksum and extraction prefixes move together. Keep Codex's
native local marketplace selection for the verified image-baked files.

The [CLI release](https://github.com/itlackey/akm/releases/tag/v0.10.261118)
fixes migration scope, bundle fast-forward updates, retention of native plugin
configuration through migration, and health readiness/failure/usage reporting.
It also adds native `health --read-only` and independent `--no-probe` options.
The existing fhold integration already uses the supported read-only health API;
this dependency update does not introduce a second diagnostic implementation.
The plugin release changes the exact required CLI; no fhold wrapper or additional
agent restriction is needed.

The lockfile changes only these three package resolutions and their workspace
pins. OpenCode 2.2.6 and Effect 4.1.0 remain unchanged. The plugin's existing
2.1.4 / 4.0.1 peer declarations remain narrower than those selections, so real
OpenCode, Claude and Codex recall remains part of the affected image checks;
do not force overrides or downgrade packages to silence peer declarations.
Unrelated dependency updates and the existing audit exceptions remain outside
this focused change. Source, native image and recovery results are recorded on
[PR #117](https://github.com/fwdslsh/fhold/pull/117); prior live ACA evidence
remains identified by its original source and image digest.

No release is stamped or published by this update. Guardian and Portal do not
install AKM and require no direct pin changes. No running instance, native
consent, recovery setting or backup is changed.

## Verification

- Frozen-lockfile install, all six typechecks, configured lint, standalone CLI
  build and Admin bundle passed. Lint retains 321 existing warnings.
- Full repository suite: 1,276 passed, 19 opt-in skips, zero failures. This includes
  native AKM vector export/import regression tests against the selected package.
- Reviewed audit: no findings beyond the same three approved exceptions; none
  added or widened.
- Production Dockerfile AMD64 image:
  `sha256:f99f454b57fef0e8d4714f45eab36f6cab34efdc7b5b164041cf1201b6566542`.
  The runtime lane passed real OpenCode, Claude and Codex recall, all five AKM
  tools, native hooks/consent, optional policy settings, built-in skills and
  preservation of an operator-owned catalog. Native AKM web passed Chromium
  authentication, cookie, Host/Origin and forwarded-connection checks. The
  existing read-only health API returned its expected schema 3 response.
- Image-backed checkpoint upgrade from published Assistant 0.4.1106-beta passed:
  native state restoration, committed SQLite WAL data, optional vector reuse,
  ownership/error handling and recall with the new CLI/plugins. Fixtures were
  disposable local containers, not live instances or a new Azure qualification.

These are dependency-development checks, not final release or native ARM64
qualification. The previous live ACA record keeps its original image digest;
it is not relabeled as evidence for the new dependency bytes.
