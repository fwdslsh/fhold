import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultStackConfig, writeStackConfig } from './stack-config.js';
import { localDockerEndpoint } from './docker.js';
import {
	HostingPreferencesStore,
	parseHostingConnection,
	parseInstanceRef
} from '../hosting/preferences.js';
import { listLocalInstances } from '../hosting/local-docker.js';
import { hostingMachineRequest } from '../hosting/machine.js';
import { sshDockerProvider, SSH_RPC_COMMAND } from '../hosting/ssh-docker.js';
import { azureContainerAppsProvider } from '../hosting/azure-container-apps.js';
import {
	capabilities,
	instanceKey,
	type HostingConnection,
	type InstanceRef
} from '../hosting/types.js';
import { hostingFailure, type HostingProcess } from '../hosting/process.js';
import { checkHostingConnection, repairSshCli } from '../hosting/maintenance.js';
import { createHash } from 'node:crypto';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
	const value = mkdtempSync(join(tmpdir(), 'fhold-hosting-'));
	roots.push(value);
	return value;
}
const ssh: Extract<HostingConnection, { kind: 'ssh-docker' }> = {
	kind: 'ssh-docker',
	id: 'lab',
	label: 'Lab',
	host: 'owner@lab',
	roots: ['/opt/stacks']
};
const subscription = '00000000-1111-2222-3333-444444444444';
const aca: Extract<HostingConnection, { kind: 'azure-container-apps' }> = {
	kind: 'azure-container-apps',
	id: 'cloud',
	label: 'Cloud',
	subscriptionId: subscription,
	resourceGroup: 'agents'
};
const resourceId = `/subscriptions/${subscription}/resourceGroups/agents/providers/Microsoft.App/containerApps/agent`;
const acaRef: InstanceRef = { kind: 'azure-container-apps', connectionId: 'cloud', resourceId };

test('native failures are actionable without leaking stderr or confusing connectivity with a missing CLI', () => {
	expect(hostingFailure('ssh', 1, '', 'bash: fhold: command not found')).toContain('repair');
	expect(hostingFailure('ssh', 1, '', 'Host key verification failed: secret')).toContain('host trust');
	expect(hostingFailure('ssh', 1, '', 'Permission denied: secret')).toContain('sign-in');
	expect(hostingFailure('ssh', 1, '', 'hostname not found: secret')).not.toContain('remote fhold CLI');
	expect(hostingFailure('az', 1, 'secret-token', 'secret-token')).not.toContain('secret-token');
});

