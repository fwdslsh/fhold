# Admin app artwork

`icon-source.jpg` is the owner's approved artwork (`2698.jpg`), copied byte-for-byte
from the supplied image. Use it exactly as supplied: no tracing, redrawing,
cropping, recoloring, background removal or added effects. Only native-format
conversion and proportional resizing are allowed. Its dark background, margins,
navy mark and teal highlights are intentional. This changes app artwork, not
navigation icons or the selector. `icon-source.png` is the full-resolution PNG
conversion needed by electron-builder (its converter does not accept JPEG).
The earlier `admin-mark.svg` is superseded and is not used to export or package
the current icon.

Committed native exports:

- `icon.png`: 512 × 512 PNG, used by Electron windows and Linux packaging.
- `icons/`: native 16, 24, 32, 48, 64, 128, 256 and 512 px PNGs, installed into
  the corresponding per-user `hicolor` directories for menu/taskbar lookup.
- `icon.ico`: Windows multi-resolution icon, including 16–256 px frames.
- `icon.icns`: macOS multi-resolution icon, including the 1024 px Retina frame.

The exports were produced with the locked electron-builder 26.18.1 icon toolset
(`icons@1.2.3`), not a hand-written encoder. Application builds consume these files
without redrawing the artwork. PNG is included in the packaged application;
electron-builder embeds ICO/ICNS in the native Windows/macOS packages. Application
IDs and desktop filenames remain unchanged, preserving shortcut/taskbar grouping.

To export the approved source image, run from `packages/electron`
with native Node.js and the repository's locked dependencies installed:

```sh
node scripts/export-icons.mjs
```

If the owner supplies a replacement JPEG, preserve that file as `icon-source.jpg`
and convert it without filters before exporting (FFmpeg is only an asset-authoring
tool, not a build or runtime dependency):

```sh
ffmpeg -hide_banner -loglevel error -y -i assets/icon-source.jpg -frames:v 1 -pix_fmt rgba -update 1 assets/icon-source.png
node scripts/export-icons.mjs
```

This is electron-builder's bundled converter, tied to the locked version; no new
image dependency or startup conversion is installed. See its
[icon documentation](https://www.electron.build/v26/docs/features/icons-and-images/).

An existing opt-in Linux menu installation refreshes changed/missing artwork when
the installed AppImage starts after an update. Separate downloads, custom desktop
entries and machines with no menu installation remain untouched. Unchanged icons
are not rewritten. **Settings → Refresh menu entry** also explicitly refreshes
the desktop caches without replacing the running installed AppImage. The desktop
owns caching: update the icon-theme directory timestamps and use native XDG/KDE
refresh tools when available. Missing helpers must not block Admin or delete caches.
Linux AppImage and native Windows/macOS preview checks exercise package startup;
Windows/macOS public distribution remains outside this change.

Verify the visible title-bar AND taskbar icons on KDE, not just exported-file hashes.
Also inspect 16/24/32 px exports on light/dark backgrounds after updating artwork.
