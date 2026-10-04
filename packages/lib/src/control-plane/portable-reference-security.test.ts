import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackupSync } from './backup.js';
import { installHome } from './install.js';
import { applyRestore, planRestore } from './restore.js';
import * as foundation from './foundation.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const nativeConfig = 'config/assistant/opencode.json';
const unsafeConfigs = [
	{ provider: { custom: { options: { baseURL: 'https://invalid.example/v1', apiKey: '{file:/run/secrets/opencode_server_password}' } } } },
	{ provider: { custom: { options: { apiKey: '{env:OPENCODE_SERVER_PASSWORD}' } } } },
	{ provider: { custom: { options: { apiKey: '{env:FH_GUARDIAN_TOKEN}' } } } },
	{ provider: { custom: { options: { apiKey: 'Bearer {env:OPENAI_API_KEY}' } } } },
	{ provider: { custom: { options: { apiKey: '{file:/stash/secrets/../server-password}' } } } },
	{ model: '{file:/run/secrets/opencode_server_password}' },
	{ small_model: '{env:OPENCODE_SERVER_PASSWORD}' },
	{ $schema: '{file:/run/secrets/opencode_server_password}' },
	{ provider: { '{file:/run/secrets/opencode_server_password}': { options: {} } } }
];

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-portable-ref-'));
	roots.push(root);
	const source = join(root, 'source');
	const destination = join(root, 'destination');
	await installHome({ homeDir: source });
	await installHome({ homeDir: destination });
	writeFileSync(join(source, nativeConfig), JSON.stringify({ model: 'openai/gpt-5-nano' }));
	writeFileSync(join(source, 'knowledge/note.md'), 'authored knowledge');
	return { root, source, destination };
}

