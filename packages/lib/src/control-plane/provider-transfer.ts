import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildComposeOptions } from './compose.js';
import { composeConfigJson, composePs, parseComposePsRows } from './docker.js';
import { createFholdState } from './foundation.js';
import { assertSafePortablePath, readProviderSecretFile } from './provider-files.js';
import { runNativeWorker, type NativeWorkerContext } from './native-worker.js';

export const PROVIDER_CREDENTIAL_EXPORT = 'knowledge/secrets/opencode-credentials.json';
const runtimePath = 'data/assistant/.local/share/opencode';

/** Portable v1 auth-only exports have no database for upstream migration.
 * Adapt that old file format once, then use the ordinary native import API.
 * Runtime upgrades with a database use OpenCode's own migration instead.
 */
export function legacyProviderCredentials(contents: Buffer): Buffer | undefined {
	const input: unknown = JSON.parse(contents.toString('utf8'));
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new Error('Legacy provider credentials must contain an object.');
	const entries = Object.entries(input).map(([id, raw]) => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw))
			throw new Error('Unsupported legacy provider credential; original retained.');
		const old = raw as Record<string, unknown>;
		const integrationID = id.replace(/\/+$/, '');
		let value: Record<string, unknown>;
		if (old.type === 'api' && typeof old.key === 'string')
			value = { type: 'key', key: old.key, ...(old.metadata ? { metadata: old.metadata } : {}) };
		else if (
			old.type === 'oauth' &&
			typeof old.access === 'string' &&
			typeof old.refresh === 'string' &&
			typeof old.expires === 'number'
		)
			value = {
				type: 'oauth',
				methodID:
					integrationID === 'openai'
						? 'chatgpt-browser'
						: ['github-copilot', 'opencode', 'xai'].includes(integrationID)
							? 'device'
							: 'oauth',
				access: old.access,
				refresh: old.refresh,
				expires: old.expires,
				...(old.accountId || old.enterpriseUrl
					? {
							metadata: {
								...(old.accountId ? { accountID: old.accountId } : {}),
								...(old.enterpriseUrl ? { enterpriseUrl: old.enterpriseUrl } : {})
							}
						}
					: {})
			};
		else
			throw new Error(
				'Unsupported legacy provider credential; preserve the original and sign in through OpenCode.'
			);
		return {
			id: `cred_${createHash('sha256')
				.update(JSON.stringify([integrationID, value]))
				.digest('hex')
				.slice(0, 32)}`,
			integrationID,
			label: value.type === 'oauth' ? 'OAuth' : 'API key',
			active: true,
			value
		};
	});
	return entries.length ? Buffer.from(`${JSON.stringify(entries)}\n`) : undefined;
}

