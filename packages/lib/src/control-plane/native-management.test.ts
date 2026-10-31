import { describe, expect, it } from 'bun:test';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	symlinkSync,
	statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NATIVE_PREFERENCE_COMMAND } from './native-management.js';
import { editNativePreferenceJsonc } from './provider-files.js';

function fixture() {
	const home = mkdtempSync(join(tmpdir(), 'native-preferences-test-'));
	mkdirSync(join(home, '.config/opencode'), { recursive: true });
	const path = join(home, '.config/opencode/opencode.jsonc');
	const original = '{\n  // Operator comment\n  "model": "old/model",\n  "unrelated": true\n}\n';
	writeFileSync(path, original, { mode: 0o600 });
	async function run(input: unknown, selected = path) {
		const child = Bun.spawn(['node', '--input-type=module', '-e', NATIVE_PREFERENCE_COMMAND], {
			env: { ...process.env, HOME: home, OPENCODE_CONFIG: selected },
			stdin: new Response(JSON.stringify(input) + '\n'),
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const output = await new Response(child.stdout).text();
		return { code: await child.exited, value: JSON.parse(output) as Record<string, unknown> };
	}
	return { home, path, original, run };
}

describe('native atomic preference save', () => {
	it('preserves JSONC and unrelated keys with a same-directory atomic replacement', async () => {
		const f = fixture(),
			before = statSync(f.path).ino;
		const document = (await f.run({})).value;
		const text = editNativePreferenceJsonc(f.original, { model: 'new/model' });
		expect(
			await f.run({ write: true, path: document.path, digest: document.digest, text })
		).toMatchObject({ code: 0, value: { saved: true } });
		expect(readFileSync(f.path, 'utf8')).toBe(text);
		expect(text).toContain('// Operator comment');
		expect(text).toContain('"unrelated": true');
		expect(statSync(f.path).ino).not.toBe(before);
		expect(statSync(f.path).mode & 0o777).toBe(0o600);
	});
	it('rejects a stale client document without rolling back newer operator changes', async () => {
		const f = fixture();
		const digest = createHash('sha256').update(f.original).digest('hex');
		writeFileSync(f.path, '{"model":"operator/newer"}\n');
		expect((await f.run({ write: true, path: f.path, digest, text: '{}' })).code).toBe(1);
		expect(readFileSync(f.path, 'utf8')).toBe('{"model":"operator/newer"}\n');
	});
	it('refuses linked preference components without exposing private contents', async () => {
		const f = fixture(),
			external = join(f.home, 'private.json');
		writeFileSync(external, 'private-secret');
		const linked = join(f.home, '.config/opencode/opencode.json');
		symlinkSync(external, linked);
		expect((await f.run({}, linked)).code).toBe(1);
		expect(readFileSync(external, 'utf8')).toBe('private-secret');
	});
});
