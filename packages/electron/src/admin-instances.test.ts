import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFholdState, defaultFholdHome, defaultStackConfig, resolveFholdHome, writeStackConfig } from '@fhold/lib';
import { AdminInstances, validateInstance } from './admin-instances.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-instance-test-'));
	roots.push(root);
	return { root, home: join(root, 'default'), profile: join(root, 'profile') };
}

function installed(home: string) {
	mkdirSync(join(home, 'system', 'stack'), { recursive: true });
	writeFileSync(join(home, 'system', 'stack', 'stack.compose.yml'), 'services: {}\n');
	writeStackConfig(home, defaultStackConfig());
}

describe('Admin instance selection', () => {
	it('opens on welcome without inspecting or seeding the default home', () => {
		const { home, profile } = fixture();
		const instances = new AdminInstances(profile, home);
		expect(instances.welcome()).toEqual({
			defaultInstance: { kind: 'local', homeDir: home },
			instancesDirectory: dirname(resolveFholdHome(defaultFholdHome())),
			recentInstances: []
		});
		expect(() => instances.current()).toThrow('welcome screen');
		expect(existsSync(home)).toBe(false);
		expect(existsSync(profile)).toBe(false);
	});

	it('remembers MRU folders across launches, deduplicates canonical paths and does not auto-open', () => {
		const { root, home, profile } = fixture();
		const other = join(root, 'other');
		installed(home);
		installed(other);
		const alias = process.platform === 'win32' ? join(home, '..', 'default') : join(root, 'alias');
		if (process.platform !== 'win32') symlinkSync(home, alias, 'dir');
		const instances = new AdminInstances(profile, home);
		instances.open({ kind: 'local', homeDir: home });
		instances.open({ kind: 'local', homeDir: other });
		instances.open({ kind: 'local', homeDir: alias });
		expect(instances.welcome().recentInstances.map((item) => item.homeDir)).toEqual([home, other]);
		const restarted = new AdminInstances(profile, other);
		expect(restarted.welcome().selectedInstance).toBeUndefined();
		expect(restarted.welcome().defaultInstance.homeDir).toBe(other);
		expect(restarted.welcome().recentInstances.map((item) => item.homeDir)).toEqual([home, other]);
	});

	it('derives recent labels from current saved names without a second name registry or home writes', () => {
		const { root, home, profile } = fixture();
		installed(home);
		const config = defaultStackConfig(home);
		config.deployment.projectName = 'april';
		writeStackConfig(home, config);
		const instances = new AdminInstances(profile, home);
		instances.open({ kind: 'local', homeDir: home });
		const preferences = readFileSync(join(profile, 'instances.json'), 'utf8');
		const stack = readFileSync(join(home, 'state', 'stack.json'), 'utf8');
		expect(instances.welcome().recentInstances[0].name).toBe('april');
		expect(readFileSync(join(home, 'state', 'stack.json'), 'utf8')).toBe(stack);
		expect(readFileSync(join(profile, 'instances.json'), 'utf8')).toBe(preferences);
		expect(preferences).not.toContain('april');
		const missing = join(root, 'missing');
		instances.prepareNew({ kind: 'local', homeDir: missing });
		expect(instances.welcome().recentInstances[0].name).toBeUndefined();
		expect(existsSync(missing)).toBe(false);
	});

	it('rejects legacy, unrelated, file, relative and unsupported targets without writing to them', () => {
		const { root, home, profile } = fixture();
		mkdirSync(home);
		const sentinel = join(home, 'old-user-data');
		writeFileSync(sentinel, 'keep');
		const instances = new AdminInstances(profile, join(root, 'default'));
		for (const target of [
			null,
			{ kind: 'ssh', homeDir: home },
			{ kind: 'local', homeDir: 'relative' },
			{ kind: 'local', homeDir: home },
			{ kind: 'local', homeDir: sentinel }
		]) {
			expect(() => instances.open(target)).toThrow();
		}
		expect(readFileSync(sentinel, 'utf8')).toBe('keep');
		expect(existsSync(join(home, 'state'))).toBe(false);
		expect(existsSync(profile)).toBe(false);
	});

	it('accepts empty homes but refuses broken configuration and unavailable recent directories', () => {
		const { root, home, profile } = fixture();
		mkdirSync(home);
		expect(validateInstance({ kind: 'local', homeDir: home }).homeDir).toBe(home);
		const broken = join(root, 'broken');
		installed(broken);
		writeFileSync(join(broken, 'state', 'stack.json'), '{');
		expect(() => validateInstance({ kind: 'local', homeDir: broken })).toThrow(
			'not a compatible fhold instance'
		);
		mkdirSync(profile);
		const missing = { kind: 'local', homeDir: join(root, 'missing') };
		writeFileSync(
			join(profile, 'instances.json'),
			JSON.stringify({ version: 1, recent: [missing] })
		);
		const instances = new AdminInstances(profile, home);
		expect(() => instances.open(missing)).toThrow('no longer available');
		expect(existsSync(missing.homeDir)).toBe(false);
	});

	it('recovers from corrupt preferences without overwriting them until an explicit open', () => {
		const { home, profile } = fixture();
		mkdirSync(profile);
		const preferences = join(profile, 'instances.json');
		writeFileSync(preferences, '{');
		const instances = new AdminInstances(profile, home);
		expect(instances.welcome().preferenceError).toContain('could not be loaded');
		expect(readFileSync(preferences, 'utf8')).toBe('{');
		instances.open({ kind: 'local', homeDir: home });
		expect(instances.welcome().preferenceError).toBeUndefined();
	});

	it('blocks switching during in-flight work, releases on error and never changes global FH_HOME', async () => {
		const { root, home, profile } = fixture();
		const before = process.env.FH_HOME;
		const instances = new AdminInstances(profile, home);
		instances.open({ kind: 'local', homeDir: home });
		let finish!: () => void;
		const running = instances.run(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		expect(() => instances.open({ kind: 'local', homeDir: join(root, 'other') })).toThrow(
			'current operation'
		);
		expect(() => instances.close()).toThrow('current operation');
		expect(() => instances.prepareNew({ kind: 'local', homeDir: join(root, 'new') })).toThrow(
			'current operation'
		);
		finish();
		await running;
		await expect(
			instances.run(() => {
				throw new Error('failed');
			})
		).rejects.toThrow('failed');
		instances.open({ kind: 'local', homeDir: join(root, 'other') });
		expect(createFholdState(instances.current().homeDir).homeDir).toBe(join(root, 'other'));
		expect(process.env.FH_HOME).toBe(before);
		instances.close();
		expect(instances.welcome().selectedInstance).toBeUndefined();
	});

	it('prepares an empty or nonexistent new folder without installing or creating it', () => {
		const { root, home, profile } = fixture();
		const instances = new AdminInstances(profile, home);
		const empty = join(root, 'empty');
		mkdirSync(empty);
		for (const folder of [empty, join(root, 'new-parent', 'new-instance')]) {
			instances.prepareNew({ kind: 'local', homeDir: folder });
			expect(instances.current().homeDir).toBe(folder);
			expect(existsSync(join(folder, 'state'))).toBe(false);
		}
		expect(existsSync(join(root, 'new-parent'))).toBe(false);
	});

	it('keeps a new setup name separate from saved instance identity and honors a custom folder', () => {
		const { root, home, profile } = fixture();
		const folder = join(root, 'custom-folder');
		const instances = new AdminInstances(profile, home);
		instances.prepareNew({ kind: 'local', homeDir: folder, name: 'april' });
		expect(instances.current().homeDir).toBe(folder);
		expect(instances.setupName).toBe('april');
		expect(existsSync(folder)).toBe(false);
		for (const name of ['', '../april', 'April'])
			expect(() => instances.prepareNew({ kind: 'local', homeDir: join(root, 'other'), name })).toThrow('instance name');
		expect(instances.setupName).toBe('april');
		instances.close();
		expect(instances.setupName).toBeUndefined();
	});

	it('refuses new setup on installed, populated or file targets without changing selection or preferences', () => {
		const { root, home, profile } = fixture();
		installed(home);
		const populated = join(root, 'populated');
		mkdirSync(populated);
		const sentinel = join(populated, 'authored.txt');
		writeFileSync(sentinel, 'keep');
		const instances = new AdminInstances(profile, home);
		instances.open({ kind: 'local', homeDir: home });
		const preferences = readFileSync(join(profile, 'instances.json'), 'utf8');
		const targets = [home, populated, sentinel, 'relative'];
		if (process.platform !== 'win32') {
			const alias = join(root, 'alias');
			symlinkSync(home, alias, 'dir');
			targets.push(alias);
		}
		for (const folder of targets) {
			expect(() => instances.prepareNew({ kind: 'local', homeDir: folder })).toThrow();
			expect(instances.current().homeDir).toBe(home);
			expect(readFileSync(join(profile, 'instances.json'), 'utf8')).toBe(preferences);
		}
		expect(readFileSync(sentinel, 'utf8')).toBe('keep');
		expect(existsSync(join(populated, 'state'))).toBe(false);
	});

	it('requires an explicit fresh-setup action to reuse a missing recent folder', () => {
		const { root, home, profile } = fixture();
		mkdirSync(profile);
		const missing = { kind: 'local' as const, homeDir: join(root, 'missing') };
		writeFileSync(
			join(profile, 'instances.json'),
			JSON.stringify({ version: 1, recent: [missing] })
		);
		const instances = new AdminInstances(profile, home);
		expect(() => instances.open(missing)).toThrow('no longer available');
		instances.prepareNew(missing);
		expect(instances.current()).toEqual(missing);
		expect(existsSync(missing.homeDir)).toBe(false);
	});
});