test('connection edits keep recents for labels/roots, but clear them when retargeted; removal is metadata-only', () => {
	const directory = root(); const store = new HostingPreferencesStore(join(directory, 'hosting.json'));
	store.saveConnection(ssh);
	const ref: InstanceRef = {kind:'ssh-docker',connectionId:'lab',remoteHome:'/opt/stacks/agent'};
	store.remember(ref);
	store.updateConnection('lab', {...ssh, label:'New label', roots:[]});
	expect(store.read().recent).toEqual([ref]);
	store.updateConnection('lab', {...ssh, host:'other'});
	expect(store.read().recent).toEqual([]);
	expect(() => store.updateConnection('lab', {...ssh,id:'new-id'})).toThrow('identity');
	store.removeConnection('lab'); expect(store.read().connections).toEqual([]);
	expect(() => store.removeConnection('local')).toThrow('always available');
});
test('discovery finds managed Compose homes anywhere and stopped root/child/home layouts without Docker', async () => {
	const directory = root(); const rootsHome = join(directory, 'stacks', 'agent', 'home'); const custom = join(directory, 'custom');
	for (const [path,name] of [[rootsHome,'nested'],[custom,'custom']] as const) {
		mkdirSync(join(path, 'system', 'stack'), {recursive:true});
		writeFileSync(join(path, 'system', 'stack', 'stack.compose.yml'), 'services: {}');
		const config = defaultStackConfig(path); config.deployment.projectName = name; writeStackConfig(path, config);
	}
	const foreign = join(directory,'foreign'); mkdirSync(join(foreign,'system','stack'), {recursive:true});
	const listed = await listLocalInstances([join(directory,'stacks')], async () => `${custom}/system/stack\n${foreign}/system/stack\n${custom}/system/stack`);
	expect(listed.map(item => item.name).sort()).toEqual(['custom','nested']);
	expect((await listLocalInstances([join(directory,'stacks')], async () => {throw Error('Docker stopped');})).map(item => item.name)).toEqual(['nested']);
	expect(existsSync(join(foreign,'state'))).toBe(false);
});
test('connection check reports missing CLI with repair guidance without losing SSH success', async () => {
	const result = await checkHostingConnection(ssh, async (_binary,args) => {
		if (args.at(-1) === 'uname -sm') return 'Linux x86_64';
		throw Error('Remote fhold missing; use Repair remote CLI.');
	});
	expect(result.ok).toBe(false); expect(result.repairable).toBe(true);
	expect(result.checks[0]?.ok).toBe(true); expect(result.checks[1]?.detail).toContain('Repair');
});
test('connection checks report unexpected remote output without disclosing it', async () => {
	const result = await checkHostingConnection(ssh, async (_binary, args) =>
		args.at(-1) === 'uname -sm' ? 'Linux x86_64' : 'private startup message'
	);
	expect(result.ok).toBe(false);
	expect(result.checks.at(-1)?.detail).toContain('unexpected output');
	expect(result.checks.at(-1)?.detail).not.toContain('private startup message');
});
test('remote repair streams a trusted artifact and checks it before atomic replacement', async () => {
	const artifact = join(root(),'fhold-cli'); writeFileSync(artifact, 'synthetic-cli');
	const calls: Array<{args:string[];file?:string}> = [];
	const run: HostingProcess = async (_binary,args,options) => {calls.push({args,file:options?.inputFile}); return args.at(-1) === 'uname -sm' ? 'Linux x86_64' : '0.2.2610113-beta.9';};
	await expect(repairSshCli(ssh,{confirmed:false,cliFile:artifact,run})).rejects.toThrow('Confirm'); expect(calls).toHaveLength(0);
	expect(await repairSshCli(ssh,{confirmed:true,cliFile:artifact,run})).toContain('No containers');
	expect(calls[1]?.file).toBe(artifact);
	expect(calls[1]?.args.at(-1)).toContain(createHash('sha256').update('synthetic-cli').digest('hex'));
	expect(calls[1]?.args.at(-1)).toContain('hosting --help');
	expect(calls[1]?.args.at(-1)).not.toContain('/opt/stacks');
});
test('corrupt published downloads cannot replace the remote CLI', async () => {
	let mutations = 0;
	const download: typeof fetch = async (request) => String(request).endsWith('checksums-sha256.txt') ? new Response(`${'a'.repeat(64)}  fhold-cli-linux-x64\n`) : new Response('wrong-bytes');
	await expect(repairSshCli(ssh,{confirmed:true,fetch:download,run:async (_binary,args) => {if(args.at(-1) !== 'uname -sm') mutations++; return 'Linux x86_64';}})).rejects.toThrow('checksum mismatch');
	expect(mutations).toBe(0);
});

