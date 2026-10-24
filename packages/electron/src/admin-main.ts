import { app, BrowserWindow, shell } from 'electron';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { createAdminWindow, registerAdminIpc } from './admin-app.js';
import { configureAdminResources } from './admin-resources.js';
import { ADMIN_DESKTOP_ID } from './admin-desktop.js';
import { preflightHomeSeed } from '@fhold/lib';

configureAdminResources(app, process.resourcesPath);
if (process.platform === 'linux') app.setDesktopName(`${ADMIN_DESKTOP_ID}.desktop`);

if (process.platform === 'win32') app.setAppUserModelId(ADMIN_DESKTOP_ID);
app.setPath('userData', join(app.getPath('appData'), 'fhold-admin'));

const releaseSmoke = process.argv.includes('--fhold-release-smoke');
function finishReleaseSmoke(error?: string): void {
	const report = process.env.FH_ADMIN_SMOKE_REPORT;
	if (report) {
		if (!isAbsolute(report)) throw new Error('Release smoke report must be an absolute path.');
		writeFileSync(report, JSON.stringify({ ok: !error, version: app.getVersion(), error }), {
			flag: 'wx',
			mode: 0o600
		});
	} else if (error) {
		process.stderr.write(`${error}\n`);
	} else {
		process.stdout.write('FH_ADMIN_SMOKE_OK\n');
	}
	app.exit(error ? 1 : 0);
}
if (releaseSmoke) {
	const home = process.env.FH_HOME;
	const expectedVersion = process.env.FH_ADMIN_SMOKE_VERSION;
	if (expectedVersion && app.getVersion() !== expectedVersion) {
		finishReleaseSmoke(`Release smoke expected ${expectedVersion}, found ${app.getVersion()}.`);
	} else if (!home || !isAbsolute(home) || (existsSync(home) && readdirSync(home).length !== 0)) {
		finishReleaseSmoke('Release smoke requires an absolute, empty FH_HOME.');
	} else {
		// Exercise packaged resources, not just window startup, after inherited-env relaunches.
		try {
			preflightHomeSeed(home);
		} catch (error) {
			finishReleaseSmoke(error instanceof Error ? error.message : String(error));
		}
		// Packaged startup uses the real preload and CSP, with no production-profile writes.
		app.setPath('userData', mkdtempSync(join(tmpdir(), 'fhold-admin-release-profile-')));
		process.env.XDG_CONFIG_HOME = join(app.getPath('userData'), 'host-config');
		if (process.env.FH_ADMIN_SMOKE_DESKTOP === '1' && process.platform === 'linux') {
			app.setPath('home', app.getPath('userData'));
			process.env.XDG_DATA_HOME = join(app.getPath('userData'), 'share');
		}
	}
}

