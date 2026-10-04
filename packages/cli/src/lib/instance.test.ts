import { afterEach, expect, test } from 'bun:test';
import { defaultFholdHome, resolveFholdHome } from '@fhold/lib';
import { defineCommand } from 'citty';
import { instanceArguments, resolveInstanceHome } from './instance.js';

const originalHome = process.env.FH_HOME;
afterEach(() => {
	if (originalHome === undefined) delete process.env.FH_HOME;
	else process.env.FH_HOME = originalHome;
});

test('selection precedence is explicit name/path, environment, then cwd', () => {
	process.env.FH_HOME = '/tmp/fhold-environment-instance';
	expect(resolveInstanceHome('april')).toBe(resolveFholdHome(defaultFholdHome('april')));
	expect(resolveInstanceHome('/tmp/fhold-explicit-instance')).toBe('/tmp/fhold-explicit-instance');
	expect(resolveInstanceHome()).toBe('/tmp/fhold-environment-instance');
	delete process.env.FH_HOME;
	expect(resolveInstanceHome()).toBe(resolveFholdHome(process.cwd()));
});

test('a selector is a literal directory name or absolute path, not a relative path', () => {
	for (const invalid of ['', ' ', ' april ', '/tmp/trailing-space ', '.', '..', './april', '../april', 'april/work', 'april\\work', 'a\0b'])
		expect(() => resolveInstanceHome(invalid)).toThrow();
});

const command = defineCommand({
	subCommands: {
		task: { subCommands: { create: { args: { prompt: { type: 'string' }, file: { type: 'string', alias: 'f' } } } } },
		status: {}
	}
});

test('the global selector works before or after commands, with aliases or equals syntax', async () => {
	for (const argv of [['--instance', 'april', 'status'], ['status', '-i', 'april'], ['status', '--instance=april'], ['-i=april', 'status']])
		expect(await instanceArguments(argv, command)).toEqual({ argv: ['status'], instance: 'april' });
	expect(await instanceArguments(['task', '--instance', 'april', 'create', 'idea'], command)).toEqual({ argv: ['task', 'create', 'idea'], instance: 'april' });
});

test('string argument values and the end-of-options delimiter are never selectors', async () => {
	const argv = ['task', 'create', 'idea', '--prompt', '--instance=literal', '-f', '-i', '--instance', 'april'];
	expect(await instanceArguments(argv, command)).toEqual({ argv: argv.slice(0, -2), instance: 'april' });
	const literal = ['status', '--', '--instance', 'april'];
	expect(await instanceArguments(literal, command)).toEqual({ argv: literal });
});

test('missing and duplicate selectors fail instead of silently targeting another instance', async () => {
	for (const argv of [['--instance'], ['--instance='], ['--instance', '--help'], ['--instance', 'april', 'status', '-i', 'may']])
		await expect(instanceArguments(argv, command)).rejects.toThrow();
});