describe('hosting metadata is separate from instance intent and credentials', () => {
	test('reading default metadata creates nothing; explicit saves retain only locators', () => {
		const path = join(root(), 'config', 'hosting.json');
		const store = new HostingPreferencesStore(path);
		expect(store.read()).toEqual({ version: 1, connections: [], recent: [] });
		expect(existsSync(path)).toBe(false);
		store.saveConnection({ ...ssh, password: 'never-store', token: 'never-store' });
		store.remember({ kind: 'ssh-docker', connectionId: 'lab', remoteHome: '/opt/stacks/agent' });
		expect(new HostingPreferencesStore(path).connection('lab')).toEqual(ssh);
		expect(readFileSync(path, 'utf8')).not.toContain('never-store');
		expect(() => store.saveConnection({ ...ssh, host: 'other-host' })).toThrow('already used');
	});
	test('connection and target identity includes hosting scope', () => {
		expect(instanceKey({ kind: 'ssh-docker', connectionId: 'one', remoteHome: '/agent' })).not.toBe(
			instanceKey({ kind: 'ssh-docker', connectionId: 'two', remoteHome: '/agent' })
		);
		for (const host of ['-oProxyCommand=bad', 'lab;touch /tmp/bad', 'lab\ncommand'])
			expect(() => parseHostingConnection({ ...ssh, host })).toThrow();
		expect(() =>
			parseInstanceRef({ kind: 'ssh-docker', connectionId: 'lab', remoteHome: 'relative' })
		).toThrow();
		expect(() =>
			parseInstanceRef({ ...acaRef, resourceId: resourceId.replace('containerApps', 'jobs') })
		).toThrow();
	});
	test('corrupt preferences do not change or prevent the implicit local connection', () => {
		const path = join(root(), 'hosting.json');
		writeFileSync(path, '{');
		const store = new HostingPreferencesStore(path);
		expect(store.connection('local').kind).toBe('local-docker');
		expect(() => store.read()).toThrow();
		expect(readFileSync(path, 'utf8')).toBe('{');
	});
});

test('discovery is bounded, skips unrelated/broken homes and never seeds them', async () => {
	const directory = root();
	const home = join(directory, 'one');
	mkdirSync(join(home, 'system', 'stack'), { recursive: true });
	writeFileSync(join(home, 'system', 'stack', 'stack.compose.yml'), 'services: {}');
	const config = defaultStackConfig(home);
	config.deployment.projectName = 'one';
	writeStackConfig(home, config);
	mkdirSync(join(directory, 'unrelated'));
	writeFileSync(join(directory, 'unrelated', 'user-data'), 'keep');
	mkdirSync(join(directory, 'broken', 'state'), { recursive: true });
	writeFileSync(join(directory, 'broken', 'state', 'stack.json'), '{');
	const before = readFileSync(join(home, 'state', 'stack.json'), 'utf8');
	const instances = await listLocalInstances([directory], async () => '');
	expect(instances.map((item) => item.name)).toEqual(['one']);
	expect(readFileSync(join(home, 'state', 'stack.json'), 'utf8')).toBe(before);
	expect(existsSync(join(directory, 'unrelated', 'state'))).toBe(false);
});

test('local Docker accepts native local sockets, not a remote daemon with local bind paths', () => {
	for (const endpoint of [
		'unix:///var/run/docker.sock',
		'unix:///run/user/1000/docker.sock',
		'npipe:////./pipe/docker_engine'
	])
		expect(localDockerEndpoint(endpoint)).toBe(endpoint);
	for (const endpoint of ['ssh://server', 'tcp://remote:2376', 'https://remote', ''])
		expect(() => localDockerEndpoint(endpoint)).toThrow('SSH hosting connection');
});

test('machine interface negotiates actions, refuses arbitrary execution and preserves confirmation', async () => {
	const hello = await hostingMachineRequest({ version: 1, action: 'hello' });
	expect(hello).toMatchObject({
		version: 1,
		ok: true,
		value: { actions: expect.arrayContaining(['list', 'inspect', 'logs', 'stop']) }
	});
	for (const input of [
		null,
		{ version: 2, action: 'hello' },
		{ version: 1, action: 'exec', command: 'bad' },
		{ version: 1, action: 'stop', homeDir: '/missing' },
		{ version: 1, action: 'inspect', homeDir: 'relative' }
	])
		expect((await hostingMachineRequest(input)).ok).toBe(false);
});

