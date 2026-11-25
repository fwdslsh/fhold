# AKM dependency review, November 24, 2026

| Component | Previous | Selected stable version |
| --- | --- | --- |
| AKM CLI and web | 0.10.261130 | 0.10.261131 |
| AKM plugins for OpenCode 2, Claude Code and Codex | 0.10.261136 | 0.10.261137 |

The npm `latest` tags resolve to the selected versions. The `next` tags still
resolve to CLI/web 0.10.261130-beta.12 and OpenCode plugin 0.10.261135-beta.
The published web and OpenCode packages depend on CLI 0.10.261131 exactly. The
OpenCode package's published Git revision agrees with the native marketplace tag
`v0.10.261137`. [CLI npm manifest](https://registry.npmjs.org/akm-cli/0.10.261131),
[web npm manifest](https://registry.npmjs.org/akm-web/0.10.261131),
[OpenCode npm manifest](https://registry.npmjs.org/akm-opencode-v2/0.10.261137).

The Claude Code and Codex marketplace archive is commit
`8707c83e04602825df36f596852e032e8a032e43`, SHA-256
`0ef6aaf3d9b342a66444b20ad1af70297168285f015cd70c394145f0bf6db86c`.
Both native plugin manifests report 0.10.261137 and the included CLI reports
0.10.261131. The OpenCode plugin tarballs differ only in their package manifest.
[Native marketplace comparison](https://github.com/itlackey/akm-plugins/compare/v0.10.261136...v0.10.261137).

## Runtime compatibility

- AKM now writes native schedules with a qualified task ref and continues to
  read the prior scheduler command form. Its existing migrator handles the new
  proposal-record format. Opening the state database also migrates records to
  bundle IDs and saves a pre-migration copy. These changes affect recovery and
  downgrade evidence. The Assistant still exercises AKM's native migrator
  before starting its writers.
- Directory adapters apply their asset discovery rules consistently to task and
  script refs. This can affect tasks that refer to assets in ignored directories
  or symlinked folders. Unqualified env references now check their own bundle
  first. fhold's supported private-store path remains the directory-backed,
  native V5 task workflow.
- The upstream release adds experimental secret-manager adapters. fhold's
  dependency refresh excludes integration and qualification of those adapters.
- The web launch script is byte-for-byte identical across the two publications.
  The update includes rebuilt web assets and the matching CLI. The image's
  existing AKM runtime and local-embedding imports still resolve. fhold has no
  runtime callers of the removed `--sensitive` flag or experimental
  `indexWrittenAssets` workspace API.
- The OpenCode plugin still declares SDK 2.1.4 and Effect 4.0.1 peers. fhold
  retains SDK 2.2.6 and Effect 4.1.0; the native image harness checks passed with
  that existing peer-version mismatch. The review
  covers AKM and defers unrelated dependency upgrades.

[AKM CLI release notes](https://github.com/itlackey/akm/releases/tag/v0.10.261131).

## Dependency verification

- Bun 1.4.4 regenerated the root lockfile with
  `bun install --lockfile-only --ignore-scripts` and passed
  `bun install --frozen-lockfile --ignore-scripts`. The diff changes the three
  AKM package resolutions and their owning workspace pins.
- Raw `bun audit` reported the three previously reviewed Zod, glob and
  minimatch advisories. `bun run audit` passed with the existing exclusions.
- The Dockerfile's extraction paths were verified against the downloaded
  archive. Both the extracted native CLI and the installed workspace CLI
  reported 0.10.261131. A focused import check resolved the runtime and
  embeddings functions used by the Assistant build and image smoke.

These checks cover dependency resolution, provenance and entry points.
Container, scheduler, migration, browser and native-harness checks provide
separate runtime evidence.

## Local development verification

The updated AIO and Slim images passed the existing runtime smoke on Linux
amd64, including native OpenCode/AKM integration and AKM Web browser,
authentication, Host and Origin checks. AIO also exercised the native Claude
Code and Codex plugins. These checks use disposable state and controlled
responses, not live provider credentials.

Both editions passed the delegated-credential smoke and image-backed Admin
tests: direct file access, private config/databases/migration backups, live
process environment, memory and credential descriptors were inaccessible to
Assistant. Approved OpenCode and scheduled tasks still returned redacted
output. Admin tests covered an alternate shared write target, refusal before
following a setup symlink, rotation and grant revocation. Reviewed scripts
remain trusted; command arguments and deliberately disclosed outputs are not
protected by this boundary. Keyring integration remains excluded.

The source suite, type checks, lint, CLI/Admin builds and generated all-profile
Compose validation passed. The raw audit exceptions above are unchanged.
The AIO upgrade fixture verified native startup migration from 0.10.261130,
persisted proposal conversion, preservation of the original pre-031 backup,
and reading the restored backup with the old CLI. Native scheduler execution,
paused task adoption, excluded asset paths and optional vector-cache recovery
passed. A cache captured before native bundle-config migration may be skipped
and rebuilt; essential recovery still completes.
This is development evidence; native ARM64 and final release qualification
remain separate CI gates. No live instance was changed.
