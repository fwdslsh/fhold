import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webActivity } from '../plugins/fhold/scripts/akm-web.mjs';
import { observedActivity, coverage } from '../plugins/fhold/scripts/activity.mjs';

test('disabled web hosting does not read a secret or count as active', async () => {
	expect(await webActivity({})).toBe('idle');
});

test.skipIf(process.env.FH_SOCKET_TESTS !== '1')(
	'native web activity authenticates locally with canonical Host and fails conservatively',
	async () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-web-activity-'));
		const secret = 'synthetic-web-secret-'.repeat(3);
		const file = join(root, 'secret');
		writeFileSync(file, secret, { mode: 0o600 });
		let body: unknown = { ok: true, active: false };
		let status = 200;
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch(request) {
				expect(request.headers.get('host')).toBe('public.example');
				expect(request.headers.get('authorization')).toBe(`Bearer ${secret}`);
				expect(new URL(request.url).pathname).toBe('/api/session');
				return Response.json(body, { status });
			}
		});
		const env = {
			FH_AKM_WEB_ENABLED: '1',
			FH_AKM_WEB_ORIGIN: 'https://public.example',
			FH_AKM_WEB_PORT: String(server.port),
			FH_AKM_WEB_SECRET_FILE: file
		};
		try {
			expect(await webActivity(env)).toBe('idle');
			body = { ok: true, active: true };
			expect(await webActivity(env)).toBe('busy');
			status = 503;
			expect(await webActivity(env)).toBe('unknown');
			status = 200;
			body = { ok: true };
			expect(await webActivity(env)).toBe('unknown');
			expect(await webActivity({ ...env, FH_AKM_WEB_SECRET_FILE: join(root, 'missing') })).toBe(
				'unknown'
			);
		} finally {
			server.stop(true);
			rmSync(root, { recursive: true, force: true });
		}
	}
);

test('active or unobservable native web work prevents an idle decision without a parallel activity tracker', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-web-keepalive-'));
	try {
		coverage('opencode', true, root);
		const fetch = async () => {
			throw Error('native web state must prevent an idle shortcut');
		};
		expect(await observedActivity(root, { remotes: [] }, fetch, async () => 'busy')).toBe('busy');
		expect(await observedActivity(root, { remotes: [] }, fetch, async () => 'unknown')).toBe(
			'unknown'
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