describe('native SSH transport', () => {
	test('fixed remote command and JSON stdin preserve paths with shell metacharacters', async () => {
		const remoteHome = "/opt/stacks/owner's agent; echo bad";
		const requests: Array<{ args: string[]; input: unknown }> = [];
		const run: HostingProcess = async (binary, args, options) => {
			expect(binary).toBe('ssh');
			const input = JSON.parse(options?.input || '{}');
			requests.push({ args, input });
			return JSON.stringify({
				version: 1,
				ok: true,
				value: {
					ref: { kind: 'local-docker', connectionId: 'local', homeDir: remoteHome },
					name: 'agent',
					location: remoteHome,
					services: [],
					warnings: [],
					capabilities: capabilities(true, true)
				}
			});
		};
		const session = sshDockerProvider(ssh, run).open({
			kind: 'ssh-docker',
			connectionId: 'lab',
			remoteHome
		});
		expect((await session.inspect()).ref).toEqual(session.ref);
		expect(requests[0]?.args.at(-1)).toBe(SSH_RPC_COMMAND);
		expect(requests[0]?.args.join(' ')).not.toContain(remoteHome);
		expect(requests[0]?.input).toMatchObject({
			version: 1,
			action: 'inspect',
			homeDir: remoteHome
		});
		expect(requests[0]?.args).toContain('BatchMode=yes');
		await expect(session.operate('stop', false)).rejects.toThrow('Confirm');
		expect(requests).toHaveLength(2);
	});
	test('missing protocol support and native connection failures never retry work', async () => {
		let calls = 0;
		const provider = sshDockerProvider(ssh, async () => {
			calls++;
			return JSON.stringify({ version: 2, ok: true, value: {} });
		});
		await expect(provider.listInstances()).rejects.toThrow('wire version');
		expect(calls).toBe(1);
		const failed = sshDockerProvider(ssh, async () => {
			throw new Error('native SSH unavailable');
		});
		await expect(failed.listInstances()).rejects.toThrow('SSH unavailable');
	});
	test('a missing mutation capability does not disable supported discovery', async () => {
		const provider = sshDockerProvider(ssh, async (_binary, _args, options) => {
			const request = JSON.parse(options?.input || '{}');
			return JSON.stringify({
				version: 1,
				ok: true,
				value: request.action === 'hello' ? { actions: ['list'] } : []
			});
		});
		expect(await provider.listInstances()).toEqual([]);
		await expect(
			provider
				.open({ kind: 'ssh-docker', connectionId: 'lab', remoteHome: '/agent' })
				.operate('restart', true)
		).rejects.toThrow('does not support hosting restart');
	});
	test('a completed lifecycle action is not reported as failed when its status read fails', async () => {
		const actions: string[] = [];
		const session = sshDockerProvider(ssh, async (_binary, _args, options) => {
			const request = JSON.parse(options?.input || '{}');
			actions.push(request.action);
			if (request.action === 'inspect') throw new Error('disconnected after completion');
			return JSON.stringify({
				version: 1,
				ok: true,
				value: request.action === 'hello' ? { actions: ['stop'] } : null
			});
		}).open({ kind: 'ssh-docker', connectionId: 'lab', remoteHome: '/agent' });
		await expect(session.operate('stop', true)).rejects.toThrow('Remote stop completed');
		expect(actions).toEqual(['hello', 'stop', 'inspect']);
	});
});

