import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostingPreferencesStore } from '../hosting/preferences.js';
import type { AzureManagement } from '../hosting/azure-client.js';
import { azureContainerAppsProvider } from '../hosting/azure-container-apps.js';
import { hostingConnectionSetup } from '../hosting/provider.js';
import { checkHostingConnection } from '../hosting/maintenance.js';
import { hostingFailure, type HostingProcess, type HostingTerminal } from './process.js';
import type { HostingConnection } from '../hosting/types.js';

const subscriptionId = '00000000-1111-2222-3333-444444444444';
const connection: Extract<HostingConnection, { kind: 'azure-container-apps' }> = {
	kind: 'azure-container-apps',
	id: 'azure',
	label: 'Azure',
	subscriptionId,
	resourceGroup: 'agents'
};
const resourceId = `/subscriptions/${subscriptionId}/resourceGroups/agents/providers/Microsoft.App/containerApps/agent`;
const ref = { kind: 'azure-container-apps' as const, connectionId: 'azure', resourceId };
function fixture(options: { many?: boolean; readFails?: boolean; startFailsOnce?: boolean } = {}) {
	const calls: string[][] = [];
	const terminals: string[][] = [];
	const native: string[] = [];
	let restarted = false;
	let stopped = false;
	const run: HostingProcess = async (binary, args, nativeOptions) => {
		expect(binary).toBe('az');
		expect(nativeOptions?.env?.AZURE_EXTENSION_USE_DYNAMIC_INSTALL).toBe('no');
		calls.push(args);
		if (args.includes('restart')) {
			restarted = true;
			return '';
		}
		if (restarted && options.readFails) throw new Error('network unavailable');
		if (args[0] === 'version') return JSON.stringify('2.91.0');
		if (args[0] === 'account') return JSON.stringify({ id: subscriptionId, state: 'Enabled' });
		if (args[0] === 'group') return JSON.stringify({ name: 'agents' });
		if (args.includes('logs')) return 'console text';
		if (args.includes('revision'))
			return JSON.stringify(
				(options.many ? ['agent--first', 'agent--second'] : ['agent--first']).map((name) => ({
					name,
					properties: { active: true, replicas: 1, healthState: 'Healthy', runningState: 'Running' }
				}))
			);
		const app = {
			id: resourceId,
			name: 'agent',
			tags: { fhold: 'assistant' },
			properties: {
				runningStatus: stopped ? 'Stopped' : 'Running',
				configuration: { ingress: { external: true, fqdn: 'agent.example.com' } },
				template: { containers: [{ name: 'assistant', image: 'fwdslsh/fhold-assistant:test' }] }
			}
		};
		return JSON.stringify(args[1] === 'list' ? [app] : app);
	};
	const terminal: HostingTerminal = async (binary, args) => {
		expect(binary).toBe('az');
		terminals.push(args);
	};
	const management = {
		lifecycle(_name: string, action: string, saved?: string) {
			native.push(saved ? `resume-${action}` : action);
			restarted = true;
			return {
				serialize: async () =>
					JSON.stringify({
						state: {
							status: 'running',
							config: {
								initialRequestUrl: `https://management.azure.com${resourceId}/${action}`,
								requestMethod: 'POST'
							}
						}
					}),
				pollUntilDone: async () => {
					if (action === 'start' && options.startFailsOnce && !saved)
						throw new Error('lost start response');
					stopped = action === 'stop';
				}
			};
		}
	} as unknown as AzureManagement;
	const preferences = new HostingPreferencesStore(
		join(mkdtempSync(join(tmpdir(), 'fhold-azure-hosting-')), 'hosting.json')
	);
	preferences.saveConnection(connection);
	return {
		calls,
		native,
		terminals,
		provider: azureContainerAppsProvider(connection, run, terminal, { management, preferences })
	};
}

test('connection onboarding uses native browser auth and account choices without changing global scope', async () => {
	const calls: string[][] = [];
	const setup = hostingConnectionSetup('azure-container-apps', async (_binary, args) => {
		calls.push(args);
		return args[0] === 'login'
			? ''
			: JSON.stringify([
					{ value: args[0] === 'account' ? subscriptionId : 'agents', label: 'Chosen scope' }
				]);
	})!;
	await setup.signIn();
	expect(await setup.choices('subscriptionId')).toEqual([
		{ value: subscriptionId, label: 'Chosen scope' }
	]);
	expect(await setup.choices('resourceGroup', { subscriptionId })).toEqual([
		{ value: 'agents', label: 'Chosen scope' }
	]);
	expect(calls[0]).toEqual(['login', '--output', 'none', '--only-show-errors']);
	expect(calls[2]).toContain(subscriptionId);
	expect(calls.flat()).not.toContain('set');
	await expect(setup.choices('resourceGroup', { subscriptionId: '--bad' })).rejects.toThrow(
		'subscription'
	);
	await expect(setup.choices('arbitrary')).rejects.toThrow('Unknown');
	expect(calls).toHaveLength(3);
});

