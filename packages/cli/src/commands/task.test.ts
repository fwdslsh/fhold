import { afterEach, describe, expect, it } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const roots: string[] = [];
const helper = join(import.meta.dir, '../../../../containers/assistant/fhold-task.mjs');

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-task-helper-'));
	roots.push(root);
	const knowledge = join(root, 'knowledge');
	const bin = join(root, 'bin');
	mkdirSync(join(knowledge, 'tasks'), { recursive: true });
	mkdirSync(bin);
	const calls = join(root, 'calls.jsonl');
	const fake = join(bin, 'akm');
	writeFileSync(
		fake,
		`#!/usr/bin/env bun
import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FH_AKM_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'import' && args.includes('--type')) {
  const id = args[args.indexOf('--name') + 1];
  mkdirSync(join(process.env.FH_KNOWLEDGE_DIR, 'tasks'), { recursive: true });
  copyFileSync(args[1], join(process.env.FH_KNOWLEDGE_DIR, 'tasks', id + '.yml'));
}
`
	);
	chmodSync(fake, 0o755);
	return { root, knowledge, calls, bin };
}

function run(root: ReturnType<typeof fixture>, args: string[]) {
	return Bun.spawnSync({
		cmd: [process.execPath, helper, ...args],
		env: {
			...process.env,
			PATH: `${root.bin}${delimiter}${process.env.PATH ?? ''}`,
			FH_KNOWLEDGE_DIR: root.knowledge,
			FH_AKM_CALLS: root.calls
		},
		stdout: 'pipe',
		stderr: 'pipe'
	});
}

function calls(path: string): string[][] {
	return readFileSync(path, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as string[]);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Assistant task helper', () => {
	it('forwards unchanged prompts with native harness selection and supports pause and resume', () => {
		const root = fixture();
		const created = run(root, [
			'create',
			'morning-news',
			'--schedule',
			'0 8 * * *',
			'--prompt',
			'Summarize local news'
		]);
		expect(created.exitCode).toBe(0);
		const [imported = [], enabled] = calls(root.calls);
		expect([imported[0], ...imported.slice(2)]).toEqual(['import', '--type', 'task', '--name', 'morning-news']);
		expect(enabled).toEqual(['task', 'enable', 'morning-news']);
		const task = Bun.YAML.parse(readFileSync(join(root.knowledge, 'tasks', 'morning-news.yml'), 'utf8')) as Record<string, unknown>;
		expect(task).toMatchObject({ version: 4, uses: 'akm/command', with: { content: 'Summarize local news' }, schedule: '0 8 * * *' });
		expect(task).not.toHaveProperty('harness');
		expect(existsSync(join(root.knowledge, 'inbox', 'morning-news'))).toBe(true);
		expect(run(root, ['create', 'codex-news', '--schedule', '@daily', '--prompt', 'p', '--harness', 'codex']).exitCode).toBe(0);
		expect(Bun.YAML.parse(readFileSync(join(root.knowledge, 'tasks', 'codex-news.yml'), 'utf8'))).toHaveProperty('harness', 'codex');

		expect(run(root, ['pause', 'morning-news']).exitCode).toBe(0);
		const original = readFileSync(join(root.knowledge, 'tasks', 'morning-news.yml'), 'utf8');
		expect(calls(root.calls).at(-1)).toEqual(['task', 'disable', 'morning-news']);
		expect(run(root, ['resume', 'morning-news']).exitCode).toBe(0);
		expect(calls(root.calls).at(-1)).toEqual(['task', 'enable', 'morning-news']);
		expect(readFileSync(join(root.knowledge, 'tasks', 'morning-news.yml'), 'utf8')).toBe(original);
	});

	it('unschedules by preserving the exact task definition', () => {
		const root = fixture();
		expect(
			run(root, ['create', 'check-news', '--schedule', '@daily', '--prompt', 'Check news']).exitCode
		).toBe(0);
		expect(run(root, ['remove', 'check-news']).exitCode).toBe(0);
		expect(existsSync(join(root.knowledge, 'tasks', 'check-news.yml'))).toBe(false);
		const preserved = readdirSync(join(root.knowledge, 'disabled-tasks'));
		expect(preserved).toHaveLength(1);
		expect(preserved[0]).toStartWith('check-news-');
	});

	it('delegates staged native tasks without force or a second target policy', () => {
		const root = fixture();
		mkdirSync(join(root.knowledge, 'imported-tasks'), { recursive: true });
		writeFileSync(
			join(root.knowledge, 'imported-tasks', 'safe.yml'),
			'version: 4\nuses: akm/command\nwith:\n  content: safe\nschedule: "0 8 * * *"\n'
		);
		writeFileSync(
			join(root.knowledge, 'imported-tasks', 'shell.yml'),
			'version: 4\nrun: curl https://example.invalid\nschedule: "0 8 * * *"\n'
		);
		for (const id of ['safe', 'shell']) {
			const source = join(root.knowledge, 'imported-tasks', `${id}.yml`);
			const original = readFileSync(source, 'utf8');
			expect(run(root, ['adopt', source]).exitCode).toBe(0);
			expect(calls(root.calls).at(-1)).toEqual(['import', source, '--type', 'task', '--name', id, '--quiet']);
			expect(readFileSync(source, 'utf8')).toBe(original);
		}
		const outside = join(root.root, 'outside.yml');
		writeFileSync(outside, 'version: 4\nrun: echo outside\n');
		expect(run(root, ['adopt', outside]).exitCode).toBe(1);
		expect(calls(root.calls)).toHaveLength(2);
	});
});