describe('ACA adapter uses external deployment ownership', () => {
	function fixture(
		options: {
			revisionsFail?: boolean;
			mutationFail?: boolean;
			stopped?: boolean;
			zero?: boolean;
			unrecognized?: boolean;
			statusFailsAfterMutation?: boolean;
		} = {}
	) {
		const calls: string[][] = [];
		let mutationAccepted = false;
		const run: HostingProcess = async (binary, args) => {
			expect(binary).toBe('az');
			calls.push(args);
			if (args[0] === 'rest') {
				if (options.mutationFail) throw new Error('not authorized');
				mutationAccepted = true;
				return '';
			}
			if (mutationAccepted && options.statusFailsAfterMutation)
				throw new Error('status unavailable');
			if (args.includes('logs')) return 'system log';
			if (args.includes('revision')) {
				if (options.revisionsFail) throw new Error('revision unavailable');
				return JSON.stringify([
					{
						name: 'revision',
						properties: {
							active: true,
							replicas: options.zero ? 0 : 1,
							healthState: 'Healthy',
							runningState: options.zero ? 'ScaledTo0' : 'Running'
						}
					}
				]);
			}
			const app = {
				id: resourceId,
				name: 'agent',
				tags: { fhold: options.unrecognized ? undefined : 'assistant' },
				properties: {
					runningStatus: options.stopped ? 'Stopped' : 'Running',
					provisioningState: 'Succeeded',
					configuration: { ingress: { external: true, fqdn: 'agent.example.com' } }
				}
			};
			return JSON.stringify(args.includes('list') ? [app] : app);
		};
		return { calls, provider: azureContainerAppsProvider(aca, run) };
	}
	test('scoped discovery and status use no assistant HTTP requests or deployment writes', async () => {
		const { provider, calls } = fixture({ zero: true });
		expect((await provider.listInstances())[0]?.ref).toEqual(acaRef);
		const snapshot = await provider.open(acaRef).inspect();
		expect(snapshot.platformState).toBe('Scaled to zero');
		expect(snapshot.config).toBeUndefined();
		expect(snapshot.clientUrl).toBe('https://agent.example.com');
		expect(snapshot.capabilities.restart.supported).toBe(false);
		for (const args of calls) {
			expect(args).toContain(subscription);
			expect(args).toContain('agents');
			expect(args).toContain('--query');
			expect(args).not.toContain('update');
		}
		await expect(provider.open(acaRef).operate('restart', true)).rejects.toThrow('not supported');
		expect(calls.filter((args) => args[0] === 'rest')).toHaveLength(0);
	});
	test('revision read failures degrade status, rather than preventing unrelated inspection', async () => {
		const snapshot = await fixture({ revisionsFail: true }).provider.open(acaRef).inspect();
		expect(snapshot.platformState).toBe('Running');
		expect(snapshot.warnings).toHaveLength(1);
	});
	test('native Start/Stop is confirmed, accepted-only and never changes global account or scale settings', async () => {
		const { provider, calls } = fixture({ stopped: true });
		const session = provider.open(acaRef);
		await expect(session.operate('stop', false)).rejects.toThrow('Confirm');
		expect(calls).toHaveLength(0);
		const result = await session.operate('stop', true);
		expect(result.pending).toBe(true);
		expect(result.message).toContain('does not prove replica drain');
		const request = calls.find((args) => args[0] === 'rest');
		expect(request).toContain(`${resourceId}/stop?api-version=2026-07-01`);
		expect(calls.filter((args) => args[0] === 'rest')).toHaveLength(1);
		expect(calls.flat()).not.toContain('account');
		expect(calls.flat()).not.toContain('update');
		const failed = fixture({ mutationFail: true });
		await expect(failed.provider.open(acaRef).operate('start', true)).rejects.toThrow(
			'not authorized'
		);
		expect(failed.calls.filter((args) => args[0] === 'rest')).toHaveLength(1);
		expect((await failed.provider.open(acaRef).inspect()).name).toBe('agent');
	});
	test('an accepted request stays accepted when its follow-up status is unavailable', async () => {
		const { provider, calls } = fixture({ statusFailsAfterMutation: true });
		const result = await provider.open(acaRef).operate('start', true);
		expect(result.pending).toBe(true);
		expect(result.snapshot.platformState).toBe('Status unavailable');
		expect(result.snapshot.services).toEqual([]);
		expect(result.snapshot.warnings.join(' ')).toContain('do not repeat');
		expect(calls.filter((args) => args[0] === 'rest')).toHaveLength(1);
	});
	test('an unrecognized explicit app remains inspect-only without losing status or logs', async () => {
		const { provider, calls } = fixture({ unrecognized: true });
		const session = provider.open(acaRef);
		expect((await session.inspect()).capabilities.start.supported).toBe(false);
		await expect(session.operate('stop', true)).rejects.toThrow('inspect-only');
		expect(await session.logs()).toBe('system log');
		expect(calls.filter((args) => args[0] === 'rest')).toHaveLength(0);
	});
	test('resource scope is checked before invoking Azure; system logs need no active replica', async () => {
		const { provider, calls } = fixture({ zero: true });
		expect(() =>
			provider.open({ ...acaRef, resourceId: resourceId.replace('/agents/', '/other/') })
		).toThrow('subscription and resource group');
		expect(calls).toHaveLength(0);
		expect(await provider.open(acaRef).logs()).toBe('system log');
		expect(calls[0]).toEqual(expect.arrayContaining(['--type', 'system', '--follow', 'false']));
	});
});
