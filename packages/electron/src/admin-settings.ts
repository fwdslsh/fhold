import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type UpdateChannel = 'stable' | 'beta' | 'alpha';
export type AdminSettings = { updates: { channel: UpdateChannel; automatic: boolean } };

export function parseAdminSettings(value: unknown): AdminSettings {
	if (!value || typeof value !== 'object' || !('updates' in value))
		throw new Error('Choose the Admin update preferences.');
	const updates = value.updates;
	if (
		!updates ||
		typeof updates !== 'object' ||
		!('channel' in updates) ||
		typeof updates.channel !== 'string' ||
		!['stable', 'beta', 'alpha'].includes(updates.channel) ||
		!('automatic' in updates) ||
		typeof updates.automatic !== 'boolean'
	)
		throw new Error('Choose Stable, Beta or Alpha and whether to download automatically.');
	return { updates: { channel: updates.channel as UpdateChannel, automatic: updates.automatic } };
}

// App-local preferences, never instance intent, remote-host settings or credentials.
export class AdminSettingsStore {
	private value: AdminSettings = { updates: { channel: 'stable', automatic: true } };
	readonly path: string;
	error?: string;
	constructor(private readonly directory: string) {
		this.path = join(directory, 'settings.json');
		try {
			this.value = parseAdminSettings(JSON.parse(readFileSync(this.path, 'utf8')));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.error =
					'Admin preferences could not be loaded. Using Stable updates until you save your preferences.';
				console.warn('[admin-settings]', error);
			}
		}
	}
	read(): AdminSettings {
		return structuredClone(this.value);
	}
	save(value: unknown): AdminSettings {
		const next = parseAdminSettings(value);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, this.path);
		this.value = next;
		this.error = undefined;
		return this.read();
	}
}
