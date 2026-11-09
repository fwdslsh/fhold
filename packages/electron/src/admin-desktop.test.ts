import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminDesktop, ADMIN_DESKTOP_ID, desktopEntry } from './admin-desktop.js';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), 'fhold-menu-'));
	roots.push(home);
	const env = {
		platform: 'linux',
		packaged: true,
		home,
		appImage: join(home, 'download-1.AppImage'),
		icon: join(home, 'icon.png'),
		version: '0.3.261006-beta'
	};
	await writeFile(env.appImage, 'old AppImage fixture');
	await writeFile(env.icon, 'icon fixture');
	return { env, desktop: new AdminDesktop(env) };
}

test('menu installation is opt-in, per user, and publishes a stable executable and matching icon', async () => {
	const { env, desktop } = await fixture();
	expect(await desktop.status()).toMatchObject({ supported: true, installed: false });
	expect(await stat(join(env.home, '.local')).catch(() => undefined)).toBeUndefined();
	await desktop.install();
	expect(await desktop.status()).toMatchObject({
		installed: true,
		replacesExistingCopy: true,
		runningInstalledCopy: false
	});
	expect(await readFile(desktop.paths.appImage, 'utf8')).toBe('old AppImage fixture');
	expect((await stat(desktop.paths.appImage)).mode & 0o777).toBe(0o755);
	expect(await readFile(desktop.paths.icon, 'utf8')).toBe('icon fixture');
	const entry = await readFile(desktop.paths.entry, 'utf8');
	expect(entry).toContain(`Icon=${ADMIN_DESKTOP_ID}\n`);
	expect(entry).toContain(`StartupWMClass=${ADMIN_DESKTOP_ID}\n`);
	expect(entry).not.toContain('download-1');
	expect(await readFile(env.appImage, 'utf8')).toBe('old AppImage fixture');
});

test('installed menu survives native self-update at the stable path; repair never recopies itself', async () => {
	const { env, desktop } = await fixture();
	await desktop.install();
	const entry = await readFile(desktop.paths.entry, 'utf8');
	// Native AppImageUpdater preserves a versionless filename when replacing it.
	await writeFile(desktop.paths.appImage, 'updated AppImage fixture');
	const updated = new AdminDesktop({
		...env,
		appImage: desktop.paths.appImage,
		version: '0.3.261007-beta'
	});
	expect(await updated.status()).toMatchObject({
		installed: true,
		replacesExistingCopy: false,
		runningInstalledCopy: true
	});
	expect(await readFile(desktop.paths.entry, 'utf8')).toBe(entry);
	await rm(desktop.paths.icon);
	expect((await updated.status()).installed).toBe(false);
	await updated.install();
	expect(await readFile(desktop.paths.appImage, 'utf8')).toBe('updated AppImage fixture');
	expect((await updated.status()).installed).toBe(true);
});

test('repair installs updated artwork without replacing the running installed AppImage', async () => {
	const { env, desktop } = await fixture();
	await desktop.install();
	await writeFile(desktop.paths.appImage, 'self-updated AppImage');
	await writeFile(env.icon, 'new brand icon');
	const updated = new AdminDesktop({ ...env, appImage: desktop.paths.appImage });
	await updated.install(() => { throw Error('An installed copy must not prompt for replacement'); });
	expect(await readFile(desktop.paths.appImage, 'utf8')).toBe('self-updated AppImage');
	expect(await readFile(desktop.paths.icon, 'utf8')).toBe('new brand icon');
	expect((await updated.status()).installed).toBe(true);
});

test('another download can explicitly replace the menu copy; failed staging retains the old copy', async () => {
	const { env, desktop } = await fixture();
	await desktop.install();
	const next = {
		...env,
		version: '0.3.261007-beta',
		appImage: join(env.home, 'download-2.AppImage')
	};
	const updated = new AdminDesktop(next);
	expect((await updated.status()).replacesExistingCopy).toBe(true);
	await expect(updated.install(async () => true)).rejects.toThrow();
	expect(await readFile(desktop.paths.appImage, 'utf8')).toBe('old AppImage fixture');
	await writeFile(next.appImage, 'new AppImage fixture');
	let confirmations = 0;
	const confirm = async () => { confirmations++; return true; };
	await Promise.all([updated.install(confirm), updated.install(confirm)]);
	expect(confirmations).toBe(1);
	expect(await readFile(desktop.paths.appImage, 'utf8')).toBe('new AppImage fixture');
	// No version/size heuristic: replacing from any other download stays explicit.
	expect((await updated.status()).replacesExistingCopy).toBe(true);
});

test('an old download cannot silently replace a self-updated menu copy, even when its icon is missing', async () => {
	const { desktop } = await fixture();
	await desktop.install();
	await writeFile(desktop.paths.appImage, 'newer self-updated AppImage');
	await rm(desktop.paths.icon);
	expect(await desktop.status()).toMatchObject({ installed: false, replacesExistingCopy: true });
	await desktop.install();
	await desktop.install(async () => false);
	expect(await readFile(desktop.paths.appImage, 'utf8')).toBe('newer self-updated AppImage');
	await desktop.install(async () => true);
	expect(await readFile(desktop.paths.appImage, 'utf8')).toBe('old AppImage fixture');
});

