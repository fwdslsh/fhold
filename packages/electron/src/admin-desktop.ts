import {
	copyFile,
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const ADMIN_DESKTOP_ID = 'dev.fwdslsh.fhold.admin';
export const ADMIN_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512] as const;
const runFile = promisify(execFile);
type DesktopCommand = (
	file: string,
	args: string[],
	options: { timeout: number; env: NodeJS.ProcessEnv }
) => Promise<unknown>;

/** Let the desktop invalidate its own caches; never delete a user's cache or restart their shell. */
export async function refreshDesktopIcons(
	dataHome: string,
	environment = process.env,
	run: DesktopCommand = runFile
): Promise<void> {
	const now = new Date();
	// freedesktop icon-theme implementations watch the top-level directory, not individual PNGs.
	await utimes(join(dataHome, 'icons/hicolor'), now, now);
	await utimes(join(dataHome, 'icons'), now, now);
	const options = { timeout: 5000, env: { ...environment, XDG_DATA_HOME: dataHome } };
	try {
		await run('xdg-icon-resource', ['forceupdate', '--mode', 'user'], options);
	} catch {
		console.warn(
			'[admin-desktop] Native icon-cache refresh unavailable; directory changes are published.'
		);
	}
	if (environment.XDG_CURRENT_DESKTOP?.split(':').includes('KDE')) {
		try {
			await run('kbuildsycoca6', [], options);
		} catch {
			console.warn(
				'[admin-desktop] KDE menu refresh unavailable; reopen the menu to reload its entry.'
			);
		}
		try {
			// Native KIconLoader::emitChange(Desktop): also invalidate the running panel's pixmaps.
			await run(
				'dbus-send',
				[
					'--session',
					'--type=signal',
					'/KIconLoader',
					'org.kde.KIconLoader.iconChanged',
					'int32:0'
				],
				options
			);
		} catch {
			console.warn(
				'[admin-desktop] KDE icon notification unavailable; icons refresh on next login.'
			);
		}
	}
}

type DesktopEnvironment = {
	platform: string;
	packaged: boolean;
	appImage?: string;
	home: string;
	dataHome?: string;
	icons: string;
	version: string;
};
export type DesktopStatus = {
	supported: boolean;
	installed: boolean;
	replacesExistingCopy: boolean;
	runningInstalledCopy: boolean;
	appImage: string;
	version: string;
};

function escapeValue(value: string): string {
	return value
		.replaceAll('\\', '\\\\')
		.replaceAll('\n', '\\n')
		.replaceAll('\r', '\\r')
		.replaceAll('\t', '\\t');
}

/** Desktop Entry string decoding precedes Exec quoting; percent is a field-code escape. */
export function desktopEntry(appImage: string): string {
	const argument = escapeValue(`"${appImage.replaceAll('%', '%%').replace(/(["`$\\])/g, '\\$1')}"`);
	return `[Desktop Entry]\nVersion=1.0\nType=Application\nName=fhold Admin\nComment=Manage your fhold agents\nExec=${argument}\nIcon=${ADMIN_DESKTOP_ID}\nTerminal=false\nCategories=Utility;\nStartupNotify=true\nStartupWMClass=${ADMIN_DESKTOP_ID}\n`;
}

