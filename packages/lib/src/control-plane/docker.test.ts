import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	assertProjectOwnership,
	composeProcessEnvironment,
	runComposeStreaming
} from './docker.js';

const roots: string[] = [];
const originalDocker = process.env.FH_DOCKER_BIN;

afterEach(() => {
	if (originalDocker === undefined) delete process.env.FH_DOCKER_BIN;
	else process.env.FH_DOCKER_BIN = originalDocker;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectFixture(labels: unknown[], fail = '') {
	const root = mkdtempSync(join(tmpdir(), 'fhold-project-owner-'));
	roots.push(root);
	const binary = join(root, 'docker');
	writeFileSync(
		binary,
		`#!${process.execPath}
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === ${JSON.stringify(fail)}) process.exit(1);
if (args[0] === 'ps') console.log(${JSON.stringify(labels.map((_row, index) => `id${index}`).join('\n'))});
if (args[0] === 'inspect') console.log(${JSON.stringify(labels.map((row) => JSON.stringify(row)).join('\n'))});
if (args[0] === 'compose') writeFileSync(${JSON.stringify(join(root, 'compose-ran'))}, 'ran');
`,
		{ mode: 0o700 }
	);
	process.env.FH_DOCKER_BIN = binary;
	return root;
}

describe('named-instance isolation', () => {
	it('permits an unused name and containers owned by the exact selected folder', async () => {
		projectFixture([]);
		await assertProjectOwnership('my-agent');
		projectFixture([{ 'com.docker.compose.project.working_dir': '/one/system/stack' }]);
		await assertProjectOwnership('my-agent', '/one/system/stack');
		await expect(assertProjectOwnership('my-agent')).rejects.toThrow('already in use');
	});
	it('rejects foreign, mixed, missing or malformed ownership before invoking Compose', async () => {
		for (const labels of [
			[{ 'com.docker.compose.project.working_dir': '/other/system/stack' }],
			[
				{ 'com.docker.compose.project.working_dir': '/one/system/stack' },
				{ 'com.docker.compose.project.working_dir': '/other/system/stack' }
			],
			[{}],
			[null],
			['untrusted']
		]) {
			const root = projectFixture(labels);
			await expect(
				runComposeStreaming([
					'--project-name',
					'my-agent',
					'--project-directory',
					'/one/system/stack',
					'down'
				])
			).rejects.toThrow('another folder');
			expect(existsSync(join(root, 'compose-ran'))).toBe(false);
		}
	});
	it('fails closed when Docker cannot list or inspect the project', async () => {
		for (const fail of ['ps', 'inspect']) {
			projectFixture([{ 'com.docker.compose.project.working_dir': '/one/system/stack' }], fail);
			await expect(assertProjectOwnership('my-agent', '/one/system/stack')).rejects.toThrow();
		}
	});
});

describe('Compose process environment', () => {
	it('pins fhold interpolation without trusting host process controls from stack.env', () => {
		const root = mkdtempSync(join(tmpdir(), 'fhold-compose-env-'));
		roots.push(root);
		const file = join(root, 'stack.env');
		writeFileSync(
			file,
			[
				'FH_IMAGE_NAMESPACE=managed',
				'GUARDIAN_ALLOWED_ORIGINS=https://admin.example',
				'DOCKER_HOST=tcp://attacker.example:2375',
				'PATH=/attacker',
				'CUSTOM_VALUE=from-file',
				''
			].join('\n')
		);

		const environment = composeProcessEnvironment([file], {
			FH_IMAGE_NAMESPACE: 'caller',
			DOCKER_HOST: 'unix:///safe/docker.sock',
			PATH: '/safe',
			CUSTOM_VALUE: 'from-caller'
		});

		expect(environment.FH_IMAGE_NAMESPACE).toBe('managed');
		expect(environment.GUARDIAN_ALLOWED_ORIGINS).toBe('https://admin.example');
		expect(environment.DOCKER_HOST).toBe('unix:///safe/docker.sock');
		expect(environment.PATH).toBe('/safe');
		expect(environment.CUSTOM_VALUE).toBe('from-caller');
	});
});
