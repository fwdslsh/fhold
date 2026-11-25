import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { stateSecretFile, writeFileAtomic } from './foundation.js';
import { assertSafePortablePath } from './provider-files.js';

/** Hosting intent only. Native framing/allowedHosts remain in experimental.web. */
export type AkmWebSettings = {
	enabled: boolean;
	origin: string;
	publish: boolean;
	bindAddress: string;
	port: number;
};
export const AKM_WEB_PORT = 4097;
export const akmWebComposeFile = (home: string) => join(home, 'state/akm-web.compose.json');
export const akmWebSecretFile = (home: string) => stateSecretFile(home, 'fhold_akm_web_secret');

export function parseAkmWebSettings(value: unknown): AkmWebSettings | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw Error('assistant.web must be an object.');
	const data = value as Record<string, unknown>;
	if (
		Object.keys(data).some(
			(key) => !['enabled', 'origin', 'publish', 'bindAddress', 'port'].includes(key)
		)
	)
		throw Error('assistant.web contains unsupported settings.');
	const {
		enabled = false,
		origin = '',
		publish = false,
		bindAddress = '127.0.0.1',
		port = 3811
	} = data;
	if (
		typeof enabled !== 'boolean' ||
		typeof publish !== 'boolean' ||
		typeof origin !== 'string' ||
		typeof bindAddress !== 'string' ||
		!isIP(bindAddress) ||
		typeof port !== 'number' ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	)
		throw Error('Invalid AKM Web hosting settings.');
	if (enabled || origin) {
		let url: URL;
		try {
			url = new URL(origin);
		} catch {
			throw Error('AKM Web needs its browser-facing HTTP(S) origin.');
		}
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.origin !== origin ||
			url.username ||
			url.password
		)
			throw Error(
				'AKM Web origin must be http(s)://host[:port], without credentials, a path, query, or fragment.'
			);
	}
	return { enabled, origin, publish, bindAddress, port };
}

export function readAkmWebSecret(home: string): string {
	assertSafePortablePath(home, 'state/secrets/fhold_akm_web_secret', true);
	const value = readFileSync(akmWebSecretFile(home), 'utf8').trim();
	if (!/^[\x21-\x7e]{32,4096}$/.test(value))
		throw Error('AKM Web secret must contain 32–4096 printable non-space characters.');
	return value;
}

/** Called only during an explicit settings/runtime write, never passive inspection. */
export function writeAkmWebDeployment(home: string, settings?: AkmWebSettings): void {
	if (!settings?.enabled) return;
	assertSafePortablePath(home, 'state/secrets/fhold_akm_web_secret', true);
	assertSafePortablePath(home, 'state/akm-web.compose.json', true);
	if (!existsSync(akmWebSecretFile(home)))
		writeFileAtomic(akmWebSecretFile(home), `${randomBytes(32).toString('hex')}\n`, 0o600);
	readAkmWebSecret(home);
	writeFileAtomic(
		akmWebComposeFile(home),
		`${JSON.stringify(
			{
				services: {
					assistant: {
						environment: {
							FH_AKM_WEB_ENABLED: '1',
							FH_AKM_WEB_ORIGIN: settings.origin.replaceAll('$', '$$'),
							FH_AKM_WEB_PORT: String(AKM_WEB_PORT),
							FH_AKM_WEB_SECRET_FILE: '/run/secrets/akm_web_secret'
						},
						secrets: ['akm_web_secret'],
						...(settings.publish
							? {
									ports: [
										{
											name: 'akm-web',
											target: AKM_WEB_PORT,
											published: String(settings.port),
											host_ip: settings.bindAddress,
											protocol: 'tcp'
										}
									]
								}
							: {})
					}
				},
				secrets: { akm_web_secret: { file: '${FH_HOME:?}/state/secrets/fhold_akm_web_secret' } }
			},
			null,
			2
		)}\n`,
		0o600
	);
}