/** Native credential APIs are the same ones used by `opencode auth export/import`. */
async function credentialsJob({ snapshot, open, api }: NativeWorkerContext): Promise<void> {
	const fs = await import('node:fs');
	type Credential = {
		id: string;
		integrationID: string;
		label: string;
		active: boolean;
		value: unknown;
	};
	const importing = process.env.FH_NATIVE_TRANSFER === 'import';
	if (!importing) {
		fs.mkdirSync('/tmp/data/opencode', { recursive: true, mode: 0o700 });
		snapshot('/source/opencode.db', '/tmp/data/opencode/opencode.db');
		// Existing v1 databases perform upstream's one-time credential migration.
		if (fs.existsSync('/legacy/auth.json'))
			fs.copyFileSync('/legacy/auth.json', '/tmp/data/opencode/auth.json');
	}
	await open(importing ? '/target' : '/tmp/data');
	const current = ((await api('/credential')) as { data: Credential[] }).data;
	if (!importing) {
		// OpenCode namespaces remote MCP OAuth credentials with mcp_. Those are
		// runtime integrations, intentionally outside a provider-only export.
		const providers = current.filter((entry) => !entry.integrationID.startsWith('mcp_'));
		fs.writeFileSync('/transfer/credentials.json', `${JSON.stringify(providers, null, 2)}\n`, {
			mode: 0o600
		});
		return;
	}
	const entries: Credential[] = JSON.parse(fs.readFileSync('/transfer/credentials.json', 'utf8'));
	if (!Array.isArray(entries)) throw new Error('Native credential export must be an array.');
	const ids = new Set(current.map((entry) => entry.id));
	const integrations = new Set(current.map((entry) => entry.integrationID));
	for (const entry of entries) {
		if (entry.integrationID.startsWith('mcp_'))
			throw new Error('Provider import cannot activate MCP credentials.');
		const previous = current.find((item) => item.id === entry.id);
		if (previous && JSON.stringify(previous.value) !== JSON.stringify(entry.value))
			throw new Error('Credential ID conflicts with existing sign-in; neither was replaced.');
		if (ids.has(entry.id)) continue;
		await api('/credential', {
			id: entry.id,
			integrationID: entry.integrationID,
			label: entry.label,
			value: entry.value,
			activate: entry.active && !integrations.has(entry.integrationID)
		});
	}
	const restored = ((await api('/credential')) as { data: Credential[] }).data;
	for (const entry of entries) {
		const actual = restored.find((item) => item.id === entry.id);
		if (
			!actual ||
			actual.integrationID !== entry.integrationID ||
			JSON.stringify(actual.value) !== JSON.stringify(entry.value)
		)
			throw new Error('Native credential import verification failed; private export retained.');
	}
}

async function transfer(home: string, contents?: Buffer): Promise<Buffer> {
	const compose = buildComposeOptions(createFholdState(home));
	const config = await composeConfigJson(compose);
	const image = config.ok
		? (config.config as { services?: { assistant?: { image?: string } } }).services?.assistant
				?.image
		: undefined;
	if (!image)
		throw new Error(
			'The selected Assistant image could not be resolved for native credential transfer.'
		);
	const runtime = join(home, runtimePath);
	assertSafePortablePath(home, runtimePath, true);
	for (const file of ['opencode.db', 'opencode.db-wal', 'opencode.db-shm', 'opencode.db-journal'])
		assertSafePortablePath(home, `${runtimePath}/${file}`, true);
	if (contents) {
		const status = await composePs(compose);
		if (
			!status.ok ||
			parseComposePsRows(status.stdout).some((row) => !['exited', 'created'].includes(row.state))
		)
			throw new Error('Stop the destination stack before importing native sign-ins.');
		mkdirSync(runtime, { recursive: true, mode: 0o700 });
	}
	const temporary = mkdtempSync(join(tmpdir(), 'fhold-provider-transfer-'));
	try {
		if (contents) writeFileSync(join(temporary, 'credentials.json'), contents, { mode: 0o600 });
		const mounts = [
			'--mount',
			`type=bind,src=${temporary},dst=/transfer`,
			'--mount',
			contents
				? `type=bind,src=${join(home, 'data/assistant/.local/share')},dst=/target`
				: `type=bind,src=${runtime},dst=/source,readonly`
		];
		const legacy = 'knowledge/secrets/auth.json';
		if (!contents && existsSync(join(home, legacy))) {
			assertSafePortablePath(home, legacy);
			mounts.push('--mount', `type=bind,src=${join(home, legacy)},dst=/legacy/auth.json,readonly`);
		}
		await runNativeWorker(image, mounts, credentialsJob, [
			`FH_NATIVE_TRANSFER=${contents ? 'import' : 'export'}`
		]);
		return readFileSync(join(temporary, 'credentials.json'));
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

export async function exportProviderCredentials(home: string): Promise<Buffer | undefined> {
	assertSafePortablePath(home, `${runtimePath}/opencode.db`, true);
	if (existsSync(join(home, runtimePath, 'opencode.db'))) return transfer(home);
	const legacy = 'knowledge/secrets/auth.json';
	return existsSync(join(home, legacy))
		? legacyProviderCredentials(readProviderSecretFile(home, legacy))
		: undefined;
}
export async function importProviderCredentials(home: string, contents: Buffer): Promise<void> {
	await transfer(home, contents);
}
