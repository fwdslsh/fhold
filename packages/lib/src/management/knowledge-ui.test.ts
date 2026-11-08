import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHome } from '../control-plane/install.js';
import { KnowledgeUi } from './knowledge-ui.js';

const roots: string[] = [];
const originalDocker = process.env.FH_DOCKER_BIN;
afterEach(() => {
	if (originalDocker === undefined) delete process.env.FH_DOCKER_BIN;
	else process.env.FH_DOCKER_BIN = originalDocker;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(native: string) {
	const root = mkdtempSync(join(tmpdir(), 'fhold-knowledge-ui-'));
	roots.push(root);
	const homeDir = join(root, 'home');
	await installHome({ homeDir, automaticPorts: false });
	const docker = join(root, 'docker');
	writeFileSync(
		docker,
		`#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'ps') process.exit(0);
if (args[0] === 'compose' && args.includes('ps'))
 console.log(JSON.stringify({Service:'assistant',ID:'synthetic-assistant',State:'running'}));
if (args[0] === 'inspect')
 console.log(JSON.stringify({default:{IPAddress:'127.0.0.1',NetworkID:'synthetic-network'}}));
if (args[0] === 'network') console.log('bridge');
if (args[0] === 'exec') {
 ${native}
 process.stdin.resume();
 process.stdin.once('end', () => process.exit(0));
}
`,
		{ mode: 0o700 }
	);
	process.env.FH_DOCKER_BIN = docker;
	return new KnowledgeUi(homeDir);
}

test('removed native UI fails promptly with guidance and does not expose private diagnostics', async () => {
	const ui = await fixture(`
 const response = JSON.stringify({ok:false,code:'UNKNOWN_COMMAND',error:'Unknown command ui',private:'synthetic-private-path'});
 process.stderr.write(response.slice(0,18));
 setTimeout(() => process.stderr.write(response.slice(18)), 10);
`);
	try {
		const failure = await ui.open().catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain('AKM Desktop');
		expect(message).toContain('inside the Assistant');
		expect(message).not.toContain('synthetic-private-path');
	} finally {
		await ui.close();
	}
}, 5_000);

test.skipIf(process.env.FH_SOCKET_TESTS !== '1')(
	'an Assistant that still provides the UI retains native token probing and session ownership',
	async () => {
		let probes = 0;
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch(request) {
				expect(request.headers.get('X-Akm-Ui-Token')).toBe('synthetic-token');
				expect(new URL(request.url).pathname).toBe('/api/meta');
				probes++;
				return Response.json({});
			}
		});
		const ui = await fixture(
			`console.log('akm ui: http://0.0.0.0:${server.port}/?token=synthetic-token');`
		);
		try {
			expect(await ui.open()).toEqual({
				url: `http://127.0.0.1:${server.port}/?token=synthetic-token`
			});
			expect(probes).toBe(1);
		} finally {
			await ui.close();
			server.stop(true);
		}
	}
);
