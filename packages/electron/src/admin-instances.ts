import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
	classifyInstall,
	defaultFholdHome,
	isInstanceName,
	readStackConfig,
	resolveFholdHome,
	HostingPreferencesStore,
	instanceKey,
	parseInstanceRef,
	openHostingInstance
} from '@fhold/lib';
import type { InstanceRef } from '@fhold/lib';
import type {
	AdminInstance,
	AdminTarget,
	AdminWelcome,
	AdminWelcomeInstance
} from './admin-types.js';

// Local path validation must never be applied to a hosted instance locator.
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

export function adminInstanceRef(target: AdminTarget): InstanceRef {
	return target.kind === 'local'
		? { kind: 'local-docker', connectionId: 'local', homeDir: target.homeDir }
		: target.ref;
}
export function adminTarget(value: unknown): AdminTarget {
	if (value && typeof value === 'object' && 'kind' in value && value.kind === 'hosted') {
		const ref = parseInstanceRef((value as { ref?: unknown }).ref);
		if (ref.kind === 'local-docker') return localInstance({ kind: 'local', homeDir: ref.homeDir });
		return { kind: 'hosted', ref };
	}
	return localInstance(value);
}
function describeInstance(target: AdminTarget): AdminWelcomeInstance {
	if (target.kind === 'hosted')
		return {
			...target,
			available: true,
			name:
				target.ref.kind === 'ssh-docker'
					? target.ref.remoteHome.split('/').at(-1)
					: target.ref.kind === 'azure-container-apps'
						? target.ref.resourceId.split('/').at(-1)
						: undefined
		};
	try {
		const phase = classifyInstall(target.homeDir);
		const config = readStackConfig(target.homeDir);
		return {
			...target,
			available: phase === 'installed' || phase === 'setup_incomplete',
			...(config.ok ? { name: config.config.deployment.projectName } : {})
		};
	} catch {
		return { ...target, available: false };
	}
}

export class AdminInstances {
	private selected?: AdminTarget;
	private newName?: string;
	private recent: AdminTarget[] = [];
	private preferenceError?: string;
	private operations = 0;
	private readonly preferences: string;
	readonly defaultInstance: AdminInstance;

	constructor(
		userData: string,
		defaultHome = resolveFholdHome(),
		readonly hosting = new HostingPreferencesStore()
	) {
		this.defaultInstance = localInstance({ kind: 'local', homeDir: defaultHome });
		this.preferences = join(userData, 'instances.json');
		try {
			if (existsSync(hosting.path)) {
				this.recent = hosting
					.read()
					.recent.map((ref) =>
						ref.kind === 'local-docker'
							? localInstance({ kind: 'local', homeDir: ref.homeDir })
							: { kind: 'hosted', ref }
					);
				if (this.recent.length) {
					this.reopenPrevious();
					return;
				}
			}
			if (!existsSync(this.preferences)) return;
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
				if (
					!this.recent.some(
						(item) => instanceKey(adminInstanceRef(item)) === instanceKey(adminInstanceRef(target))
					)
				)
					this.recent.push(target);
			}
		} catch {
			this.recent = [];
			this.preferenceError =
				'Recent instances could not be loaded. You can still open an existing instance or set up a new agent.';
		}
		this.reopenPrevious();
	}

	private reopenPrevious(): void {
		const previous = this.recent[0];
		if (!previous) return;
		try {
			if (previous.kind === 'hosted') {
				this.hosting.connection(previous.ref.connectionId);
				this.selected = previous;
				return;
			}
			if (classifyInstall(previous.homeDir) === 'not_installed')
				throw new Error(
					'Its folder is missing or setup has not started. Choose its location or create a new instance.'
				);
			// Resume once per app launch, without rewriting preferences or the home.
			// Closing the selection must leave Welcome open across renderer reloads.
			this.selected = validateInstance(previous);
		} catch (error) {
			this.preferenceError = `The previous instance could not be opened. ${error instanceof Error ? error.message : 'Choose another folder. Nothing was changed.'}`;
		}
	}

	welcome(): AdminWelcome {
		return {
			defaultInstance: describeInstance(this.defaultInstance) as AdminWelcome['defaultInstance'],
			instancesDirectory: dirname(resolveFholdHome(defaultFholdHome())),
			recentInstances: this.recent.map(describeInstance),
			...(this.selected ? { selectedInstance: this.selected } : {}),
			...(this.preferenceError ? { preferenceError: this.preferenceError } : {})
		};
	}

	current(): AdminTarget {
		if (!this.selected) throw new Error('Open an instance from the welcome screen first.');
		return this.selected;
	}
	currentLocal(): AdminInstance {
		const target = this.current();
		if (target.kind !== 'local')
			throw new Error(
				'This feature is managed on the instance’s host, not this computer. No local files or containers were changed.'
			);
		return target;
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
		const requested = adminTarget(value);
		if (requested.kind === 'hosted') {
			const connection = this.hosting.connection(requested.ref.connectionId);
			openHostingInstance(connection, requested.ref);
			this.select(requested);
			return;
		}
		if (
			requested.homeDir !== this.defaultInstance.homeDir &&
			this.recent.some((item) => item.kind === 'local' && item.homeDir === requested.homeDir) &&
			!existsSync(requested.homeDir)
		)
			throw new Error(
				'This recent instance folder is no longer available. Choose its new location instead.'
			);
		const target = validateInstance(value);
		if (classifyInstall(target.homeDir) === 'not_installed')
			throw new Error(
				'No fhold instance was found in this folder. Use Set up a new agent to create one. Nothing was changed.'
			);
		this.select(target);
	}

	prepareNew(value: unknown): void {
		this.assertIdle();
		const target = localInstance(value);
		const name = (value as { name?: unknown }).name;
		if (name !== undefined && !isInstanceName(name))
			throw new Error(
				'Choose an instance name with 1–63 lowercase letters, numbers or hyphens, starting and ending with a letter or number.'
			);
		if (
			existsSync(target.homeDir) &&
			(!statSync(target.homeDir).isDirectory() || readdirSync(target.homeDir).length > 0)
		)
			throw new Error(
				'Choose an empty or new folder for this instance. To manage an existing instance, use Open existing instance. Nothing was changed.'
			);
		this.select(target);
		this.newName = name;
	}

	private select(target: AdminTarget): void {
		const recent = [
			target,
			...this.recent.filter(
				(item) => instanceKey(adminInstanceRef(item)) !== instanceKey(adminInstanceRef(target))
			)
		].slice(0, 20);
		// Only Admin preferences are written; inspecting a target never seeds it.
		try {
			this.hosting.remember(adminInstanceRef(target), recent.map(adminInstanceRef));
			this.preferenceError = undefined;
		} catch {
			this.preferenceError =
				'The instance is open, but recent connections could not be saved. Review hosting.json; it was not overwritten.';
		}
		this.recent = recent;
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
		return this.runConnection(operation);
	}
	async runConnection<T>(operation: () => T | Promise<T>): Promise<T> {
		this.operations++;
		try {
			return await operation();
		} finally {
			this.operations--;
		}
	}
}
