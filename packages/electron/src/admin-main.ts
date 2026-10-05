import { app, BrowserWindow } from 'electron';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { createAdminWindow, registerAdminIpc } from './admin-app.js';

if (process.platform === 'win32') app.setAppUserModelId('dev.fwdslsh.fhold.admin');
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
		// Packaged startup uses the real preload and CSP, with no production-profile writes.
		app.setPath('userData', mkdtempSync(join(tmpdir(), 'fhold-admin-release-profile-')));
	}
}

async function verifyPackagedStartup(window: BrowserWindow): Promise<void> {
	let timeout: NodeJS.Timeout | undefined;
	try {
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
					const name = document.querySelector('#new-instance-name');
					const folder = document.querySelector('#new-instance-home');
					if (!document.querySelector('#new-instance-section').hidden) throw new Error('Setup form was shown before choosing setup.');
					document.querySelector('#begin-new-instance').click();
					if (document.querySelector('#new-instance-section').hidden || document.activeElement !== name) throw new Error('Setup did not reveal and focus naming.');
					name.value = 'smoke-agent';
					name.dispatchEvent(new Event('input', {bubbles:true}));
					if (folder.value !== welcome.instancesDirectory + '/smoke-agent') throw new Error('Named instance folder was not suggested.');
					folder.value = welcome.defaultInstance.homeDir;
					name.value = 'custom-agent';
					name.dispatchEvent(new Event('input', {bubbles:true}));
					if (folder.value !== welcome.defaultInstance.homeDir) throw new Error('Custom folder was overwritten.');
				})()`);
				const selected = new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()));
				await window.webContents.executeJavaScript("document.querySelector('#new-instance-form').requestSubmit()");
				await selected;
				await window.webContents.executeJavaScript(`(async () => {
					const snapshot = await window.fholdAdmin.snapshot();
					if (snapshot.phase !== 'not_installed') throw new Error('Smoke home is not fresh.');
					if (snapshot.config.deployment.projectName !== 'custom-agent') throw new Error('New instance name did not reach setup.');
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
