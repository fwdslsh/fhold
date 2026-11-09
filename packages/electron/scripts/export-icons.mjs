// Manual asset export, not a startup/build-time redraw. Uses electron-builder's locked native toolset.
import { createRequire } from 'node:module';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.resolve('electron-builder'));
const { runIconsTool } = require('app-builder-lib/out/toolsets/icons.js');
for (const outputFormat of ['set', 'ico', 'icns']) {
	const outDir = resolve(root, 'dist/icon-exports', outputFormat);
	await mkdir(outDir, { recursive: true });
	await runIconsTool({ inputFile: resolve(root, 'assets/admin-mark.svg'), outputFormat, outDir });
	if (outputFormat === 'set') {
		await mkdir(resolve(root, 'assets/icons'), { recursive: true });
		for (const size of [16, 24, 32, 48, 64, 128, 256, 512])
			await copyFile(
				resolve(outDir, `${size}x${size}.png`),
				resolve(root, `assets/icons/${size}x${size}.png`)
			);
		await copyFile(resolve(outDir, '512x512.png'), resolve(root, 'assets/icon.png'));
	} else {
		await copyFile(
			resolve(outDir, `icon.${outputFormat}`),
			resolve(root, `assets/icon.${outputFormat}`)
		);
	}
}