test('provider-owned diagnostics distinguish Azure account, scope and discovery, without SSH repair', async () => {
	const checked = await fixture().provider.check!();
	expect(checked.ok).toBe(true);
	expect(checked.checks.map((item) => item.name)).toEqual([
		'Azure CLI',
		'Azure sign-in',
		'Resource group',
		'Discovery'
	]);
	const failed = await checkHostingConnection(connection, async (_binary, args) => {
		if (args[0] === 'version') return JSON.stringify('2.91.0');
		throw new Error('Azure sign-in needs attention.');
	});
	expect(failed.ok).toBe(false);
	expect(failed.checks).toHaveLength(2);
	expect(failed.checks[0]?.ok).toBe(true);
	expect(failed.checks[1]?.name).toBe('Azure sign-in');
	expect(JSON.stringify(failed)).not.toMatch(/SSH|instance root/);
});

test('discovery recognizes exact image repository names or explicit custom-image tags, not misleading substrings', async () => {
	const images = [
		'fwdslsh/fhold-assistant:version',
		'registry.example/fhold-assistant@sha256:abc',
		'other/fhold-assistant-malware:tag',
		'other/not-fhold-assistant:tag'
	];
	const provider = azureContainerAppsProvider(connection, async () =>
		JSON.stringify(
			images
				.map((image, index) => ({
					id: `${resourceId}${index}`,
					name: `agent${index}`,
					properties: { template: { containers: [{ name: 'assistant', image }] } }
				}))
				.concat([
					{
						id: `${resourceId}4`,
						name: 'agent4',
						tags: { fhold: 'assistant' },
						properties: { template: { containers: [{ name: 'custom', image: 'custom:tag' }] } }
					}
				])
		)
	);
	expect((await provider.listInstances()).map((item) => item.name)).toEqual([
		'agent0',
		'agent1',
		'agent4'
	]);
});

test('restart waits for native Stop and Start after confirmation and current revision review', async () => {
	const { provider, calls, native } = fixture();
	const session = provider.open(ref);
	await expect(session.operate('restart', false)).rejects.toThrow('Confirm');
	expect(calls).toHaveLength(0);
	const result = await session.operate('restart', true, { revision: 'agent--first' });
	expect(result.pending).toBe(false);
	expect(result.message).toContain('Native readiness');
	expect(native).toEqual(['stop', 'start']);
	expect(calls.filter((args) => args.includes('restart'))).toHaveLength(0);
	expect(calls.flat()).not.toContain('update');
	expect(calls.flat()).not.toContain('deactivate');
	const stale = fixture();
	await expect(
		stale.provider.open(ref).operate('restart', true, { revision: 'old' })
	).rejects.toThrow('no longer');
	expect(stale.calls.filter((args) => args.includes('restart'))).toHaveLength(0);
	const many = fixture({ many: true });
	expect((await many.provider.open(ref).operate('restart', true)).pending).toBe(false);
	expect(many.native).toEqual(['stop', 'start']);
});

test('completed native restart remains completed if follow-up inventory fails; no mutation replay', async () => {
	const { provider, native } = fixture({ readFails: true });
	const result = await provider.open(ref).operate('restart', true);
	expect(result.snapshot.platformState).toBe('Status unavailable');
	expect(result.snapshot.services).toEqual([]);
	expect(result.pending).toBe(false);
	expect(native).toEqual(['stop', 'start']);
});

test('public Restart remains available while its stopped target has a pending Start continuation', async () => {
	const { provider, native } = fixture({ startFailsOnce: true });
	const session = provider.open(ref);
	const first = await session.operate('restart', true);
	expect(first.operation?.state).toBe('unknown');
	expect(first.snapshot.platformState).toBe('Stopped');
	expect(first.snapshot.capabilities.restart.supported).toBe(true);
	expect((await session.operate('restart', true)).operation?.state).toBe('completed');
	expect(native).toEqual(['stop', 'start', 'resume-start']);
});