/** Opt-in per-user integration. Native desktop refresh only; no instance access. */
export class AdminDesktop {
	readonly paths: { appImage: string; entry: string; icon: string };
	private readonly dataHome: string;
	private pending?: Promise<DesktopStatus>;
	constructor(
		private readonly environment: DesktopEnvironment,
		private readonly notify: (dataHome: string) => Promise<void> = refreshDesktopIcons
	) {
		const data =
			environment.dataHome && isAbsolute(environment.dataHome)
				? environment.dataHome
				: join(environment.home, '.local/share');
		this.dataHome = data;
		this.paths = {
			// A versionless filename is preserved by electron-updater.
			appImage: join(environment.home, '.local/bin/fhold-admin.AppImage'),
			entry: join(data, `applications/${ADMIN_DESKTOP_ID}.desktop`),
			icon: join(data, `icons/hicolor/512x512/apps/${ADMIN_DESKTOP_ID}.png`)
		};
	}
	private iconPath(size: number): string {
		return join(this.dataHome, `icons/hicolor/${size}x${size}/apps/${ADMIN_DESKTOP_ID}.png`);
	}
	async status(): Promise<DesktopStatus> {
		const env = this.environment;
		const supported =
			env.platform === 'linux' && env.packaged && !!env.appImage && isAbsolute(env.appImage);
		const runningInstalledCopy =
			supported && !!env.appImage && resolve(env.appImage) === resolve(this.paths.appImage);
		const [entry, image, icon] = await Promise.all([
			readFile(this.paths.entry, 'utf8').catch(() => ''),
			stat(this.paths.appImage).catch(() => undefined),
			stat(this.paths.icon).catch(() => undefined)
		]);
		const installed =
			entry.startsWith(desktopEntry(this.paths.appImage)) &&
			!!image?.isFile() &&
			!!(image.mode & 0o111) &&
			!!icon?.isFile();
		return {
			supported,
			installed,
			// A desktop entry cannot tell which version self-update has installed.
			// Treat another download as an explicit replacement, never an upgrade.
			replacesExistingCopy: !!image?.isFile() && !runningInstalledCopy,
			runningInstalledCopy,
			appImage: this.paths.appImage,
			version: env.version
		};
	}
	install(confirmReplacement: () => Promise<boolean> = async () => false): Promise<DesktopStatus> {
		// One click/copy at a time, including repeated IPC requests.
		this.pending ??= this.performInstall(confirmReplacement).finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	}
	/** Maintain an existing opt-in installation after native AppImage self-update. */
	refresh(): Promise<DesktopStatus> {
		this.pending ??= this.performInstall(async () => false, true).finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	}
	busy(): boolean {
		return this.pending !== undefined;
	}
	async finish(): Promise<void> {
		await this.pending?.catch(() => undefined);
	}
	private async performInstall(
		confirmReplacement: () => Promise<boolean>,
		refreshOnly = false
	): Promise<DesktopStatus> {
		const status = await this.status();
		const env = this.environment;
		const appImage = env.appImage;
		const entry = await readFile(this.paths.entry, 'utf8').catch(() => '');
		// Downloads/previews must not silently replace installed assets, and custom launchers stay untouched.
		if (
			refreshOnly &&
			(!status.runningInstalledCopy || entry !== desktopEntry(this.paths.appImage))
		)
			return status;
		if (!status.supported || !appImage)
			throw Error('Menu installation is available in the Linux AppImage.');
		if (status.replacesExistingCopy && !(await confirmReplacement())) return status;
		const icons = await Promise.all(
			ADMIN_ICON_SIZES.map(async (size) => ({
				path: this.iconPath(size),
				bytes: await readFile(join(env.icons, `${size}x${size}.png`))
			}))
		);
		if (
			refreshOnly &&
			(
				await Promise.all(
					icons.map(
						async ({ path, bytes }) =>
							(await readFile(path).catch(() => undefined))?.equals(bytes) ?? false
					)
				)
			).every(Boolean)
		)
			return status;
		const staged: { temporary: string; destination: string }[] = [];
		const stage = async (
			destination: string,
			mode: number,
			write: (temporary: string) => Promise<unknown>
		) => {
			await mkdir(dirname(destination), { recursive: true });
			const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
			staged.push({ temporary, destination });
			await write(temporary);
			await chmod(temporary, mode);
		};
		try {
			if (!status.runningInstalledCopy)
				await stage(this.paths.appImage, 0o755, (temporary) => copyFile(appImage, temporary));
			for (const { path, bytes } of icons)
				await stage(path, 0o644, (temporary) => writeFile(temporary, bytes, { flag: 'wx' }));
			await stage(this.paths.entry, 0o644, (temporary) =>
				writeFile(temporary, desktopEntry(this.paths.appImage), { flag: 'wx' })
			);
			// Publish the entry last, after its executable and icon are available.
			for (const { temporary, destination } of staged) await rename(temporary, destination);
		} finally {
			await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })));
		}
		try {
			await this.notify(this.dataHome);
		} catch {
			console.warn('[admin-desktop] Menu files updated, but the desktop could not be notified.');
		}
		return this.status();
	}
}