async function verifyPackagedStartup(window: BrowserWindow): Promise<void> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		if (process.env.FH_ADMIN_SMOKE_DESKTOP === '1' && process.platform === 'win32') {
			const shortcut = shell.readShortcutLink(
				join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs/fhold Admin.lnk')
			);
			if (
				shortcut.target.toLowerCase() !== app.getPath('exe').toLowerCase() ||
				shortcut.appUserModelId !== ADMIN_DESKTOP_ID
			)
				throw new Error(
					'Installed Start menu shortcut does not match the Admin executable and taskbar identity.'
				);
		}
		await Promise.race([
			(async () => {
				if (window.webContents.isLoading()) {
					await new Promise<void>((resolve, reject) => {
						window.webContents.once('did-finish-load', () => resolve());
						window.webContents.once('did-fail-load', (_event, code, description) => {
							reject(new Error(`Admin renderer failed to load (${code}): ${description}`));
						});
					});
				}
				await window.webContents.executeJavaScript(`(async () => {
					if (typeof window.fholdAdmin?.snapshot !== 'function') {
						throw new Error('Packaged Admin preload bridge is missing.');
					}
					const welcome = await window.fholdAdmin.welcome();
					if (welcome.selectedInstance || welcome.recentInstances.length) throw new Error('Smoke profile is not fresh.');
					await new Promise((resolve, reject) => {
						const started = Date.now();
						const check = () => {
							if (document.body.dataset.phase === 'welcome' &&
								!document.querySelector('#instance-welcome')?.hidden &&
									document.querySelector('#app-shell')?.hidden &&
									document.querySelector('#begin-new-instance')) return resolve();
							if (Date.now() - started > 10000) return reject(new Error('Packaged Admin did not render its welcome screen.'));
							setTimeout(check, 50);
						};
						check();
					});
					const preferences = await window.fholdAdmin.appSettings();
					if (preferences.settings.updates.channel !== 'stable' || !preferences.settings.updates.automatic) throw new Error('Packaged Admin update defaults are incorrect.');
					if (${JSON.stringify(process.env.FH_ADMIN_SMOKE_DESKTOP === '1' && process.platform === 'linux')}) {
						const before = await window.fholdAdmin.desktopStatus();
						if (!before.supported || before.installed) throw new Error('Menu smoke profile is not fresh.');
						const installed = await window.fholdAdmin.installDesktop();
						if (!installed.installed || installed.needsUpdate) throw new Error('Native menu installation failed.');
					}
					document.querySelector('#instance-welcome [data-admin-settings]').click();
					if (document.querySelector('#admin-settings').hidden || !document.querySelector('#hosting-manager').closest('#admin-settings')) throw new Error('Admin settings page did not open.');
					document.querySelector('#admin-settings-back').click();
					if (!document.querySelector('#admin-settings').hidden) throw new Error('Admin settings did not return to Welcome.');
					const name = document.querySelector('#install-instance-name');
					const folder = document.querySelector('#install-home');
					if (!document.querySelector('#install-section').hidden) throw new Error('Setup form was shown before choosing setup.');
					document.querySelector('#begin-new-instance').click();
					if (document.querySelector('#install-section').hidden || document.activeElement !== name) throw new Error('Setup did not reveal and focus naming.');
					if (document.querySelector('#install-advanced').open) throw new Error('Advanced settings were not collapsed initially.');
					name.value = 'smoke-agent';
					name.dispatchEvent(new Event('input', {bubbles:true}));
					if (folder.value !== welcome.instancesDirectory + '/smoke-agent') throw new Error('Named instance folder was not suggested.');
					folder.value = welcome.defaultInstance.homeDir;
					name.value = 'custom-agent';
					name.dispatchEvent(new Event('input', {bubbles:true}));
					if (folder.value !== welcome.defaultInstance.homeDir) throw new Error('Custom folder was overwritten.');
					// Validate the native selection bridge without installing a stack.
					// Setup now chooses this target as part of Install, not a second form.
					await window.fholdAdmin.prepareNewInstance({kind:'local',homeDir:folder.value,name:name.value});
					const snapshot = await window.fholdAdmin.snapshot();
					if (snapshot.lifecycle.state !== 'known' || snapshot.lifecycle.value !== 'not-installed')
						throw new Error('Smoke home is not fresh.');
					if (snapshot.docker?.config.deployment.projectName !== 'custom-agent') throw new Error('New instance name did not reach setup.');
				})()`);
			})(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error('Packaged Admin startup timed out.')), 20_000);
			})
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

void app
	.whenReady()
	.then(async () => {
		registerAdminIpc();
		const window = createAdminWindow();
		if (releaseSmoke) {
			await verifyPackagedStartup(window);
			finishReleaseSmoke();
		}
	})
	.catch((error: unknown) => {
		if (releaseSmoke) {
			finishReleaseSmoke(error instanceof Error ? error.message : String(error));
			return;
		}
		process.stderr.write(
			`fhold Admin could not start: ${error instanceof Error ? error.message : String(error)}\n`
		);
		app.exit(1);
	});
app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) createAdminWindow();
});
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
