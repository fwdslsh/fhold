# Admin app artwork

`icon-source.png` is the high-resolution master derived from the owner's supplied
green f/h mark (`2701.png`). The built-in image editor preserved the monogram and
prepared a centered black tile with transparent corners. This changes the app
identity artwork, not the Admin navigation icons or instance selector.

Committed native exports:

- `icon.png`: 512 × 512 RGBA, used by Electron windows, Linux packaging and the
  opt-in KDE/GNOME menu installation at `hicolor/512x512`.
- `icon.ico`: Windows multi-resolution icon, including 16–256 px frames.
- `icon.icns`: macOS multi-resolution icon, including the 1024 px Retina frame.

The exports were produced with the locked electron-builder 26.18.1 icon toolset
(`icons@1.2.3`), not a hand-written encoder. Application builds consume these files
without redrawing the artwork. PNG is included in the packaged application;
electron-builder embeds ICO/ICNS in the native Windows/macOS packages. Application
IDs and desktop filenames remain unchanged, preserving shortcut/taskbar grouping.

To update the exports after replacing the master, run from `packages/electron`
with native Node.js and the repository's locked dependencies installed:

```js
// node --input-type=module
import { createRequire } from 'node:module';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.resolve('electron-builder'));
const { runIconsTool } = require('app-builder-lib/out/toolsets/icons.js');
for (const outputFormat of ['set', 'ico', 'icns']) {
  const outDir = resolve('dist/icon-exports', outputFormat);
  await mkdir(outDir, { recursive: true });
  await runIconsTool({
    inputFile: resolve('assets/icon-source.png'), outputFormat, outDir
  });
  const source = outputFormat === 'set' ? '512x512.png' : `icon.${outputFormat}`;
  const target = outputFormat === 'set' ? 'icon.png' : source;
  await copyFile(resolve(outDir, source), resolve('assets', target));
}
```

This is electron-builder's bundled converter, tied to the locked version; no new
image dependency or startup conversion is installed. See its
[icon documentation](https://www.electron.build/v26/docs/features/icons-and-images/).

For an existing Linux menu installation, **Settings → Refresh menu entry** from the
installed copy refreshes its cached icon without replacing the running AppImage.
Linux AppImage and native Windows/macOS preview checks exercise package startup;
Windows/macOS public distribution remains outside this change.

Image-editor brief: preserve the supplied green monogram, diagonal slash, curves
and pointed top-right corner; reduce outer margins and center it on a flat black
rounded square with transparent exterior; no text, gradients, shadows or added
decoration. Inspect small exports and light/dark desktop backgrounds after edits.