function sourceProof(source: string): string {
	const files = readdirSync(source, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
	return createHash('sha256').update(JSON.stringify(files.map((path) => [path, readFileSync(path).toString('base64')]))).digest('hex');
}

describe('portable native references never rebind installation authority', () => {
	it('own backup omits the entire unsafe native config without auth opt-in and refuses it with opt-in', async () => {
		const { root, source } = await fixture();
		for (const [index, config] of unsafeConfigs.entries()) {
			writeFileSync(join(source, nativeConfig), JSON.stringify(config));
			const before = sourceProof(source);
			const archive = join(root, `backup-${index}`);
			const manifest = createBackupSync({ sourceHome: source, destination: archive });
			expect(manifest.files.some((entry) => entry.path === nativeConfig)).toBe(false);
			expect(existsSync(join(archive, nativeConfig))).toBe(false);
			expect(manifest.files.some((entry) => entry.path === 'knowledge/note.md')).toBe(true);
			expect(() => createBackupSync({ sourceHome: source, destination: join(root, `private-${index}`), includeProviderAuth: true })).toThrow();
			expect(sourceProof(source)).toBe(before);
		}
	});

	it('restore independently omits unsafe config even with a correct own-product integrity manifest', async () => {
		const { root, source } = await fixture();
		for (const [index, config] of unsafeConfigs.entries()) {
			const archive = join(root, `archive-${index}`);
			const destination = join(root, `target-${index}`);
			await installHome({ homeDir: destination });
			const pristine = readFileSync(join(destination, nativeConfig), 'utf8');
			const manifest = createBackupSync({ sourceHome: source, destination: archive });
			// Adversarial input still has an internally consistent required fhold manifest.
			const bytes = Buffer.from(JSON.stringify(config));
			writeFileSync(join(archive, nativeConfig), bytes);
			const entry = manifest.files.find((entry) => entry.path === nativeConfig);
			if (!entry) throw new Error('Fixture must include the safe baseline native configuration');
			manifest.totalBytes += bytes.length - entry.bytes;
			entry.bytes = bytes.length;
			entry.sha256 = createHash('sha256').update(bytes).digest('hex');
			writeFileSync(join(archive, 'fhold-backup.json'), JSON.stringify(manifest));
			const before = sourceProof(archive);
			const options = { sourceHome: archive, destinationHome: destination, acknowledgeUnrestored: true };
			const plan = planRestore(options);
			expect(plan.entries.some((entry) => entry.relativeSource === nativeConfig)).toBe(false);
			expect(() => planRestore({ ...options, includeProviderAuth: true })).toThrow();
			applyRestore(options, plan.digest);
			expect(readFileSync(join(destination, nativeConfig), 'utf8')).toBe(pristine);
			expect(readFileSync(join(destination, 'knowledge/note.md'), 'utf8')).toBe('authored knowledge');
			expect(sourceProof(archive)).toBe(before);
		}
	});

	it('keeps an exact standard vendor environment reference portable', async () => {
		const { root, source, destination } = await fixture();
		const config = { provider: { openai: { options: { apiKey: '{env:OPENAI_API_KEY}' } } } };
		writeFileSync(join(source, nativeConfig), JSON.stringify(config));
		const archive = join(root, 'vendor-backup');
		const manifest = createBackupSync({ sourceHome: source, destination: archive });
		expect(manifest.files.some((entry) => entry.path === nativeConfig)).toBe(true);
		const options = { sourceHome: archive, destinationHome: destination, acknowledgeUnrestored: true };
		applyRestore(options, planRestore(options).digest);
		expect(JSON.parse(readFileSync(join(destination, nativeConfig), 'utf8'))).toEqual(config);
	});

	it('omits executable provider SDK selections, including per-model selectors, with either auth choice', async () => {
		const { root, source, destination } = await fixture();
		writeFileSync(join(source, 'workspace/provider.mjs'), 'export default () => { throw new Error("must not activate"); };');
		for (const [index, provider] of [
			{ review: { npm: 'file:///work/provider.mjs' } },
			{ review: { models: { test: { provider: { npm: 'file:///work/provider.mjs' } } } } },
			{ review: { npm: '@ai-sdk/openai-compatible' } }
		].entries()) {
			for (const includeProviderAuth of [false, true]) {
				const archive = join(root, `sdk-${index}-${includeProviderAuth}`);
				writeFileSync(join(source, nativeConfig), JSON.stringify({ model: 'review/test' }));
				const manifest = createBackupSync({ sourceHome: source, destination: archive });
				const bytes = Buffer.from(JSON.stringify({ model: 'review/test', provider }));
				writeFileSync(join(source, nativeConfig), bytes);
				const omitted = createBackupSync({ sourceHome: source, destination: join(root, `omitted-${index}-${includeProviderAuth}`), includeProviderAuth });
				expect(omitted.files.some((entry) => entry.path === nativeConfig)).toBe(false);
				const entry = manifest.files.find((entry) => entry.path === nativeConfig);
				if (!entry) throw new Error('Safe baseline native configuration must exist');
				manifest.totalBytes += bytes.length - entry.bytes;
				entry.bytes = bytes.length;
				entry.sha256 = createHash('sha256').update(bytes).digest('hex');
				writeFileSync(join(archive, nativeConfig), bytes);
				writeFileSync(join(archive, 'fhold-backup.json'), JSON.stringify(manifest));
				const before = sourceProof(archive);
				const plan = planRestore({ sourceHome: archive, destinationHome: destination, includeProviderAuth });
				expect(plan.entries.some((entry) => entry.relativeSource === nativeConfig)).toBe(false);
				expect(sourceProof(archive)).toBe(before);
			}
		}
	});

	it('refuses nested source or target before lock or receipt writes', async () => {
		const { root, source, destination } = await fixture();
		const archive = join(root, 'backup');
		createBackupSync({ sourceHome: source, destination: archive });
		const nestedTarget = join(archive, 'nested-target');
		await installHome({ homeDir: nestedTarget });
		const nestedSource = join(destination, 'nested-source');
		mkdirSync(nestedSource);
		for (const options of [
			{ sourceHome: archive, destinationHome: nestedTarget },
			{ sourceHome: nestedSource, destinationHome: destination }
		]) {
			const before = sourceProof(options.sourceHome);
			expect(() => planRestore(options)).toThrow('non-overlapping');
			expect(() => applyRestore(options)).toThrow('non-overlapping');
			expect(sourceProof(options.sourceHome)).toBe(before);
			expect(existsSync(join(options.destinationHome, 'state/restore-receipts'))).toBe(false);
		}
	});

	it('keeps a private partial-failure receipt and resumes only after an explicit fresh preview', async () => {
		const { root, source, destination } = await fixture();
		writeFileSync(join(source, 'knowledge/second.md'), 'second authored note');
		const archive = join(root, 'retry-backup');
		createBackupSync({ sourceHome: source, destination: archive });
		const before = sourceProof(archive);
		const options = { sourceHome: archive, destinationHome: destination, acknowledgeUnrestored: true };
		const plan = planRestore(options);
		const originalWrite = foundation.writeFileAtomic;
		const fault = spyOn(foundation, 'writeFileAtomic').mockImplementation((path, bytes, mode) => {
			if (path === join(destination, 'knowledge/second.md')) throw new Error('injected disk write failure');
			return originalWrite(path, bytes, mode);
		});
		try { expect(() => applyRestore(options, plan.digest)).toThrow('Re-preview to retry'); }
		finally { fault.mockRestore(); }
		const receipt = JSON.parse(readFileSync(join(destination, 'state/restore-receipts', `${plan.digest}.json`), 'utf8'));
		expect(receipt.phase).toBe('partial-failure');
		expect(receipt.completed).toContain('knowledge/note.md');
		expect(existsSync(join(destination, 'knowledge/second.md'))).toBe(false);
		expect(() => applyRestore(options, plan.digest)).toThrow('changed after preview');
		const retry = planRestore(options);
		expect(retry.entries.find((entry) => entry.relativeDestination === 'knowledge/note.md')?.action).toBe('skip-identical');
		applyRestore(options, retry.digest);
		expect(readFileSync(join(destination, 'knowledge/second.md'), 'utf8')).toBe('second authored note');
		expect(JSON.parse(readFileSync(join(destination, 'state/restore-receipts', `${retry.digest}.json`), 'utf8')).phase).toBe('completed');
		expect(sourceProof(archive)).toBe(before);
	});
});
