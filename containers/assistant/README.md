# Assistant image

The active image is built from `Dockerfile`, using Ubuntu 24.04 LTS at runtime
and the pinned Bun/Node toolchains from their upstream build stages.

It contains:

- OpenCode;
- AKM CLI;
- image-baked standard AKM plugins for OpenCode, Codex and Claude Code;
- pinned native Codex and Claude Code workers, experimental with default-on supervisors;
- supercronic;
- Playwright 1.64.0, its matching Chromium and fonts/system libraries; and
- ripgrep, jq, Python with pip/venv, SQLite, zip/unzip, Poppler PDF tools,
  file, less and process utilities.

The entrypoint validates its managed configuration and file-backed OpenCode
password, synchronizes user task sources, starts supercronic, and starts the
native OpenCode server. It performs no package installation or network download.
Native worker accounts, workspace consent and Codex hook review remain explicit
setup choices. A failed optional worker never stops OpenCode or the scheduler.
`FH_CODEX_REMOTE=0` or `FH_CLAUDE_REMOTE=0` skips that supervisor without deleting
its account state. Neither variable is needed to sign in or for normal startup.
OpenCode, AKM, Codex and Claude have standard `/usr/local/bin` launchers so they
remain available in login shells that reset the image's `PATH`.

## Render pages without installing a browser

`playwright screenshot --full-page file:///work/report.html /work/report.png`
uses the browser baked into `/opt/ms-playwright`. The cache is shared and
read-only, so mounting an operator home does not hide it. For interactions,
use the upstream JavaScript API from a Node script:

```js
import { chromium } from '/opt/fhold/tools/node_modules/playwright/index.mjs';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await page.goto('file:///work/report.html');
  await page.getByRole('button', { name: 'Details' }).hover();
  await page.screenshot({ path: '/work/report-mobile.png', fullPage: true });
} finally {
  await browser.close();
}
```

The native `chromium` executable is also on PATH. Direct headless use requires
`--no-sandbox` inside the container; Playwright's upstream default already
disables the browser sandbox. fhold retains its non-root identity, dropped
capabilities and no-new-privileges container boundary. Browser tooling does not
change native agent permissions. Do not add capabilities or download another
browser just to render a page. Python packages belong in a workspace virtual
environment (`python3 -m venv /work/.venv`), preserving Ubuntu's managed Python.

Assistant runs as the configured non-root operator identity, drops all
capabilities, and receives no Docker socket, Admin credential, Guardian token,
or portal token. Its authenticated host port defaults to loopback; StackConfig
may deliberately bind it to another exact host address for direct native
OpenCode clients.

Persistent mounts are the Assistant home, operator OpenCode/AKM configuration,
knowledge, AKM state, and workspace. Managed configuration is read-only.
Provider `auth.json` is intentionally Assistant-readable; delegated ingress
credentials are not.

Managed Guardian sessions select one of three Assistant profiles: tool-disabled
`remote`, read-only `remote-read`, or permission-inheriting `remote-full`.
