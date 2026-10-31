import { expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createNativeAgentService } from './native-agent.js';
import { createNativeManagement } from './native-management.js';
import { startNativePty } from './native-pty.js';
import {
	saveProviderEndpoint,
	useProviderModel,
	discoverProviderModels
} from './provider-settings.js';

// One disposable published-image run; no accounts, inference, host credentials,
// image repairs, existing stacks or Azure resources. Private fixtures retained.
it.skipIf(!process.env.FH_NATIVE_MANAGEMENT_IMAGE)(
	'qualifies the published native filesystem and terminal management path',
	async () => {
		const image = process.env.FH_NATIVE_MANAGEMENT_IMAGE!;
		expect(image).toMatch(/^fwdslsh\/fhold-assistant@sha256:[a-f0-9]{64}$/);
		const execute = promisify(execFile);
		const root = mkdtempSync(join(tmpdir(), 'fhold-native-management-'));
		const password = randomUUID();
		const secret = join(root, 'password');
		writeFileSync(secret, password, { mode: 0o600 });
		const name = 'fhold-native-management-' + randomUUID().slice(0, 8);
		let started = false;
		try {
			await execute('docker', [
				'run',
				'--detach',
				'--rm',
				'--name',
				name,
				'--cap-drop=ALL',
				'--security-opt=no-new-privileges',
				'--publish',
				'127.0.0.1::4096',
				'--mount',
				`type=bind,src=${secret},dst=/run/secrets/native-password,readonly`,
				'--env',
				'OPENCODE_SERVER_PASSWORD_FILE=/run/secrets/native-password',
				'--env',
				'FH_SCHEDULER_ENABLED=0',
				'--env',
				'FH_CODEX_REMOTE=0',
				'--env',
				'FH_CLAUDE_REMOTE=0',
				image
			]);
			started = true;
			const { stdout } = await execute('docker', ['port', name, '4096/tcp']);
			const endpoint = 'http://' + stdout.trim();
			const access = {
				endpoint,
				authorization: () => 'Basic ' + Buffer.from('opencode:' + password).toString('base64')
			};
			const agent = createNativeAgentService(access);
			await agent.waitForReady({ timeoutMs: 120_000 });
			const management = createNativeManagement(access, agent);
			const before = await management.settings.readPreferences();
			expect(before).toBeObject();
			// OpenCode deliberately lacks recovery-worker credentials. Coverage
			// inspection uses only selected non-secret deployment settings.
			const coverage = JSON.parse(await management.recoveryInspect({
				FH_RECOVERY_URL: 'file:///tmp/fhold-inspection-only',
				FH_INSTANCE_ID: 'native-management-fixture'
			}));
			expect(coverage.trees).toBeArray();
			expect(coverage.sqlite).toBeArray();
			expect(coverage.selection).toBeObject();
			// Delayed echo-free input, retained pre-connect handshake, output and exit.
			const token = 'private-' + randomUUID();
			const terminal = await startNativePty(
				access,
				`process.stdin.once('data',data=>{console.log(JSON.stringify({length:data.length}));process.exit(7);});`
			);
			terminal.input(token + '\n');
			const result = await terminal.done;
			expect(result.exitCode).toBe(7);
			expect(result.output).not.toContain(token);
			expect(JSON.parse(result.output.trim()).length).toBe(token.length + 1);
			const cancelled = await startNativePty(access, 'process.stdin.resume();');
			await cancelled.cancel();
			await expect(cancelled.done).rejects.toThrow('cancelled');
			expect(() => cancelled.input(token)).toThrow('no longer connected');
			const server = await startNativePty(
				access,
				`import http from 'node:http'; process.stdin.once('data',()=>http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'native-test'}]}));}).listen(18765,'127.0.0.1',()=>console.log('listening')));`
			);
			server.input('{}\n');
			await Bun.sleep(100);
			expect(
				await discoverProviderModels(management.settings, {
					url: 'http://127.0.0.1:18765/v1',
					key: token
				})
			).toEqual(['native-test']);
			const saved = await saveProviderEndpoint(management.settings, {
				provider: 'native-transport-test',
				name: 'Native transport fixture',
				url: 'http://127.0.0.1:18765/v1',
				model: 'native-test'
			});
			expect(saved.write?.effective).toBe('verified');
			const selected = await useProviderModel(
				management.settings,
				'native-transport-test',
				'native-test'
			);
			expect(selected.write?.effective).toBe('verified');
			expect((await agent.readConfig()).model).toEqual({
				providerID: 'native-transport-test',
				model: 'native-test'
			});
			const script = await management.remoteSetup('codex', 'workspace-write', () => {});
			script.input(JSON.stringify({ cancel: true }) + '\n');
			await script.done;
			await server.cancel();
			await management.close();
			console.log(`Native image qualification passed: ${image}; private fixtures ${root}`);
		} finally {
			if (started) await execute('docker', ['stop', '--time', '30', name]);
		}
	},
	180_000
);
