# Documentation website

The website is built in this repository from the canonical `docs/**` Markdown
files. Site presentation lives in `website/site/`; Unify configuration lives in
`website/unify.yaml`. The published template is pinned as
`unify-docs-template@0.4.0` through native `extends:` in Unify 0.11.13.
The renderer is pinned in `website/package.json` and the repository's single
`bun.lock`; Unify resolves the template's exact version itself.

The template is the fwdslsh family theme that fwdslsh.dev, unify.fwdslsh.dev and
akm.fwdslsh.dev also build on: its layout, stylesheet, page directory and
`assets/theme.css`. This site keeps only what names it, in the template's four
identity includes (`website/site/_includes/head.html`, `nav.html`, `footer.html`,
and the `docnav.html` the generator writes), plus its own pages and
`assets/site.css` for the few rules only this site needs. To change a color,
font or size, add `website/site/assets/theme.css` with the template's custom
properties you want to override; do not restyle the family theme here.

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
only `website/dist/`; do not commit generated pages or fetched template files.
Unify fetches the pinned npm template into its own template cache on the first
build, then reuses it offline. No staging script or copied template tree is
required. Template configuration and generators are never adopted; this site's
own configuration controls every build. Keep `catalog: true` because All pages
reads the catalog.

`source: site` names the local presentation in `website/site/`; the generator
renders canonical `docs/**` into Unify's generated overlay. This preserves
section routes, the fwdslsh design, and repository links without publishing the
raw Markdown a second time. `docs:dev` watches local presentation directly.
Restart it after editing canonical docs, which live outside the website project.

The generator walks nested documents, gives them titles/descriptions, resolves
relative documentation links to their section paths, and sends links to
unpublished repository files to GitHub. Code examples remain unchanged. The
Guides, Connect, and Reference indexes serve users; architecture, tests, release
procedures, plans, and implementation reviews are under Maintainers. The
documentation map lists every section. Add a new user-facing technical reference
to the generator's explicit reference list; technical and operations documents
otherwise belong under Maintainers.

## GitHub Pages

`.github/workflows/deploy-docs.yml` checks pull requests and deploys successful
builds on `main` or manual dispatch. It uses the GitHub Pages artifact/deployment
actions. The site is published at `https://fhold.fwdslsh.dev/`, the base URL in
`website/unify.yaml`: Repository Pages settings must use **GitHub Actions** as the
source and bind the custom domain `fhold.fwdslsh.dev`, whose DNS CNAME points to
`fwdslsh.github.io`.

Changes to docs, site files, this workflow, or the manifests/lockfile trigger
verification. Strict build and audit findings stop publication. Ordinary
site-content rollback is a reviewed Git revert followed by deployment.

Changes confined to `docs/**`, `website/**`, `bun.lock`, the root `README.md`, or this
website's deployment workflow do not trigger the full product/container CI.
The website workflow still verifies docs and site changes. Mixed changes,
root manifests, runtime skills/prompts, and product/CI files
retain full CI; release validation also retains its full stack gate.

To move the site to another domain, set its Pages binding and DNS record, then
change the base URL in `website/unify.yaml`.

## Native template build

[Unify 0.11.8](https://github.com/fwdslsh/unify/releases/tag/v0.11.8) implements
[#118](https://github.com/fwdslsh/unify/issues/118). The temporary template shim
and its `prepare:template` callers have been removed. Local layout, assets, and
generated pages override the npm template; its page-directory script is inherited.

[Unify 0.11.9](https://github.com/fwdslsh/unify/releases/tag/v0.11.9) rewrites
links to emitted Markdown pages to their published URLs, including pretty URLs
and the configured base path. The old extension-conversion workaround is removed.
The generator retains `.md` targets while mapping documents into their sections
and repository-only references to GitHub. Query strings, anchors, and code
examples remain intact; canonical Markdown still works in GitHub and editors.
Strict build/audit verifies the resulting site. Test both the project subpath
and a root-domain base URL when changing template versions, routing, or URL handling.
