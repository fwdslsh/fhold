#!/usr/bin/env node
/** Launch the freshly packaged native Admin without Docker or provider secrets. */
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedAdminAssets } from './validate-release-assets.mjs';
import { createHash } from 'node:crypto';

// Playwright drives the packaged app through Electron's standard inspector; the
// shipped Admin contains no smoke-test entry point.
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
	const virtual = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url)], {
		stdio: 'inherit'
	});
	if (virtual.error) throw new Error('Packaged Admin requires Xvfb or an accessible display');
	process.exit(virtual.status ?? 1);
}

const { _electron: electron } = createRequire(
	new URL('../packages/electron/package.json', import.meta.url)
)('playwright-core');
const version = process.env.VERSION;
if (!version) throw new Error('VERSION is required');
const packaged = resolve(process.env.ADMIN_SMOKE_DIRECTORY ?? 'packages/electron/dist/packages');
const generated = mkdtempSync(join(tmpdir(), 'fhold-packaged-smoke-'));
const profile = join(generated, 'profile');
const started = Date.now();
const progress = [];

function phase(name) {
	const value = { phase: name, elapsedMs: Date.now() - started };
	progress.push(value);
	console.log(JSON.stringify(value));
}

function run(command, args) {
	const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, cwd: generated });
	if (result.error || result.status !== 0) {
		throw new Error(
			`Packaged Admin command failed: ${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
		);
	}
	return result.stdout ?? '';
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function files(directory, root = directory) {
	return readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return files(path, root);
			if (!entry.isFile()) throw new Error(`Packaged Admin skeleton has a non-file: ${path}`);
			return [relative(root, path).replaceAll('\\', '/')];
		})
		.sort();
}

/** Exercise packaged resources after an inherited-environment relaunch, not just window startup. */
function verifySkeleton(resources) {
	const shipped = join(resources, 'skeleton');
	const built = fileURLToPath(new URL('../packages/electron/dist/skeleton', import.meta.url));
	const inventory = files(shipped);
	if (JSON.stringify(inventory) !== JSON.stringify(files(built)))
		throw new Error('Packaged Admin skeleton inventory differs from this build');
	for (const file of inventory)
		if (hash(readFileSync(join(shipped, file))) !== hash(readFileSync(join(built, file))))
			throw new Error(`Packaged Admin skeleton asset differs from this build: ${file}`);
}

async function verifyPackagedStartup(command, args, platform) {
	phase('launch');
	if (platform === 'linux') {
		// The isolated profile turns off the native updater's background check, as
		// an operator can in Admin; the smoke never contacts the update feed.
		const settings = join(profile, 'config', 'fhold-admin');
		mkdirSync(settings, { recursive: true });
		writeFileSync(
			join(settings, 'settings.json'),
			JSON.stringify({ updates: { channel: 'stable', automatic: false } })
		);
	}
	const admin = await electron.launch({
		executablePath: command,
		args,
		cwd: generated,
		timeout: 60_000,
		env: {
			...process.env,
			APPIMAGE: platform === 'linux' ? join(packaged, asset) : undefined,
			FH_HOME: join(generated, 'home'),
			// Model a native updater relaunch inheriting an obsolete AppImage mount.
			FH_REPO_ROOT: join(generated, 'obsolete-repo'),
			FH_SKELETON_DIR: join(generated, 'obsolete-mount/skeleton'),
			// Fresh host preferences, menu entries and caches; no production-profile writes.
			XDG_CONFIG_HOME: join(profile, 'config'),
			XDG_DATA_HOME: join(profile, 'share'),
			XDG_CACHE_HOME: join(profile, 'cache'),
			...(platform === 'linux' ? { HOME: profile } : {})
		}
	});
	let timeout;
	try {
		await Promise.race([
			(async () => {
				const main = await admin.evaluate(({ app }) => ({
					version: app.getVersion(),
					resources: process.resourcesPath,
					appData: app.getPath('appData'),
					executable: app.getPath('exe')
				}));
				if (main.version !== version)
					throw new Error(`Release smoke expected ${version}, found ${main.version}.`);
				verifySkeleton(main.resources);
				if (platform === 'windows') {
					const shortcut = await admin.evaluate(
						({ shell }, path) => shell.readShortcutLink(path),
						join(main.appData, 'Microsoft/Windows/Start Menu/Programs/fhold Admin.lnk')
					);
					if (
						// NSIS and Windows may express the same path using long or DOS 8.3 names.
						realpathSync.native(shortcut.target).toLowerCase() !==
							realpathSync.native(main.executable).toLowerCase() ||
						shortcut.appUserModelId !== 'dev.fwdslsh.fhold.admin'
					)
						throw new Error(
							`Installed Start menu shortcut differs: ${JSON.stringify({ target: shortcut.target, executable: main.executable, appUserModelId: shortcut.appUserModelId })}`
						);
				}
				phase('renderer loading');
				const page = await admin.firstWindow();
				await page.waitForLoadState('load');
				phase('preload and welcome');
				const welcome = await page.evaluate(async () => {
					if (typeof window.fholdAdmin?.snapshot !== 'function')
						throw new Error('Packaged Admin preload bridge is missing.');
					return window.fholdAdmin.welcome();
				});
				if (welcome.selectedInstance || welcome.recentInstances.length)
					throw new Error('Smoke profile is not fresh.');
				await page
					.waitForFunction(
						() =>
							document.body.dataset.phase === 'welcome' &&
							!document.querySelector('#instance-welcome')?.hidden &&
							document.querySelector('#app-shell')?.hidden &&
							document.querySelector('#begin-new-instance'),
						undefined,
						{ timeout: 10_000, polling: 50 }
					)
					.catch(() => {
						throw new Error('Packaged Admin did not render its welcome screen.');
					});
				phase('app settings');
				const preferences = await page.evaluate(() => window.fholdAdmin.appSettings());
				// Linux reads the seeded preference; elsewhere the profile is fresh.
				if (
					preferences.settings.updates.channel !== 'stable' ||
					preferences.settings.updates.automatic !== (platform !== 'linux')
				)
					throw new Error('Packaged Admin update preferences are incorrect.');
				if (platform === 'linux') {
					phase('desktop installation');
					const before = await page.evaluate(() => window.fholdAdmin.desktopStatus());
					if (!before.supported || before.installed)
						throw new Error('Menu smoke profile is not fresh.');
					const installed = await page.evaluate(() => window.fholdAdmin.installDesktop());
					if (!installed.installed) throw new Error('Native menu installation failed.');
				}
				phase('settings and setup navigation');
				await page.evaluate((welcome) => {
					document.querySelector('#instance-welcome [data-admin-settings]').click();
					if (
						document.querySelector('#admin-settings').hidden ||
						!document.querySelector('#hosting-manager').closest('#admin-settings')
					)
						throw new Error('Admin settings page did not open.');
					document.querySelector('#admin-settings-back').click();
					if (!document.querySelector('#admin-settings').hidden)
						throw new Error('Admin settings did not return to Welcome.');
					const name = document.querySelector('#install-instance-name');
					const folder = document.querySelector('#install-home');
					if (!document.querySelector('#install-section').hidden)
						throw new Error('Setup form was shown before choosing setup.');
					document.querySelector('#begin-new-instance').click();
					if (
						document.querySelector('#install-section').hidden ||
						document.activeElement !== name
					)
						throw new Error('Setup did not reveal and focus naming.');
					if (document.querySelector('#install-advanced').open)
						throw new Error('Advanced settings were not collapsed initially.');
					name.value = 'smoke-agent';
					name.dispatchEvent(new Event('input', { bubbles: true }));
					if (folder.value !== `${welcome.instancesDirectory}/smoke-agent`)
						throw new Error('Named instance folder was not suggested.');
					folder.value = welcome.defaultInstance.homeDir;
					name.value = 'custom-agent';
					name.dispatchEvent(new Event('input', { bubbles: true }));
					if (folder.value !== welcome.defaultInstance.homeDir)
						throw new Error('Custom folder was overwritten.');
				}, welcome);
				// Validate the native selection bridge without installing a stack.
				// Setup now chooses this target as part of Install, not a second form.
				phase('prepare empty instance');
				await page.evaluate(() =>
					window.fholdAdmin.prepareNewInstance({
						kind: 'local',
						homeDir: document.querySelector('#install-home').value,
						name: document.querySelector('#install-instance-name').value
					})
				);
				phase('snapshot and Docker readiness');
				const snapshot = await page.evaluate(() => window.fholdAdmin.snapshot());
				if (snapshot.lifecycle.state !== 'known' || snapshot.lifecycle.value !== 'not-installed')
					throw new Error('Smoke home is not fresh.');
				if (snapshot.docker?.config.deployment.projectName !== 'custom-agent')
					throw new Error('New instance name did not reach setup.');
				phase('complete');
			})(),
			new Promise((_resolve, reject) => {
				// This smoke includes a fresh-home snapshot, not just renderer startup.
				// Readiness can spend 10s on each Docker context/info/context/Compose call;
				// allow those existing bounds plus the 10s welcome wait and launch overhead.
				timeout = setTimeout(
					() =>
						reject(
							new Error(
								`Packaged Admin startup timed out during ${progress.at(-1)?.phase ?? 'startup'}.`
							)
						),
					60_000
				);
			})
		]);
	} finally {
		clearTimeout(timeout);
		await admin.close();
	}
}

const platform =
	process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
const arch = platform === 'linux' && process.arch === 'x64' ? 'x86_64' : process.arch;
const asset =
	process.env.ADMIN_SMOKE_ARTIFACT ||
	expectedAdminAssets(version).find((name) =>
		platform === 'windows' ? name.endsWith('.exe') : name.includes(`-${arch}-${platform}.`)
	);
try {
	if (!asset) throw new Error('No release artifact supports this runner');
	let command;
	const args = ['--disable-gpu'];
	if (platform === 'mac') {
		run('unzip', ['-q', join(packaged, asset), '-d', generated]);
		command = join(generated, 'fhold Admin.app', 'Contents', 'MacOS', 'fhold Admin');
		const contents = join(generated, 'fhold Admin.app/Contents');
		const id = run('/usr/libexec/PlistBuddy', [
			'-c',
			'Print :CFBundleIdentifier',
			join(contents, 'Info.plist')
		]).trim();
		const icon = run('/usr/libexec/PlistBuddy', [
			'-c',
			'Print :CFBundleIconFile',
			join(contents, 'Info.plist')
		]).trim();
		if (id !== 'dev.fwdslsh.fhold.admin' || !existsSync(join(contents, 'Resources', icon)))
			throw new Error('macOS bundle identity or Dock icon is missing');
	} else if (platform === 'windows') {
		const installation = join(generated, 'installed');
		run(join(packaged, asset), ['/S', `/D=${installation}`]);
		command = join(installation, 'fhold Admin.exe');
	} else {
		run(join(packaged, asset), ['--appimage-extract']);
		// This gate runs for release and PR previews before publication. Require
		// both actual resources, byte-identical to this build, not release URLs.
		for (const [helperArch, machine] of [
			['x64', 62],
			['arm64', 183]
		]) {
			const shipped = readFileSync(
				join(generated, 'squashfs-root/resources/management', `fhold-linux-${helperArch}`)
			);
			const built = readFileSync(resolve(`packages/cli/embedded/fhold-linux-${helperArch}`));
			if (shipped.readUInt16LE(18) !== machine || hash(shipped) !== hash(built))
				throw new Error(`Packaged Admin ${helperArch} management helper differs from this build`);
		}
		command = join(generated, 'squashfs-root', 'fhold-admin');
		if (!process.env.DISPLAY && process.env.XDG_SESSION_TYPE === 'wayland')
			args.push('--ozone-platform=wayland');
	}
	await verifyPackagedStartup(command, args, platform);
	console.log(JSON.stringify(progress));
	console.log(`Verified packaged Admin startup: ${asset}`);
} finally {
	console.log(`Packaged smoke fixtures retained at ${generated}`);
}