test('console is a native interactive action with explicit replica scope and no embedded shell script', async () => {
	const { provider, calls, terminals } = fixture();
	await provider.open(ref).console!({
		revision: 'agent--first',
		replica: 'replica-1',
		container: 'assistant'
	});
	expect(calls).toHaveLength(0);
	expect(terminals[0]).toEqual(
		expect.arrayContaining([
			'exec',
			'--command',
			'/bin/bash',
			'--revision',
			'agent--first',
			'--replica',
			'replica-1',
			'--container',
			'assistant'
		])
	);
	expect(terminals[0]?.at(-1)).toBe('--only-show-errors');
	await expect(provider.open(ref).console!({ revision: 'bad\nname' })).rejects.toThrow('Invalid');
	expect(terminals).toHaveLength(1);
});

test('inspection advertises native log sources without contacting the agent', async () => {
	const { provider, calls } = fixture();
	expect((await provider.open(ref).inspect()).logSources).toEqual([
		{ type: 'system', label: 'Platform' },
		{ type: 'console', label: 'Agent console' }
	]);
	expect(
		calls.some((args) => args.includes('logs') || args.includes('exec') || args.includes('rest'))
	).toBe(false);
});

test('console log selection is scoped, native and bounded, while system logs remain replica independent', async () => {
	const { provider, calls } = fixture();
	expect(
		await provider
			.open(ref)
			.logs({ type: 'console', tail: 50, revision: 'agent--first', container: 'assistant' })
	).toBe('console text');
	expect(calls[0]).toEqual(
		expect.arrayContaining([
			'--type',
			'console',
			'--tail',
			'50',
			'--revision',
			'agent--first',
			'--container',
			'assistant',
			'--follow',
			'false'
		])
	);
	await expect(provider.open(ref).logs({ tail: 301 })).rejects.toThrow('0 and 300');
	await expect(provider.open(ref).logs({ tail: NaN })).rejects.toThrow('0 and 300');
	expect(calls).toHaveLength(1);
});

test('malformed Azure results and native auth errors are actionable without leaking response contents', async () => {
	const provider = azureContainerAppsProvider(connection, async () => 'private non-json token');
	await expect(provider.listInstances()).rejects.toThrow('invalid JSON');
	await expect(
		azureContainerAppsProvider(connection, async () =>
			JSON.stringify([{ name: 'bad' }])
		).listInstances()
	).rejects.toThrow('invalid resource');
	for (const [stderr, hint] of [
		['AADSTS700082 secret', 'sign-in'],
		['AuthorizationFailed secret', 'permission'],
		['ResourceGroupNotFound secret', 'not found'],
		['unrecognized arguments secret', 'Update Azure CLI']
	]) {
		const error = hostingFailure('az', 1, 'private-token', stderr!);
		expect(error).toContain(hint!);
		expect(error).not.toContain('secret');
		expect(error).not.toContain('private-token');
	}
});

test('system events use Azure-required JSONL and render native messages without discarding unknown output', async () => {
	const calls: string[][] = [];
	const session = azureContainerAppsProvider(connection, async (_binary, args) => {
		calls.push(args);
		return '{"TimeStamp":"now","Msg":"Checkpoint complete"}\nnew native format\n';
	}).open(ref);
	expect(await session.logs()).toBe('now Checkpoint complete\nnew native format\n');
	expect(calls[0]).toEqual(expect.arrayContaining(['--type', 'system', '--format', 'json']));
});

test('native ScaledToZero is recognized, while absent replica counts remain unknown', async () => {
	const run: HostingProcess = async (_binary, args) =>
		JSON.stringify(
			args.includes('revision')
				? [{ name: 'agent--one', properties: { active: true, runningState: 'Running' } }]
				: {
						id: resourceId,
						name: 'agent',
						tags: { fhold: 'assistant' },
						properties: { runningStatus: 'Running' }
					}
		);
	const snapshot = await azureContainerAppsProvider(connection, run).open(ref).inspect();
	expect(snapshot.platformState).toContain('replica count unavailable');
	expect(snapshot.revisions?.[0]?.replicas).toBeUndefined();
	const zeroRun: HostingProcess = async (binary, args, options) =>
		args.includes('revision')
			? JSON.stringify([
					{
						name: 'agent--one',
						properties: { active: true, replicas: 0, runningState: 'ScaledToZero' }
					}
				])
			: run(binary, args, options);
	expect(
		(await azureContainerAppsProvider(connection, zeroRun).open(ref).inspect()).platformState
	).toBe('Scaled to zero');
});
