import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerDeploymentOperations } from '../hosting/docker-deployment.js';
import { HostingPreferencesStore } from '../hosting/preferences.js';
import { capabilities, type InstanceRef, type HostingSnapshot } from '../hosting/types.js';
import { hostOperations } from '../management/host-operations.js';
import {
	invokeOperation,
	supportedOperation,
	unsupportedOperation,
	type DockerOperations
} from '../management/contracts.js';
import { defaultStackConfig } from './stack-config.js';

function fixture(kind: 'local-docker' | 'ssh-docker') {
	const ref: InstanceRef =
		kind === 'local-docker'
			? { kind, connectionId: 'local', homeDir: '/synthetic/one' }
			: { kind, connectionId: 'remote', remoteHome: '/synthetic/one' };
	const store = new HostingPreferencesStore(
		join(mkdtempSync(join(tmpdir(), 'fhold-draft-')), 'hosting.json')
	);
	let config = defaultStackConfig('/synthetic/one');
	let failed = false;
	const calls: string[] = [];
	const inspect = async (): Promise<HostingSnapshot> => ({
		ref,
		name: 'one',
		location: '/synthetic/one',
		services: [],
		warnings: [],
		capabilities: capabilities(['start', 'stop', 'restart'])
	});
	const { host } = hostOperations({
		ref,
		actionEffects: {
			start: 'reconcile-deployment',
			stop: 'reconcile-deployment',
			restart: 'reconcile-deployment'
		},
		inspect,
		logs: async () => '',
		operate: async (action) => {
			calls.push(action);
			if (failed) throw new Error('Activation failed');
			return { snapshot: await inspect() };
		}
	});
	const docker: DockerOperations = {
		install: unsupportedOperation('Not needed'),
		directory: unsupportedOperation('Not needed'),
		update: supportedOperation(async () => {
			calls.push('update');
		}),
		saveConfig: supportedOperation(async ({ config: next, baseConfig }) => {
			expect(baseConfig).toEqual(config);
			calls.push('save');
			config = next;
		})
	};
	return {
		...dockerDeploymentOperations(
			ref,
			docker,
			host,
			inspect,
			async () => structuredClone(config),
			store
		),
		store,
		ref,
		calls,
		config: () => config,
		fail: (value: boolean) => {
			failed = value;
		}
	};
}

for (const kind of ['local-docker', 'ssh-docker'] as const) {
	test(`${kind}: shared deployment settings stage, survive reopening, and apply only after confirmation`, async () => {
		const f = fixture(kind);
		const settings = await invokeOperation(f.operations.inspect, undefined);
		expect(settings.containers[0]?.image).toContain('fwdslsh/fhold-assistant:');
		expect(settings.environment.FH_CLAUDE_REMOTE).toBe('1');
		expect(settings.unavailable?.availability).toContain('scale-to-zero');
		expect(settings.unavailable?.FH_SCHEDULER_ENABLED).toContain('custom Compose');
		const patch = {
			environment: { FH_TIMEZONE: 'Asia/Tokyo', FH_CLAUDE_REMOTE: '0' },
			container: 'assistant',
			image: 'fwdslsh/fhold-assistant:next'
		};
		await invokeOperation(f.operations.prepare, patch);
		expect(new HostingPreferencesStore(f.store.path).deployment(f.ref).draft).toEqual(patch);
		expect(f.calls).toEqual([]);
		expect(f.config().assistant.claudeRemote).toBe(true);
		expect((await f.inspectHost()).pendingRestart?.required).toBe(true);
		await expect(invokeOperation(f.operations.apply, undefined)).rejects.toThrow('Confirm');
		expect(f.calls).toEqual([]);
		// Another settings screen can change unrelated intent while this draft is pending.
		f.config().assistant.port = 4910;
		expect(await invokeOperation(f.operations.apply, undefined, { confirmed: true })).toMatchObject(
			{ state: 'completed' }
		);
		expect(f.calls).toEqual(['save', 'restart']);
		expect(f.config().assistant).toMatchObject({
			timezone: 'Asia/Tokyo',
			claudeRemote: false,
			port: 4910
		});
		expect(f.config().deployment.images.assistant).toBe('next');
		expect(f.store.deployment(f.ref).draft).toBeUndefined();
		expect((await f.inspectHost()).pendingRestart).toBeUndefined();
	});
}

test('Docker draft validation does not change the instance; unsupported controls never silently succeed', async () => {
	const f = fixture('local-docker');
	for (const patch of [
		{ environment: { TZ: 'UTC' } },
		{ environment: { FH_TIMEZONE: 'not/a/zone' } },
		{ environment: { FH_CLAUDE_REMOTE: 'maybe' } },
		{ environment: { FH_SCHEDULER_ENABLED: '0' } },
		{ availability: 'on-demand' },
		{ container: 'assistant', image: 'other/repository:latest' }
	])
		await expect(invokeOperation(f.operations.prepare, patch as never)).rejects.toThrow();
	expect(f.calls).toEqual([]);
	expect(f.store.deployment(f.ref).draft).toBeUndefined();
});

test('Docker retains failed apply drafts; discard never rewinds settings already saved to the instance', async () => {
	const f = fixture('ssh-docker');
	await invokeOperation(f.operations.prepare, { environment: { FH_CLAUDE_REMOTE: '0' } });
	await invokeOperation(f.operations.prepare, { environment: { FH_CODEX_REMOTE: '0' } });
	f.fail(true);
	await expect(invokeOperation(f.operations.apply, undefined, { confirmed: true })).rejects.toThrow(
		'Activation failed'
	);
	expect(f.store.deployment(f.ref).draft?.environment).toEqual({
		FH_CLAUDE_REMOTE: '0',
		FH_CODEX_REMOTE: '0'
	});
	await invokeOperation(f.operations.discard, undefined);
	expect(f.config().assistant.claudeRemote).toBe(false);
	expect(f.store.deployment(f.ref).draft).toBeUndefined();
	f.fail(false);
	await invokeOperation(f.operations.apply, undefined, { confirmed: true });
	expect(f.calls).toEqual(['save', 'restart', 'restart']);
});

test('discarding an unapplied Docker draft leaves configuration and lifecycle alone', async () => {
	const f = fixture('local-docker');
	const before = structuredClone(f.config());
	await invokeOperation(f.operations.prepare, { environment: { FH_CLAUDE_REMOTE: '0' } });
	await invokeOperation(f.operations.discard, undefined);
	expect(f.calls).toEqual([]);
	expect(f.config()).toEqual(before);
	expect((await invokeOperation(f.operations.inspect, undefined)).pending).toBeUndefined();
});
