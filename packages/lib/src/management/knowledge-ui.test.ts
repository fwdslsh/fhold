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

async function fixture(native: string, address = '127.0.0.1', closeDelay = 0) {
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
 console.log(JSON.stringify({default:{IPAddress:${JSON.stringify(address)},NetworkID:'synthetic-network'}}));
if (args[0] === 'network') console.log('bridge');
if (args[0] === 'exec') {
 const {createInterface}=require('node:readline');
 const lines=createInterface({input:process.stdin});
 lines.once('line', secret => {
 if (!/^[a-f0-9]{64}$/.test(secret) || args.some(arg => arg.includes(secret))) process.exit(1);
 ${native}
 });
 process.stdin.resume();
 process.stdin.once('end', () => setTimeout(() => process.exit(0), ${closeDelay}));
}
`,
		{ mode: 0o700 }
	);
	process.env.FH_DOCKER_BIN = docker;
	return new KnowledgeUi(homeDir);
}

test('missing native UI fails promptly with guidance and does not expose private diagnostics', async () => {
	const ui = await fixture(`
 process.stderr.write('synthetic-private-path: akm-web not found');
 process.exit(127);
`);
	try {
		const failure = await ui.open().catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain('image containing akm-web');
		expect(message).not.toContain('synthetic-private-path');
	} finally {
		await ui.close();
	}
}, 5_000);

test.skipIf(process.env.FH_SOCKET_TESTS !== '1')(
	'akm-web readiness uses the private bearer and reuses the running session without a credential URL',
	async () => {
		let probes = 0;
		let bearer = '';
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch(request) {
				expect(new URL(request.url).pathname).toBe('/api/session');
				expect(new URL(request.url).search).toBe('');
				bearer = request.headers.get('authorization') ?? '';
				expect(bearer).toMatch(/^Bearer [a-f0-9]{64}$/);
				probes++;
				return Response.json({ ok: true, active: false, session: false });
			}
		});
		const ui = await fixture(
			`const ready = JSON.stringify({type:'ready', origin:'http://127.0.0.1:${server.port}'}) + '\\n'; process.stdout.write(ready.slice(0,20)); setTimeout(() => process.stdout.write(ready.slice(20)), 10);`
		);
		try {
			const access = await ui.open({ loopbackPort: server.port! });
			expect(access.url).toBe(`http://127.0.0.1:${server.port}/`);
			expect(bearer).toBe(`Bearer ${access.secret}`);
			expect(probes).toBe(1);
			expect(await ui.open()).toEqual(access);
			expect(probes).toBe(2);
		} finally {
			await ui.close();
			server.stop(true);
		}
	}
);

test.skipIf(process.env.FH_SOCKET_TESTS !== '1')(
	'SSH launch supplies the exact browser origin without publishing ports',
	async () => {
		const server = Bun.serve({
			hostname: '127.0.0.2',
			port: 0,
			fetch(request) {
				expect(request.headers.get('host')).toBe(`127.0.0.1:${server.port}`);
				expect(request.headers.get('authorization')).toMatch(/^Bearer [a-f0-9]{64}$/);
				return Response.json({ ok: true, active: true });
			}
		});
		const ui = await fixture(
			`
 const expected = ['akm-web','--host','127.0.0.2','--port','${server.port}','--origin','http://127.0.0.1:${server.port}'];
 if (JSON.stringify(args.slice(-expected.length)) !== JSON.stringify(expected)) process.exit(1);
 console.log(JSON.stringify({type:'ready',origin:'http://127.0.0.1:${server.port}'}));
 `,
			'127.0.0.2'
		);
		try {
			if (!server.port) throw new Error('Test server did not bind a port');
			expect((await ui.open({ loopbackPort: server.port })).url).toBe(
				`http://127.0.0.2:${server.port}/`
			);
		} finally {
			await ui.close();
			server.stop(true);
		}
	}
);

test.skipIf(process.env.FH_SOCKET_TESTS !== '1')('a ready line cannot disguise a non-native readiness response', async () => {
	const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ ok: true }) });
	const ui = await fixture(`console.log(JSON.stringify({type:'ready',origin:'http://127.0.0.1:${server.port}'}));`);
	try {
		await expect(ui.open({ loopbackPort: server.port! })).rejects.toThrow('Could not open');
	} finally { await ui.close(); server.stop(true); }
});

test.skipIf(process.env.FH_SOCKET_TESTS !== '1')('closing lets native shutdown drain beyond the old five-second cutoff', async () => {
	const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ ok: true, active: false, session: false }) });
	const ui = await fixture(`console.log(JSON.stringify({type:'ready',origin:'http://127.0.0.1:${server.port}'}));`, '127.0.0.1', 6000);
	try {
		await ui.open({ loopbackPort: server.port! });
		const began = performance.now();
		await ui.close();
		expect(performance.now() - began).toBeGreaterThan(5500);
	} finally { await ui.close(); server.stop(true); }
}, 12_000);
