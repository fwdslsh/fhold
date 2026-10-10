#!/usr/bin/env node
// Run inside a disposable Assistant. Exercise the native watcher, not reloads,
// restarts, a custom loader, or vendor credentials. Managed Compose can mount
// the user settings directory writable, with managed/system policy read-only.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { OpenCode } from '/opt/fhold/tools/node_modules/@opencode/client/dist/promise/index.js';
const file = process.env.OPENCODE_CONFIG;
assert(file, 'Use the shipped explicit preferences file');
const password =
	process.env.OPENCODE_PASSWORD ||
	process.env.OPENCODE_SERVER_PASSWORD ||
	readFileSync(process.env.OPENCODE_SERVER_PASSWORD_FILE, 'utf8').trim();
const baseUrl = `http://127.0.0.1:${process.env.OPENCODE_PORT || 4096}`;
const authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
const requests = [];
const client = OpenCode.make({
	baseUrl,
	headers: { authorization },
	fetch: (input, init) => {
		const request = new Request(input, init);
		requests.push({ path: new URL(request.url).pathname, method: request.method });
		return fetch(
			new Request(request, {
				signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
			})
		);
	}
});
const location = { directory: '/work' };
const globalLocation = { directory: '/etc/opencode' };
async function until(probe, label) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			if (await probe()) return;
		} catch (error) {
			// The native graph briefly removes an agent while replacing its entry.
			// Await activation; do not retry writes or mask unrelated API failures.
			if (error?._tag !== 'AgentNotFoundError') throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Native hot update was not observed: ${label}`);
}
async function info() {
	const response = await fetch(baseUrl + '/api/info', { headers: { authorization } });
	assert.equal(response.status, 200);
	return response.json();
}
await until(
	async () => (await client.agent.list({ location })).data.some((agent) => agent.id === 'build'),
	'initial native activation'
);
const before = await info();
const inode = statSync(file).ino;
const original = readFileSync(file, 'utf8');
let retainedSession;
function save(path, text) {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, text, { mode: 0o600 });
	renameSync(temporary, path);
}
const plugin = '/work/fhold-native-watcher-fixture';
mkdirSync(plugin, { recursive: true });
writeFileSync(join(plugin, 'package.json'), JSON.stringify({ type: 'module' }));
const module = (name) => `import { Plugin } from '@opencode/plugin';
import { appendFileSync } from 'node:fs';
export default Plugin.define({ id: 'fhold.watcher.fixture', async setup(context) {
  const label = context.options.label ?? '${name}';
  await context.agent.transform(editor => editor.update('watcher-fixture', agent => { agent.description = label; }));
  appendFileSync('${plugin}/lifecycle.log', 'start:' + label + '\\n');
  return () => appendFileSync('${plugin}/lifecycle.log', 'stop:' + label + '\\n');
} });\n`;
// The native host supplies its plugin API. This is an ordinary user plugin;
// no copied SDK, injected loader or change to vendor code is involved.
save(join(plugin, 'index.js'), module('watcher_first'));
const settings = (label, effect, shell) => ({
	shell,
	permissions: [{ action: 'fhold.watcher.probe', resource: '*', effect }],
	agents: {
		'watcher-settings': {
			mode: 'all',
			description: label,
			system: `Native watched settings: ${label}`,
			permissions: [{ action: 'fhold.watcher.probe', resource: '*', effect }]
		}
	},
	commands: {
		'watcher-settings': { template: 'Return the watcher fixture marker.', description: label }
	}
});
const permission = () =>
	client.permission.create({
		sessionID: retainedSession.id,
		action: 'fhold.watcher.probe',
		resources: ['synthetic-fixture']
	});
try {
	const firstConfiguration = {
		...settings('settings_first', 'deny', '/bin/sh'),
		model: 'fhold-watcher/first',
		providers: {
			'fhold-watcher': {
				name: 'Native watcher fixture',
				package: '@opencode/ai/providers/openai-compatible',
				settings: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'synthetic-offline-fixture' },
				models: { first: { capabilities: { tools: true, input: ['text'], output: ['text'] } } }
			}
		},
		plugins: [plugin]
	};
	save(file, JSON.stringify(firstConfiguration, null, 2));
	await until(
		async () => (await client.model.default({ location })).data?.id === 'first',
		'provider/model addition'
	);
	await until(
		async () => (await client.model.default({ location: globalLocation })).data?.id === 'first',
		'global provider/model addition'
	);
	await until(
		async () =>
			(await client.plugin.list({ location })).data.some(
				(entry) => entry.id === 'fhold.watcher.fixture' && entry.state.status === 'active'
			),
		'plugin addition'
	);
	await until(
		async () =>
			(await client.agent.get({ location, agentID: 'watcher-settings' })).data?.description ===
			'settings_first',
		'agent settings addition'
	);
	await until(
		async () =>
			(await client.command.list({ location })).data.some(
				(command) => command.name === 'watcher-settings' && command.description === 'settings_first'
			),
		'command settings addition'
	);
	retainedSession = await client.session.create({
		location,
		agent: 'watcher-settings',
		title: 'Disposable native watcher qualification'
	});
	assert.equal(
		(await permission()).effect,
		'deny',
		'The native engine must enforce the initial rule'
	);
	console.log('Native provider/model and plugin additions applied without reload.');
	save(join(plugin, 'index.js'), module('watcher_second'));
	await until(
		async () =>
			(await client.agent.list({ location })).data.some(
				(agent) => agent.id === 'watcher-fixture' && agent.description === 'watcher_second'
			),
		'plugin source replacement'
	);
	assert.match(readFileSync(join(plugin, 'lifecycle.log'), 'utf8'), /stop:watcher_first/);
	console.log(
		'Native plugin source edits reactivated and cleaned up the previous registration without reload.'
	);
	save(
		file,
		JSON.stringify(
			{
				...firstConfiguration,
				plugins: [{ package: plugin, options: { label: 'watcher_configured' } }]
			},
			null,
			2
		)
	);
	await until(
		async () =>
			(await client.agent.list({ location })).data.some(
				(agent) => agent.id === 'watcher-fixture' && agent.description === 'watcher_configured'
			),
		'plugin options replacement'
	);
	assert.match(readFileSync(join(plugin, 'lifecycle.log'), 'utf8'), /stop:watcher_second/);
	console.log('Native plugin options applied with cleanup and no reload.');
	save(
		file,
		JSON.stringify(
			{
				...settings('settings_second', 'allow', '/bin/bash'),
				model: 'fhold-watcher/second',
				providers: {
					'fhold-watcher': {
						name: 'Updated watcher fixture',
						package: '@opencode/ai/providers/openai-compatible',
						settings: { baseURL: 'http://127.0.0.1:19/v1', apiKey: 'synthetic-offline-fixture' },
						models: { second: { capabilities: { tools: true, input: ['text'], output: ['text'] } } }
					}
				},
				plugins: []
			},
			null,
			2
		)
	);
	await until(
		async () => (await client.model.default({ location })).data?.id === 'second',
		'model and endpoint replacement'
	);
	await until(
		async () => (await client.model.default({ location: globalLocation })).data?.id === 'second',
		'global model replacement'
	);
	await until(
		async () =>
			(await client.config.get({ location })).some(
				(entry) => entry.type === 'document' && entry.info.shell === '/bin/bash'
			),
		'shell settings replacement'
	);
	await until(
		async () =>
			(await client.agent.get({ location, agentID: 'watcher-settings' })).data?.system ===
			'Native watched settings: settings_second',
		'agent settings replacement'
	);
	await until(
		async () => (await permission()).effect === 'allow',
		'permission change on the existing session'
	);
	await until(
		async () =>
			(await client.command.list({ location })).data.some(
				(command) =>
					command.name === 'watcher-settings' && command.description === 'settings_second'
			),
		'command settings replacement'
	);
	await until(
		async () =>
			!(await client.plugin.list({ location })).data.some(
				(entry) => entry.id === 'fhold.watcher.fixture'
			),
		'plugin removal and cleanup'
	);
	assert.match(readFileSync(join(plugin, 'lifecycle.log'), 'utf8'), /stop:watcher_configured/);
	assert.notEqual(statSync(file).ino, inode, 'Ordinary atomic editor saves must be supported');
	assert.equal((await info()).pid, before.pid, 'Native server must not restart');
	assert(
		!requests.some((request) => /\/(?:reload|dispose)(?:\/|$)/.test(request.path)),
		'No reload or disposal API call is permitted'
	);
	assert(
		!requests.some((request) => /\/(?:generate|prompt)(?:\/|$)/.test(request.path)),
		'The watcher fixture must make no model requests'
	);
	assert.equal(
		(await client.session.get({ sessionID: retainedSession.id })).id,
		retainedSession.id,
		'The existing session must survive'
	);
	console.log(
		'Native shell, agent, command and permission edits applied to the existing session without reload.'
	);
	console.log('Native replacements/removal applied with the same process and no reload API.');
} finally {
	save(file, original);
	if (retainedSession) await client.session.remove({ sessionID: retainedSession.id });
}
