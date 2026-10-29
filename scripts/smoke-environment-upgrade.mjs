// Populated older native state, followed by the image's ordinary startup.
// Only disposable fixture data is written here; product files stay read-only.
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
	console.log(
		'Upgrade passed: selected plugins refreshed, user state/off choices retained, native migrations applied with external blocker reported, native scheduled command executed, repeat migration unchanged.'
	);
} else {
	throw Error('Use prepare or verify');
}
