import { copyFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const ADMIN_DESKTOP_ID = 'dev.fwdslsh.fhold.admin';
type DesktopEnvironment = {
	platform: string;
	packaged: boolean;
	appImage?: string;
	home: string;
	dataHome?: string;
	icon: string;
	version: string;
};
export type DesktopStatus = {
	supported: boolean;
	installed: boolean;
	needsUpdate: boolean;
	runningInstalledCopy: boolean;
	appImage: string;
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

/** Opt-in per-user integration. No host tools, shell launchers or instance access. */
export class AdminDesktop {
	readonly paths: { appImage: string; entry: string; icon: string };
	private pending?: Promise<DesktopStatus>;
	constructor(private readonly environment: DesktopEnvironment) {
		const data =
			environment.dataHome && isAbsolute(environment.dataHome)
				? environment.dataHome
				: join(environment.home, '.local/share');
		this.paths = {
			// A versionless filename is preserved by electron-updater.
			appImage: join(environment.home, '.local/bin/fhold-admin.AppImage'),
			entry: join(data, `applications/${ADMIN_DESKTOP_ID}.desktop`),
			icon: join(data, `icons/hicolor/512x512/apps/${ADMIN_DESKTOP_ID}.png`)
		};
	}
	async status(): Promise<DesktopStatus> {
		const env = this.environment;
		const supported =
			env.platform === 'linux' && env.packaged && !!env.appImage && isAbsolute(env.appImage);
		const runningInstalledCopy =
			supported && !!env.appImage && resolve(env.appImage) === resolve(this.paths.appImage);
		const [entry, image, icon, source] = await Promise.all([
			readFile(this.paths.entry, 'utf8').catch(() => ''),
			stat(this.paths.appImage).catch(() => undefined),
			stat(this.paths.icon).catch(() => undefined),
			env.appImage ? stat(env.appImage).catch(() => undefined) : undefined
		]);
		const installed =
			entry.startsWith(desktopEntry(this.paths.appImage)) &&
			!!image?.isFile() &&
			!!(image.mode & 0o111) &&
			!!icon?.isFile();
		const current =
			runningInstalledCopy ||
			(entry.includes(`\nX-fhold-Version=${escapeValue(env.version)}\n`) &&
				source?.size === image?.size);
		return {
			supported,
			installed,
			needsUpdate: installed && !current,
			runningInstalledCopy,
			appImage: this.paths.appImage
		};
	}
	install(): Promise<DesktopStatus> {
		// One click/copy at a time, including repeated IPC requests.
		this.pending ??= this.performInstall().finally(() => {
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
	private async performInstall(): Promise<DesktopStatus> {
		const status = await this.status();
		const env = this.environment;
		const appImage = env.appImage;
		if (!status.supported || !appImage)
			throw Error('Menu installation is available in the Linux AppImage.');
		const icon = await readFile(env.icon);
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
			await stage(this.paths.icon, 0o644, (temporary) =>
				writeFile(temporary, icon, { flag: 'wx' })
			);
			await stage(this.paths.entry, 0o644, (temporary) =>
				writeFile(
					temporary,
					`${desktopEntry(this.paths.appImage)}X-fhold-Version=${escapeValue(env.version)}\n`,
					{ flag: 'wx' }
				)
			);
			// Publish the entry last, after its executable and icon are available.
			for (const { temporary, destination } of staged) await rename(temporary, destination);
		} finally {
			await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })));
		}
		return this.status();
	}
}
