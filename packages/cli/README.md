# fhold CLI

Primary Linux installer and host orchestrator. Build a standalone executable
with `bun run --cwd packages/cli build` from the canonical
[GitHub source](https://github.com/fwdslsh/fhold). The compiled executable includes
its runtime and managed assets; it is not an npm bootstrap package. Prebuilt
Linux x64 and ARM64 executables are available in [GitHub releases](https://github.com/fwdslsh/fhold/releases).

Use [installation](../../docs/installation.md), [management and recovery](../../docs/managing-fhold.md)
and [connection recipes](../../docs/README.md) for the current command paths.
Own-backup `restore` accepts only supported fhold manifests; no raw-home import
or alias remains. Native history recovery is a distinct offline operation.

The embedded Skeleton archive is built from the shared managed/seed-once
allowlists in the library. `scripts/packaged-assets.test.ts` verifies equality
with staged Admin resources. All subprocesses use argument arrays, secrets
remain private file/stdin input and instance intent belongs in StackConfig.
Linux artifact requirements and public publishing are described in
[release gates](../../docs/operations/release.md); macOS/Windows are deferred.
