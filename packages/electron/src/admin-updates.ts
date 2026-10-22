import type { AppImageUpdater } from 'electron-updater';
import type { AdminSettings, AdminSettingsStore, UpdateChannel } from './admin-settings.js';

type NativeUpdater = Pick<
	AppImageUpdater,
	| 'autoDownload'
	| 'autoInstallOnAppQuit'
	| 'allowPrerelease'
	| 'allowDowngrade'
	| 'channel'
	| 'on'
	| 'removeAllListeners'
	| 'checkForUpdates'
	| 'downloadUpdate'
	| 'quitAndInstall'
>;

export type AdminUpdateStatus = {
	version: string;
	phase: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing';
	supported: boolean;
	unavailableReason?: string;
	availableVersion?: string;
	progress?: number;
	checkedAt?: string;
	error?: string;
};
export type AdminAppSnapshot = {
	settings: AdminSettings;
	settingsError?: string;
	update: AdminUpdateStatus;
};

export const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000;

function updateError(error: unknown, channel: UpdateChannel): string {
	const raw = error instanceof Error ? error.message : String(error);
	if (/\b(?:403|429)\b|rate.?limit/i.test(raw))
		return 'GitHub has temporarily limited update requests. Try again later.';
	if (
		/404|ERR_UPDATER_(?:NO_PUBLISHED_VERSIONS|CHANNEL_FILE_NOT_FOUND|LATEST_VERSION_NOT_FOUND)/.test(
			raw
		)
	)
		return `No ${channel} Admin update feed is available yet. You can check again later or choose another channel.`;
	if (/EACCES|EPERM/.test(raw))
		return 'Admin could not replace its AppImage. Move it to a folder you can write to, or download the update manually.';
	return 'Admin could not complete the update. Check your internet connection and try again, or download it from GitHub.';
}

// Owns only this desktop process. All release discovery, checksums, caching and
// AppImage replacement belong to electron-updater, not a second update protocol.
export class AdminUpdates {
	private updater?: NativeUpdater;
	private pending?: Promise<AdminAppSnapshot>;
	private lastCheck = 0;
	private timer?: ReturnType<typeof setInterval>;
	private status: AdminUpdateStatus;
	constructor(
		private readonly store: AdminSettingsStore,
		private readonly options: {
			version: string;
			unavailableReason?: string;
			createUpdater: () => NativeUpdater;
			changed?: (snapshot: AdminAppSnapshot) => void;
		}
	) {
		this.status = {
			version: options.version,
			phase: 'idle',
			supported: !options.unavailableReason,
			unavailableReason: options.unavailableReason
		};
	}
	snapshot(): AdminAppSnapshot {
		return {
			settings: this.store.read(),
			settingsError: this.store.error,
			update: { ...this.status }
		};
	}
	private publish(change: Partial<AdminUpdateStatus>): void {
		Object.assign(this.status, change);
		this.options.changed?.(this.snapshot());
	}
	private native(): NativeUpdater {
		if (this.updater) return this.updater;
		const updater = this.options.createUpdater();
		const { channel, automatic } = this.store.read().updates;
		updater.autoDownload = automatic;
		updater.autoInstallOnAppQuit = true;
		updater.allowPrerelease = channel !== 'stable';
		// A new instance keeps Stable on the default GitHub feed without touching
		// private channel fields or inventing a non-existent stable-linux.yml.
		if (channel !== 'stable') updater.channel = channel;
		updater.allowDowngrade = false;
		updater.on('update-available', (info) =>
			this.publish({
				phase: updater.autoDownload ? 'downloading' : 'available',
				availableVersion: info.version,
				error: undefined
			})
		);
		updater.on('update-not-available', () =>
			this.publish({ phase: 'idle', availableVersion: undefined, error: undefined })
		);
		updater.on('download-progress', (info) =>
			this.publish({ phase: 'downloading', progress: Math.round(info.percent) })
		);
		updater.on('update-downloaded', (info) =>
			this.publish({
				phase: 'ready',
				availableVersion: info.version,
				progress: undefined,
				error: undefined
			})
		);
		updater.on('error', (error) => {
			console.warn('[admin-updates]', error);
			this.publish({
				...(this.status.phase === 'installing' ? { phase: 'ready' as const } : {}),
				error: updateError(error, channel)
			});
		});
		this.updater = updater;
		return updater;
	}
	save(value: unknown): AdminAppSnapshot {
		if (this.pending || this.status.phase === 'installing')
			throw new Error(
				'Wait for the current Admin update to finish before changing update preferences.'
			);
		const previous = this.store.read();
		const next = this.store.save(value);
		if (previous.updates.channel !== next.updates.channel) {
			// A staged beta must not install after the user switches to Stable.
			if (this.updater) {
				this.updater.autoInstallOnAppQuit = false;
				this.updater.removeAllListeners();
			}
			this.updater = undefined;
			this.lastCheck = 0;
			this.publish({
				phase: 'idle',
				availableVersion: undefined,
				progress: undefined,
				error: undefined,
				checkedAt: undefined
			});
		} else if (this.updater) this.updater.autoDownload = next.updates.automatic;
		this.options.changed?.(this.snapshot());
		if (next.updates.automatic)
			queueMicrotask(() => {
				if (this.status.phase === 'available') void this.download();
				else void this.backgroundCheck();
			});
		return this.snapshot();
	}
	check(): Promise<AdminAppSnapshot> {
		if (this.pending) return this.pending;
		if (!this.status.supported || ['ready', 'installing'].includes(this.status.phase))
			return Promise.resolve(this.snapshot());
		return this.perform('checking', async () => {
			this.lastCheck = Date.now();
			const result = await this.native().checkForUpdates();
			this.publish({ checkedAt: new Date().toISOString() });
			await result?.downloadPromise;
		});
	}
	download(): Promise<AdminAppSnapshot> {
		if (this.pending) return this.pending;
		if (!this.status.supported || this.status.phase !== 'available')
			return Promise.resolve(this.snapshot());
		return this.perform('downloading', async () => {
			await this.native().downloadUpdate();
		});
	}
	private perform(
		phase: 'checking' | 'downloading',
		action: () => Promise<void>
	): Promise<AdminAppSnapshot> {
		const fallback = phase === 'downloading' ? 'available' : 'idle';
		this.publish({ phase, error: undefined });
		// Defer one microtask so listeners always observe the single-flight guard.
		this.pending = Promise.resolve()
			.then(action)
			.catch((error: unknown) => {
				console.warn('[admin-updates]', error);
				this.publish({
					phase: fallback,
					progress: undefined,
					error: updateError(error, this.store.read().updates.channel)
				});
			})
			.then(() => this.snapshot())
			.finally(() => {
				this.pending = undefined;
			});
		return this.pending;
	}
	install(): void {
		if (!this.status.supported || this.status.phase !== 'ready')
			throw new Error('Download an Admin update before restarting to install it.');
		this.publish({ phase: 'installing', error: undefined });
		try {
			this.native().quitAndInstall(false, true);
		} catch (error) {
			console.warn('[admin-updates]', error);
			this.publish({
				phase: 'ready',
				error: updateError(error, this.store.read().updates.channel)
			});
		}
	}
	async backgroundCheck(): Promise<void> {
		if (this.store.read().updates.automatic && Date.now() - this.lastCheck >= UPDATE_CHECK_INTERVAL)
			await this.check();
	}
	start(): void {
		if (!this.status.supported || this.timer) return;
		void this.backgroundCheck();
		this.timer = setInterval(() => void this.backgroundCheck(), UPDATE_CHECK_INTERVAL);
		this.timer.unref();
	}
}
