import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { SshInstanceManagement, SSH_MANAGEMENT_COMMAND } from './ssh.js';
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
		openUrl: (url) => urls.push(url)
	});
	try {
		expect(await api.call('directory')).toMatchObject({ homeDir: home, setupName: 'named-agent' });
		await api.call('providerOAuthStart');
		await api.call('directory');
		expect(commands).toHaveLength(1);
		expect(commands[0]?.binary).toBe('ssh');
		expect(commands[0]?.args.at(-1)).toBe(SSH_MANAGEMENT_COMMAND);
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
	const api = new SshInstanceManagement(connection, '/opt/stacks/qa', { spawn: native });
	try {
		await expect(api.call('saveConfig', {})).rejects.toThrow('check its current state');
		expect(starts).toBe(1);
	} finally {
		await api.close();
	}
});
