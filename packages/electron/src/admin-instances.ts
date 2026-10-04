import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { classifyInstall, defaultFholdHome, isInstanceName, readStackConfig, resolveFholdHome, writeFileAtomic } from '@fhold/lib';
import type { AdminInstance, AdminWelcome } from './admin-types.js';

// Targets are kept separate from local control-plane operations. An SSH target
// can extend this type and dispatch boundary when remote management is built.
export function localInstance(value: unknown): AdminInstance {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Choose an fhold folder.');
	const input = value as Record<string, unknown>;
	if (
		input.kind !== 'local' ||
		typeof input.homeDir !== 'string' ||
		!isAbsolute(input.homeDir) ||
		input.homeDir.includes('\0')
	)
		throw new Error('Choose an absolute local fhold folder.');
	return { kind: 'local', homeDir: resolveFholdHome(input.homeDir) };
}

export function validateInstance(value: unknown): AdminInstance {
	const target = localInstance(value);
	if (existsSync(target.homeDir) && !statSync(target.homeDir).isDirectory())
		throw new Error('The selected path is not a folder.');
	const phase = classifyInstall(target.homeDir);
	if (phase === 'incompatible_home')
		throw new Error(
			'This folder is not a compatible fhold instance. Choose an empty folder for setup, then use fhold restore for a supported fhold backup. Nothing was changed.'
		);
	if (phase !== 'not_installed') {
		const config = readStackConfig(target.homeDir);
		if (!config.ok)
			throw new Error(`This instance needs its stack configuration repaired: ${config.error}`);
	}
	return target;
}

export class AdminInstances {
	private selected?: AdminInstance;
	private newName?: string;
	private recent: AdminInstance[] = [];
	private preferenceError?: string;
	private operations = 0;
	private readonly preferences: string;
	readonly defaultInstance: AdminInstance;

	constructor(userData: string, defaultHome = resolveFholdHome()) {
		this.defaultInstance = localInstance({ kind: 'local', homeDir: defaultHome });
		this.preferences = join(userData, 'instances.json');
		if (!existsSync(this.preferences)) return;
		try {
			const data: unknown = JSON.parse(readFileSync(this.preferences, 'utf8'));
			if (
				!data ||
				typeof data !== 'object' ||
				!('version' in data) ||
				data.version !== 1 ||
				!('recent' in data) ||
				!Array.isArray(data.recent)
			)
				throw new Error('Invalid recent-instance preferences.');
			for (const value of data.recent.slice(0, 20)) {
				const target = localInstance(value);
				if (!this.recent.some((item) => item.homeDir === target.homeDir)) this.recent.push(target);
			}
		} catch {
			this.recent = [];
			this.preferenceError =
				'Recent instances could not be loaded. You can still open the default folder or choose another.';
		}
	}

	welcome(): AdminWelcome {
		return {
			defaultInstance: this.defaultInstance,
			instancesDirectory: dirname(resolveFholdHome(defaultFholdHome())),
			recentInstances: this.recent,
			...(this.selected ? { selectedInstance: this.selected } : {}),
			...(this.preferenceError ? { preferenceError: this.preferenceError } : {})
		};
	}

	current(): AdminInstance {
		if (!this.selected) throw new Error('Open an instance from the welcome screen first.');
		return this.selected;
	}

	get setupName(): string | undefined {
		return this.newName;
	}

	assertIdle(): void {
		if (this.operations)
			throw new Error('Wait for the current operation to finish before switching instances.');
	}

	open(value: unknown): void {
		this.assertIdle();
		const requested = localInstance(value);
		if (
			requested.homeDir !== this.defaultInstance.homeDir &&
			this.recent.some((item) => item.homeDir === requested.homeDir) &&
			!existsSync(requested.homeDir)
		)
			throw new Error(
				'This recent instance folder is no longer available. Choose its new location instead.'
			);
		const target = validateInstance(value);
		this.select(target);
	}

	prepareNew(value: unknown): void {
		this.assertIdle();
		const target = localInstance(value);
		const name = (value as { name?: unknown }).name;
		if (name !== undefined && !isInstanceName(name))
			throw new Error('Choose an instance name with 1–63 lowercase letters, numbers or hyphens, starting and ending with a letter or number.');
		if (
			existsSync(target.homeDir) &&
			(!statSync(target.homeDir).isDirectory() || readdirSync(target.homeDir).length > 0)
		)
			throw new Error(
				'Choose an empty or new folder for this instance. To manage an existing instance, use Open another folder. Nothing was changed.'
			);
		this.select(target);
		this.newName = name;
	}

	private select(target: AdminInstance): void {
		const recent = [target, ...this.recent.filter((item) => item.homeDir !== target.homeDir)].slice(
			0,
			20
		);
		// Only Admin preferences are written; inspecting a target never seeds it.
		writeFileAtomic(this.preferences, `${JSON.stringify({ version: 1, recent }, null, 2)}\n`);
		this.recent = recent;
		this.preferenceError = undefined;
		this.selected = target;
		this.newName = undefined;
	}

	close(): void {
		this.assertIdle();
		this.selected = undefined;
		this.newName = undefined;
	}

	async run<T>(operation: () => T | Promise<T>): Promise<T> {
		this.current();
		this.operations++;
		try {
			return await operation();
		} finally {
			this.operations--;
		}
	}
}
