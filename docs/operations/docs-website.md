# Documentation website

The website is built in this repository from the canonical `docs/**` Markdown
files. Site presentation lives in `website/site/`; Unify configuration lives in
`website/unify.yaml`. The published template is pinned as
`unify-docs-template@0.1.1`, and the renderer version is pinned in
`website/package.json`. Both use the repository's single `bun.lock`.

## Build and preview

With Bun and Node/npm available:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run docs:test
bun run docs:check
bun run docs:build
bun run docs:dev
```

`docs:check` performs a strict dry-run with the audit gate. `docs:build` writes
only `website/dist/`. The template staging tree in `website/.cache/` and the
output are ignored; do not commit generated pages or copies of upstream layouts.
`docs:dev` previews the prepared snapshot. While the temporary shim is in place,
restart it after editing canonical docs, the generator, or local presentation
files; Unify watches the staged source tree rather than those original inputs.
First preparation downloads the pinned npm template through Unify's native
`init` command. npm lifecycle scripts are not run. Site preparation replaces
only its disposable staging directory; it never changes `docs/`.

The generator walks nested documents, gives them titles/descriptions, resolves
relative documentation links to their website routes, and sends links to
unpublished repository files to GitHub. Code examples remain unchanged. The
Guides, Connect, and Reference indexes serve users; architecture, tests, release
procedures, plans, and implementation reviews are under Maintainers. The
documentation map lists every section. Add a new user-facing technical reference
to the generator's explicit reference list; technical and operations documents
otherwise belong under Maintainers.

## GitHub Pages

`.github/workflows/deploy-docs.yml` checks pull requests and deploys successful
builds on `main` or manual dispatch. It uses the GitHub Pages artifact/deployment
actions, with `https://fwdslsh.github.io/fhold/` as the initial base URL.
Repository Pages settings must use **GitHub Actions** as the source.

Changes to docs, site files, this workflow, or the manifests/lockfile trigger
verification. Strict build and audit findings stop publication. Ordinary
site-content rollback is a reviewed Git revert followed by deployment.

Changes confined to `docs/**`, `website/**`, the root `README.md`, or this
website's deployment workflow do not trigger the full product/container CI.
The website workflow still verifies docs and site changes. Mixed changes,
shared root manifests/lockfiles, runtime skills/prompts, and product/CI files
retain full CI; release validation also retains its full stack gate.

If a custom domain is added later, set its Pages binding and DNS record, then
change the base URL in `website/unify.yaml`. No domain or DNS change is required
for the initial project-pages site.

## Temporary template shim — removal required

Tracking issue: [Unify #118](https://github.com/fwdslsh/unify/issues/118).

Current Unify uses `template:` for scaffold/update provenance rather than a
build-time dependency. `website/scripts/template-shim.mjs` is a temporary
workaround: it calls native `unify init` in an ignored directory, applies our
local presentation files, and exposes that tree as the configured source.
It implements no template resolver, updater, or runtime feature.

**Remove the shim after a released Unify version implements #118 and supports
this site's template/local-content combination.** Do not remove it merely when
the issue closes or a prerelease mentions the feature. The replacement change:

1. Pin that released renderer version and update `bun.lock`.
2. Replace `source: .cache/template/site` with the native external-template
   configuration defined by the upstream release, preserving the pinned template
   and local overrides. Do not guess its future key names.
3. Delete `website/scripts/template-shim.mjs`, the `prepare:template` script,
   and its prefixes from check/build/dev. Keep the canonical-docs generator,
   presentation files, tests, and Pages workflow.
4. Run the site tests, strict build/audit, mobile/filter checks, and verify both
   project-subpath and root-domain output before publishing the replacement.
