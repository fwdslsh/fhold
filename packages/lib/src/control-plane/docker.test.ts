import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHome } from './install.js';
import { localInstanceManagement } from '../management/instance.js';
import { localDockerManagementHost } from './local-instance-host.js';
import { FH_RUNTIME_VERSION } from './release.js';

import {
	assertProjectOwnership,
	containerWarnings,
	completeContainerImages,
	parseComposePsRows,
	composeProcessEnvironment,
	runComposeStreaming
} from './docker.js';

const roots: string[] = [];
const originalDocker = process.env.FH_DOCKER_BIN;

it('retains actual image references from Compose JSON, without substituting configured tags', () => {
	const assistant = {
		Service: 'assistant',
		State: 'running',
		Image: 'registry.test:5000/team/assistant:old-tag'
	};
	const guardian = {
		Service: 'guardian',
		State: 'exited',
		Image: 'fwdslsh/fhold-guardian:new-tag'
	};
	for (const output of [
		JSON.stringify([assistant, guardian]),
		[assistant, guardian].map((item) => JSON.stringify(item)).join('\n')
	]) {
		expect(parseComposePsRows(output).map((row) => row.image)).toEqual([
			assistant.Image,
			guardian.Image
		]);
	}
	for (const Image of [undefined, null, { tag: 'not-a-reference' }])
		expect(
			parseComposePsRows(JSON.stringify({ Service: 'assistant', Image }))[0]?.image
		).toBeUndefined();
});

it('fills only missing image references using a single restricted Docker inspection', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-image-status-'));
	roots.push(root);
	const binary = join(root, 'docker');
	writeFileSync(
		binary,
		`#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(root, 'args.json'))}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({id:'abc123-full-id',image:'registry.test:5000/assistant:observed'}));
console.log('invalid metadata');
console.log(JSON.stringify({id:'def456-full-id',image:'guardian@sha256:abcd'}));
// Partial output still reports containers observed before another was removed.
process.exit(1);
`,
		{ mode: 0o700 }
	);
	process.env.FH_DOCKER_BIN = binary;
	const rows = parseComposePsRows(
		JSON.stringify([
			{ Service: 'assistant', ID: 'abc123', State: 'running' },
			{ Service: 'guardian', ID: 'def456', State: 'exited', Image: '' },
			{ Service: 'discord', ID: 'already', Image: 'portal:reported-by-compose' },
			{ Service: 'slack', ID: 'removed', State: 'exited' },
			{ Service: 'custom', State: 'created' }
		])
	);
	const result = await completeContainerImages(rows);
	expect(result.map((row) => row.image)).toEqual([
		'registry.test:5000/assistant:observed',
		'guardian@sha256:abcd',
		'portal:reported-by-compose',
		undefined,
		undefined
	]);
	expect(rows[0].image).toBeUndefined();
	expect(JSON.parse(await Bun.file(join(root, 'args.json')).text())).toEqual([
		'inspect',
		'--format',
		'{"id":{{json .Id}},"image":{{json .Config.Image}}}',
		'abc123',
		'def456',
		'removed'
	]);
	process.env.FH_DOCKER_BIN = join(root, 'missing-docker');
	expect(await completeContainerImages(rows)).toEqual(rows);
	// A complete status read requires no inspection at all.
	const complete = [result[0], result[2]];
	expect(await completeContainerImages(complete)).toBe(complete);
});

it('carries inspected images and the bundled update target through the Admin snapshot without changing saved pins', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-image-snapshot-'));
	roots.push(root);
	const homeDir = join(root, 'home');
	await installHome({ homeDir, automaticPorts: false });
	const binary = join(root, 'docker');
	writeFileSync(
		binary,
		`#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='compose' && args.includes('ps')) console.log(JSON.stringify([
 {Service:'assistant',ID:'a123',State:'running',Health:'healthy'},
 {Service:'guardian',ID:'b456',State:'exited',Image:'guardian:compose-observed'}
]));
if(args[0]==='inspect') console.log(args[2].includes('.Config.Image')
 ? JSON.stringify({id:'a123-full',image:'assistant:docker-observed'}) : '[]');
`,
		{ mode: 0o700 }
	);
	process.env.FH_DOCKER_BIN = binary;
	const management = localInstanceManagement(homeDir, { host: localDockerManagementHost(homeDir) });
	try {
		const snapshot = await management.call('snapshot');
		expect(snapshot.updateImageTag).toBe(FH_RUNTIME_VERSION);
		expect(snapshot.services.map((service) => service.image)).toEqual([
			'assistant:docker-observed',
			'guardian:compose-observed'
		]);
		expect(snapshot.config.deployment.images.assistant).toBe(FH_RUNTIME_VERSION);
		expect(snapshot.services[0]).toMatchObject({ state: 'running', health: 'healthy' });
	} finally {
		await management.close();
	}
});

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

describe('non-fatal optional-feature status', () => {
	it('reads only redacted degradation messages from the latest Docker health check', async () => {
		projectFixture([
			[
				{ Output: 'old failure' },
				{
					Output:
						'fhold: degraded: Scheduling unavailable. Check logs.\nfhold: degraded: Scheduling unavailable. Check logs.\nnoise\n'
				}
			]
		]);
		expect(await containerWarnings('id0')).toEqual(['Scheduling unavailable. Check logs.']);
		projectFixture([[{ Output: '' }]]);
		expect(await containerWarnings('id0')).toEqual([]);
	});
	it('reports unavailable diagnostics without rejecting status or changing containers', async () => {
		for (const values of [[null], ['broken']]) {
			const root = projectFixture(values, values[0] === null ? 'inspect' : '');
			const warnings = await containerWarnings('id0');
			expect(warnings).toEqual([
				'Optional-feature status is unavailable. Check Docker diagnostics; this does not stop the agent.'
			]);
			expect(existsSync(join(root, 'compose-ran'))).toBe(false);
		}
		projectFixture([[]]);
		expect(await containerWarnings('id0')).toEqual([]);
	});
});
