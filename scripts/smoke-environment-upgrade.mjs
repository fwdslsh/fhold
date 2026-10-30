// Populated older native state, followed by the image's ordinary startup.
// Only disposable fixture data is written here; product files stay read-only.
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const fixture = '/tmp/environment-upgrade';
const home = '/home/fhold';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
function json(path, value) {
	mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function run(args, allowed = [0]) {
	const result = Bun.spawnSync(args, {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30000
	});
	assert.ok(allowed.includes(result.exitCode), `${args.join(' ')}: ${result.stderr}`);
	return result.stdout.toString();
}
function plugins(tool) {
	const result = JSON.parse(run([tool, 'plugin', 'list', '--json']));
	return tool === 'codex' ? result.installed : result;
}
function selected(tool, id) {
	return plugins(tool).find((plugin) => (plugin.pluginId ?? plugin.id) === id);
}
function verifyReadOnlyDiagnostics() {
	const original = readFileSync(configPath, 'utf8');
	function snapshot() {
		const hashes = {};
		function visit(path) {
			if (!existsSync(path)) return;
			for (const item of readdirSync(path, { withFileTypes: true })) {
				const file = `${path}/${item.name}`;
				if (item.isDirectory()) visit(file);
				else if (item.isFile() && !file.endsWith('-shm')) hashes[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
			}
		}
		for (const directory of ['/etc/akm', '/stash', '/opt/akm/data']) visit(directory);
		return hashes;
	}
	function inspect() {
		const before = snapshot();
		const info = JSON.parse(run(['akm', 'info', '--format', 'json', '--quiet']));
		run(['akm', 'migrate', 'status', '--format', 'json', '--quiet'], [0, 1]);
		run(['akm', 'task', 'doctor', '--format', 'json', '--quiet'], [0, 1, 78]);
		assert.deepEqual(snapshot(), before, 'Read-only diagnostics changed AKM config, catalog or state');
		return info;
	}
	try {
		assert.equal(inspect().configError, undefined);
		writeFileSync(configPath, '{invalid');
		assert.ok(inspect().configError, 'Malformed configuration must not pass native inspection');
		const missing = JSON.parse(original);
		missing.harnesses.opencode.bin = 'missing-upgrade-harness';
		json(configPath, missing);
		assert.ok(inspect().connectionsAndHarnesses.some((row) => row.type === 'harness' && row.installed === false));
		const external = JSON.parse(original);
		external.bundles = { external: external.bundles.external };
		external.defaultBundle = 'external'; external.defaultWriteTarget = 'external';
		json(configPath, external);
		assert.equal(inspect().configError, undefined);
		// No inference/queue write is attempted: native info cannot certify the
		// writable proposal destination. fhold's corresponding check is unknown.
		writeFileSync(configPath, original);
		assert.equal(inspect().configError, undefined);
		console.log('Native read-only diagnostics passed: malformed config, missing harness, external-only catalog and repair; config/catalog/state hashes unchanged by inspection.');
	} finally { writeFileSync(configPath, original); }
}
async function verifyAgentAndProposal() {
	const requests = [];
	const marker = 'upgrade-native-proposal';
	const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
		if (new URL(request.url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'model' }] });
		const body = await request.json();
		requests.push(body);
		const extraction = JSON.stringify(body.messages).includes('extracting durable engineering insights');
		const content = extraction ? JSON.stringify({ candidates: [{
			type: 'knowledge', name: marker, description: 'Native upgrade retains writable proposal ownership.',
			when_to_use: '', body: 'The synthetic upgrade preserved native configuration and bundle ownership. Native agent execution and a persisted reviewable proposal independently verified the migrated environment.',
			confidence: 0.99, evidence: 'The operator explicitly requested independent verification of the upgraded native environment.'
		}], rationale_if_empty: '' }) : 'FH_UPGRADE_AGENT_COMPLETE. We fixed the native harness failure because standalone execution avoids writing service state to the read-only product configuration directory. The upgrade preserved bundle ownership and user settings.';
		const chunk = (delta, finish_reason) => ({ id: 'upgrade-fixture', object: 'chat.completion.chunk', model: 'model', choices: [{ index: 0, delta, finish_reason }] });
		return body.stream ? new Response(`data: ${JSON.stringify(chunk({ role: 'assistant', content }, null))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
			: Response.json({ id: 'upgrade-fixture', object: 'chat.completion', model: 'model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
	} });
	// Operator-owned provider configuration in this disposable upgraded home.
	// Keep the migrated AKM config, harness selection, catalog and native state.
	const providerConfig = `${fixture}/opencode.json`;
	json(providerConfig, { model: 'fixture/model', providers: { fixture: {
		package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'synthetic' },
		models: { model: { capabilities: { tools: true, input: ['text'], output: ['text'] } } }
	} } });
	async function native(args, expectedCode = 0) {
		const child = Bun.spawn(args, { cwd: '/work', env: { ...process.env, OPENCODE_CONFIG: providerConfig, AKM_AUTO_MEMORY: '0', AKM_AUTO_LEARNING: '0' }, stdout: 'pipe', stderr: 'pipe', timeout: 90_000 });
		const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		assert.equal(code, expectedCode, `${args.slice(0, 3).join(' ')}: ${err}\n${out}`);
		return out;
	}
	try {
		const prompt = `Verify the upgraded native environment. ${'We fixed the root cause of the old harness failure, migrated configuration, retained operator settings and verified the writable bundle owner before extracting a reviewable proposal. '.repeat(30)}`;
		// Format migration must not silently rewrite an operator's invocation.
		// The old selection starts OpenCode's background service, which cannot
		// write service.json in the read-only product configuration directory.
		assert.equal(read(configPath).harnesses.opencode.args, undefined);
		assert.match(await native(['akm', 'agent', '--prompt', 'Inspect the upgraded environment.', '--quiet'], 1), /service\.json|PermissionDenied/);
		console.log('Preserved old harness invocation fails as expected; applying the documented explicit native operator repair.');
		await native(['akm', 'config', 'set', 'harnesses.opencode', '{"args":["run","--standalone"]}', '--silent']);
		assert.match(await native(['akm', 'agent', '--prompt', prompt, '--quiet']), /FH_UPGRADE_AGENT_COMPLETE/);
		// Retain a second turn with the repair explanation in native history.
		assert.match(await native(['opencode', 'run', '--standalone', '--continue', '--', prompt]), /FH_UPGRADE_AGENT_COMPLETE/);
		const extracted = await native(['akm', 'proposal', 'extract', '--type', 'opencode', '--force', '--timeout-ms', '30000', '--quiet']);
		assert.ok(requests.some((request) => JSON.stringify(request.messages).includes('extracting durable engineering insights')), extracted);
		// Do not trust the extraction aggregate alone: upstream #1290 can report
		// success when persistence failed. The proposal must actually be present.
		assert.match(await native(['akm', 'proposal', 'list', '--quiet']), new RegExp(marker));
		console.log('Upgraded native AKM agent execution and persisted proposal passed using a loopback model.');
	} finally { model.stop(true); }
}
const configPath = '/etc/akm/config.json';
const claudeSettings = `${home}/.claude/settings.json`;
const codexConfig = `${home}/.codex/config.toml`;
const oldVersion = '0.10.26101002-alpha';

if (process.argv[2] === 'prepare') {
	mkdirSync(fixture, { recursive: true });
	const market = `${fixture}/old-market`;
	cpSync('/akm-marketplace', market, { recursive: true });
	for (const file of [
		'claude/.claude-plugin/plugin.json',
		'claude/.codex-plugin/plugin.json',
		'claude/package.json'
	]) {
		const path = `${market}/${file}`;
		const value = read(path);
		chmodSync(path, 0o600);
		json(path, { ...value, version: oldVersion });
	}
	// Native tools create the old installation metadata and cache selection.
	run(['claude', 'plugin', 'marketplace', 'add', market]);
	run(['claude', 'plugin', 'update', 'akm@akm-plugins', '--scope', 'user', '--json']);
	run(['claude', 'plugin', 'marketplace', 'add', '/akm-marketplace']);
	// The source path in this synthetic old home represents the same immutable
	// image marketplace before and after a replacement; it is not a test repair.
	writeFileSync(
		codexConfig,
		readFileSync(codexConfig, 'utf8').replace('source = "/akm-marketplace"', `source = "${market}"`)
	);
	run(['codex', 'plugin', 'add', 'akm@akm-plugins', '--json']);
	writeFileSync(
		codexConfig,
		readFileSync(codexConfig, 'utf8').replace(`source = "${market}"`, 'source = "/akm-marketplace"')
	);
	assert.equal(selected('codex', 'akm@akm-plugins').version, oldVersion);
	assert.equal(selected('claude', 'akm@akm-plugins').version, oldVersion);

	const custom = `${fixture}/custom-market`;
	json(`${custom}/.claude-plugin/marketplace.json`, {
		name: 'upgrade-fixture',
		owner: { name: 'fixture' },
		plugins: [{ name: 'personal', source: './personal' }]
	});
	json(`${custom}/.agents/plugins/marketplace.json`, {
		name: 'upgrade-fixture',
		interface: { displayName: 'fixture' },
		plugins: [
			{
				name: 'personal',
				source: { source: 'local', path: './personal' },
				policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }
			}
		]
	});
	for (const directory of ['.claude-plugin', '.codex-plugin'])
		json(`${custom}/personal/${directory}/plugin.json`, {
			name: 'personal',
			version: '1.0.0',
			description: 'Synthetic user plugin'
		});
	for (const tool of ['claude', 'codex']) {
		run([tool, 'plugin', 'marketplace', 'add', custom]);
		run([tool, 'plugin', tool === 'claude' ? 'install' : 'add', 'personal@upgrade-fixture']);
	}
	run(['claude', 'plugin', 'disable', 'fhold@fhold-plugins']);
	const settings = read(claudeSettings);
	settings.language = 'English';
	json(claudeSettings, settings);
	writeFileSync(
		codexConfig,
		readFileSync(codexConfig, 'utf8').replace(
			'[plugins."fhold@fhold-plugins"]\nenabled = true',
			'[plugins."fhold@fhold-plugins"]\nenabled = false'
		) + '\n# operator preference retained across upgrade\n'
	);
	assert.equal(selected('codex', 'fhold@fhold-plugins').enabled, false);
	json(`${fixture}/preferences.json`, {
		claude: readFileSync(claudeSettings, 'utf8'),
		codex: readFileSync(codexConfig, 'utf8')
	});

	const config = read(configPath);
	delete config.harnesses;
	config.engines = { opencode: { kind: 'agent', platform: 'opencode-sdk', bin: 'opencode' } };
	config.bundles.external = {
		path: `${fixture}/external`,
		writable: false,
		components: { main: { adapter: 'akm' } }
	};
	config.scheduler.enabled = [];
	json(configPath, config);
	mkdirSync(`${fixture}/external/tasks`, { recursive: true });
	const legacy =
		'version: 4\nengine: opencode\nrun: node --version\nschedule:\n  - cron: "0 0 1 1 *"\n    enabled: true\n';
	writeFileSync(`${fixture}/external/tasks/readonly.yml`, legacy);
	writeFileSync(
		'/stash/tasks/upgrade-command.yml',
		`version: 4\nengine: opencode\nrun: node ${fixture}/task.mjs\nschedule: "* * * * *"\n`
	);
	writeFileSync(
		`${fixture}/task.mjs`,
		`import { writeFileSync } from 'node:fs'; writeFileSync('${fixture}/task-ran', 'native scheduler');\n`
	);
	run(['akm', 'task', 'enable', 'upgrade-command', '--quiet']);
	json(`${fixture}/before.json`, { readonly: legacy });
	console.log(
		'Populated upgrade fixture prepared: old selected plugins, user plugin/settings, disabled plugins, legacy config/tasks and read-only source.'
	);
} else if (process.argv[2] === 'verify') {
	const expected = read('/opt/fhold/tools/package.json').dependencies['akm-opencode-v2'];
	for (const tool of ['claude', 'codex']) {
		assert.equal(selected(tool, 'akm@akm-plugins').version, expected);
		assert.equal(selected(tool, 'fhold@fhold-plugins').enabled, false);
		assert.equal(selected(tool, 'personal@upgrade-fixture').version, '1.0.0');
	}
	const preferences = read(`${fixture}/preferences.json`);
	assert.equal(readFileSync(claudeSettings, 'utf8'), preferences.claude);
	assert.equal(readFileSync(codexConfig, 'utf8'), preferences.codex);
	assert.equal(read(configPath).engines, undefined);
	assert.ok(read(configPath).harnesses.opencode);
	assert.equal(
		readFileSync(`${fixture}/external/tasks/readonly.yml`, 'utf8'),
		read(`${fixture}/before.json`).readonly
	);
	assert.match(readFileSync('/stash/tasks/upgrade-command.yml', 'utf8'), /harness: opencode/);
	assert.doesNotMatch(readFileSync('/stash/tasks/upgrade-command.yml', 'utf8'), /^engine:/m);
	const migration = JSON.parse(run(['akm', 'migrate', 'status', '--format', 'json'], [0, 1]));
	assert.equal(migration.status, 'blocked');
	assert.ok(
		existsSync(`${process.env.FH_RUNTIME_DIR || '/tmp/fhold-runtime'}/degraded-akm-migration`)
	);
	assert.equal(
		run(['bash', '--login', '-c', 'command -v crontab']).trim(),
		'/usr/local/bin/crontab'
	);
	assert.match(run(['crontab', '-l']), /upgrade-command/);
	const deadline = Date.now() + 70000;
	while (!existsSync(`${fixture}/task-ran`) && Date.now() < deadline) await Bun.sleep(250);
	assert.equal(readFileSync(`${fixture}/task-ran`, 'utf8'), 'native scheduler');
	const config = readFileSync(configPath, 'utf8');
	run(['akm', 'migrate', 'apply', '--format', 'json'], [0, 1]);
	assert.equal(readFileSync(configPath, 'utf8'), config);
	// The scheduled command has been verified. Quiesce this synthetic writer
	// before comparing state bytes across diagnostic reads.
	run(['akm', 'task', 'disable', 'upgrade-command', '--quiet']);
	verifyReadOnlyDiagnostics();
	await verifyAgentAndProposal();
	console.log(
		'Upgrade passed: selected plugins refreshed, user state/off choices retained, native migrations applied with external blocker reported, native scheduled command executed, repeat migration unchanged.'
	);
} else {
	throw Error('Use prepare or verify');
}
