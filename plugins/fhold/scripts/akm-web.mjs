// Native AKM readiness/activity, shared by existing health and keep-alive checks.
import { readFileSync } from 'node:fs';
import { get } from 'node:http';
import { pathToFileURL } from 'node:url';

export async function webActivity(env = process.env) {
	if (env.FH_AKM_WEB_ENABLED !== '1') return 'idle';
	try {
		const origin = new URL(env.FH_AKM_WEB_ORIGIN);
		const port = Number(env.FH_AKM_WEB_PORT || 4097);
		if (
			!['http:', 'https:'].includes(origin.protocol) ||
			origin.origin !== env.FH_AKM_WEB_ORIGIN ||
			!Number.isInteger(port) ||
			port < 1 ||
			port > 65535
		)
			return 'unknown';
		const secret = readFileSync(
			env.FH_AKM_WEB_SECRET_FILE || '/run/secrets/akm_web_secret',
			'utf8'
		).trim();
		if (!/^[\x21-\x7e]{32,4096}$/.test(secret)) return 'unknown';
		return await new Promise((resolve) => {
			const request = get(
				`http://127.0.0.1:${port}/api/session`,
				{
					headers: { Host: origin.host, Authorization: `Bearer ${secret}` },
					signal: AbortSignal.timeout(5000)
				},
				(response) => {
					let body = '';
					response.on('error', () => resolve('unknown'));
					response.on('data', (chunk) => {
						body += String(chunk);
						if (body.length > 4096) {
							response.destroy();
							resolve('unknown');
						}
					});
					response.on('end', () => {
						try {
							const value = JSON.parse(body);
							resolve(
								response.statusCode === 200 &&
									value.ok === true &&
									typeof value.active === 'boolean'
									? value.active
										? 'busy'
										: 'idle'
									: 'unknown'
							);
						} catch {
							resolve('unknown');
						}
					});
				}
			);
			request.on('error', () => resolve('unknown'));
		});
	} catch {
		return 'unknown';
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const state = await webActivity();
	console.log(state);
	process.exitCode = state === 'unknown' ? 1 : 0;
}