test('same-size builds are still explicit replacements, not assumed identical or newer', async () => {
	const { env, desktop } = await fixture();
	await desktop.install();
	await writeFile(env.appImage, 'NEW AppImage fixture');
	expect((await stat(env.appImage)).size).toBe((await stat(desktop.paths.appImage)).size);
	expect((await desktop.status()).replacesExistingCopy).toBe(true);
	await desktop.install();
	expect(await readFile(desktop.paths.appImage, 'utf8')).toBe('old AppImage fixture');
});

test('XDG data home is respected only when absolute and development is not installed', async () => {
	const { env } = await fixture();
	const dataHome = join(env.home, 'custom share');
	const custom = new AdminDesktop({ ...env, dataHome });
	await custom.install();
	expect(custom.paths.entry).toBe(join(dataHome, `applications/${ADMIN_DESKTOP_ID}.desktop`));
	expect(new AdminDesktop({ ...env, dataHome: 'relative' }).paths.entry).toContain(
		'/.local/share/applications/'
	);
	const development = new AdminDesktop({ ...env, packaged: false });
	expect((await development.status()).supported).toBe(false);
	await expect(development.install()).rejects.toThrow('Linux AppImage');
});

test('desktop identity matches packaging and handles Exec reserved characters without a shell', async () => {
	const pkg = JSON.parse(await readFile(join(import.meta.dir, '../package.json'), 'utf8'));
	expect(pkg.desktopName).toBe(`${ADMIN_DESKTOP_ID}.desktop`);
	const entry = desktopEntry('/home/a b/100%/"cash$`\\/fhold-admin.AppImage');
	expect(entry).toContain('100%%');
	expect(entry).toContain('\\\\"cash\\\\$\\\\`\\\\\\\\');
	expect(entry).not.toContain('sh -c');
	expect(entry).not.toContain('%U');
});

test('native packages use the same identity and OS installers own Windows/macOS integration', async () => {
	const config = Bun.YAML.parse(
		await readFile(join(import.meta.dir, '../electron-builder.yml'), 'utf8')
	);
	expect(config.appId).toBe(ADMIN_DESKTOP_ID);
	expect(config.linux.syncDesktopName).toBe(true);
	expect(config.win.target).toBe('nsis');
	expect(config.nsis).toMatchObject({
		perMachine: false,
		createStartMenuShortcut: true,
		shortcutName: 'fhold Admin'
	});
	expect(config.mac.target).toEqual(['dmg', 'zip']);
	expect(config.linux.icon).toBe('assets/icon.png');
	expect(config.win.icon).toBe('assets/icon.ico');
	expect(config.mac.icon).toBe('assets/icon.icns');
	const { env } = await fixture();
	for (const platform of ['win32', 'darwin']) {
		const desktop = new AdminDesktop({ ...env, platform });
		expect((await desktop.status()).supported).toBe(false);
		await expect(desktop.install()).rejects.toThrow('Linux AppImage');
	}
	expect(await stat(join(env.home, '.local')).catch(() => undefined)).toBeUndefined();
});

test('brand assets include native desktop sizes and builds never redraw the old mark', async () => {
	const asset = (name: string) => readFile(join(import.meta.dir, '../assets', name));
	const png = await asset('icon.png');
	expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	// The opt-in Linux menu installer copies this exact file into hicolor/512x512.
	expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
	expect(png[25]).toBe(6); // RGBA: preserve the supplied artwork's transparency.
	const ico = await asset('icon.ico');
	expect(ico.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
	const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
		const offset = 6 + i * 16;
		expect(ico.readUInt32LE(offset + 12) + ico.readUInt32LE(offset + 8)).toBeLessThanOrEqual(ico.length);
		return ico[offset] || 256;
	});
	for (const size of [16, 32, 48, 256]) expect(sizes).toContain(size);
	const icns = await asset('icon.icns');
	expect(icns.toString('ascii', 0, 4)).toBe('icns');
	expect(icns.readUInt32BE(4)).toBe(icns.length);
	const frames: string[] = [];
	for (let offset = 8; offset < icns.length;) {
		frames.push(icns.toString('ascii', offset, offset + 4));
		const length = icns.readUInt32BE(offset + 4);
		expect(length).toBeGreaterThanOrEqual(8);
		offset += length;
		expect(offset).toBeLessThanOrEqual(icns.length);
	}
	for (const frame of ['ic07', 'ic08', 'ic09', 'ic10']) expect(frames).toContain(frame);
	const pkg = JSON.parse(await readFile(join(import.meta.dir, '../package.json'), 'utf8'));
	expect(pkg.scripts.bundle).not.toContain('generate-icon');
});
