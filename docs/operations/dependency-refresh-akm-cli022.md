# AKM CLI022 and plugin020 refresh

Reviewed October 30, 2026 (America/Chicago), starting from main
`6572f36`. This is a targeted container dependency update; release stamping and
publication remain separate work.

| Dependency | Previous | Selected stable |
| --- | --- | --- |
| AKM CLI | 0.10.261021 | 0.10.261022 |
| OpenCode, Claude and Codex AKM plugins | 0.10.261019 | 0.10.261020 |

These are npm's `latest` versions at review. The older `next` prereleases are
not selected. The [CLI release](https://github.com/itlackey/akm/releases/tag/v0.10.261022)
preserves reserved-name skill-directory intent, fixes declared command types
when indexing placeholder documentation, and improves native UI review context
and operational charts. The [plugin release](https://github.com/itlackey/akm-plugins/releases/tag/v0.10.261020)
requires exactly CLI022.

Both native marketplace manifests report plugin020. The immutable source is
`cb5aa3f66356dc17928d1ff5e573a4d275741fb3`; the downloaded archive SHA256 is
`7e0b147d5540c1f0fa10c5384372b5a07741327b29122a9f8f7ec971a6d6f281`.
All extraction paths and the checksum are updated together. npm integrity
records remain generated in the single root `bun.lock`.

The selected plugin retains its existing OpenCode SDK2.1.4 and Effect4.0.1
peer declarations. Main already ships OpenCode2.2.1 with Effect4.0.1; this update
retains that combination and verifies the real native harnesses. No override,
vendor edit or alternate integration is added. Unrelated image tools, bases,
workspace packages and existing advisory exceptions are unchanged.

Validation results and any pending hosted native checks are recorded in the PR.
Use private disposable fixtures on the workspace disk for local testing rather
than the nearly full machine-wide `/tmp`. No live instance is changed.
