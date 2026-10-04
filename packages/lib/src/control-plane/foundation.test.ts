import { afterEach, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createFholdState, defaultFholdHome, resolveFholdHome } from './foundation.js';
import { defaultStackConfig } from './stack-config.js';

const originalHome = process.env.FH_HOME;
afterEach(() => {
	if (originalHome === undefined) delete process.env.FH_HOME;
	else process.env.FH_HOME = originalHome;
});

test('default homes are named directories without creating or adopting an old home', () => {
	delete process.env.FH_HOME;
	expect(defaultFholdHome()).toBe(join(homedir(), 'fhold', 'instances', 'default'));
	expect(defaultFholdHome('april')).toBe(join(homedir(), 'fhold', 'instances', 'april'));
	expect(resolveFholdHome()).toBe(resolveFholdHome(defaultFholdHome()));
	expect(createFholdState(undefined, 'april').homeDir).toBe(resolveFholdHome(defaultFholdHome('april')));
	expect(defaultStackConfig().deployment.projectName).toBe('default');
	expect(defaultStackConfig(defaultFholdHome('april')).deployment.projectName).toBe('april');
});

test('explicit and environment homes override naming without changing their layout or identity', () => {
	process.env.FH_HOME = '/tmp/fhold-custom-home';
	expect(resolveFholdHome(undefined, 'april')).toBe('/tmp/fhold-custom-home');
	expect(createFholdState('/tmp/fhold-other-home', 'april').homeDir).toBe('/tmp/fhold-other-home');
	expect(defaultStackConfig('/tmp/fhold-custom-home').deployment.projectName).toStartWith('fhold-');
});

test('names cannot escape the default instance directory', () => {
	for (const name of ['', '..', '../april', '/april', 'April', 'my agent', 'a'.repeat(64)])
		expect(() => defaultFholdHome(name)).toThrow('instance name');
});
