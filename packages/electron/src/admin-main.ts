import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

import { createAdminWindow, registerAdminIpc } from './admin-app.js';
import { configureAdminResources } from './admin-resources.js';
import { ADMIN_DESKTOP_ID } from './admin-desktop.js';

configureAdminResources(app, process.resourcesPath);
if (process.platform === 'linux') app.setDesktopName(`${ADMIN_DESKTOP_ID}.desktop`);

if (process.platform === 'win32') app.setAppUserModelId(ADMIN_DESKTOP_ID);
app.setPath('userData', join(app.getPath('appData'), 'fhold-admin'));

void app
	.whenReady()
	.then(() => {
		registerAdminIpc();
		createAdminWindow();
	})
	.catch((error: unknown) => {
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
