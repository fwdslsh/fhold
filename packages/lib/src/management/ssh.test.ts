import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { SshInstanceManagement } from './ssh.js';
import { configureSshHelperResources } from '../control-plane/ssh-helper.js';
import type { HostingProcess } from '../control-plane/process.js';
configureSshHelperResources(async () => Buffer.from('session-fixture'));
const run: HostingProcess = async (_binary, args) =>
	args.at(-1) === 'uname -sm' ? 'Linux x86_64' : 'ready';
const connection = {
	kind: 'ssh-docker' as const,
	id: 'lab',
	label: 'Lab',
	host: 'owner@lab',
	port: 2222,
	roots: []
};
test('one native SSH process preserves setup context and delivers browser events on the management computer', async () => {
	const commands: Array<{ binary: string; args: readonly string[] }> = [];
	const urls: string[] = [];
	const native: typeof spawn = ((binary: string, args: readonly string[]) => {
		commands.push({ binary, args });
		return spawn(
			process.execPath,
			[
				'-e',
				`const {createInterface}=require('node:readline');const input=createInterface({input:process.stdin});input.on('line',line=>{const request=JSON.parse(line);if(request.method==='providerOAuthStart')console.log(JSON.stringify({event:'open-url',url:'https://example.com/authorize'}));console.log(JSON.stringify({id:request.id,ok:true,value:{homeDir:request.homeDir,setupName:request.setupName,method:request.method}}));});`
			],
			{ stdio: 'pipe' }
		);
	}) as typeof spawn;
	const home = "/opt/stacks/owner's agent; not shell";
	const api = new SshInstanceManagement(connection, home, {
		setupName: 'named-agent',
		spawn: native,
		run,
		openUrl: (url) => urls.push(url)
	});
	try {
		expect(await api.call('directory')).toMatchObject({ homeDir: home, setupName: 'named-agent' });
		await api.call('providerOAuthStart');
		await api.call('directory');
		expect(commands).toHaveLength(1);
		expect(commands[0]?.binary).toBe('ssh');
		expect(commands[0]?.args.at(-1)).toMatch(/^exec .*\/fhold hosting session$/);
		expect(commands[0]?.args).toContain('BatchMode=yes');
		expect(commands[0]?.args).toContain('2222');
		expect(commands[0]?.args.join(' ')).not.toContain(home);
		expect(urls).toEqual(['https://example.com/authorize']);
	} finally {
		await api.close();
	}
});
test('a disconnected submitted operation is reported, never silently replayed', async () => {
	let starts = 0;
	const native: typeof spawn = (() => {
		starts++;
		return spawn(process.execPath, ['-e', `process.stdin.once('data',()=>process.exit(1));`], {
			stdio: 'pipe'
		});
	}) as typeof spawn;
	const api = new SshInstanceManagement(connection, '/opt/stacks/qa', { spawn: native, run });
	try {
		await expect(api.call('saveConfig', {})).rejects.toThrow('check its current state');
		expect(starts).toBe(1);
	} finally {
		await api.close();
	}
});
test('closing while helper preparation is pending never starts an orphan session', async () => {
	let release!: (value: string) => void;
	let starts = 0;
	let preparing = true;
	const api = new SshInstanceManagement(connection, '/opt/stacks/qa', {
		run: async () =>
			preparing
				? new Promise<string>((resolve) => {
						release = resolve;
						preparing = false;
					})
				: 'ready',
		spawn: (() => {
			starts++;
			throw Error('must not spawn');
		}) as typeof spawn
	});
	const pending = api.call('directory');
	await Promise.resolve();
	await api.close();
	release('Linux x86_64');
	await expect(pending).rejects.toThrow('connection is closed');
	expect(starts).toBe(0);
});
