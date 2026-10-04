#!/usr/bin/env node
// Native policy qualification with disposable accounts, no credentials/model,
// and ordinary read-only deployment mounts. Never changes the candidate image.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, ...options });
	assert.equal(result.status, 0, `${command}: ${(result.stderr || result.stdout).slice(-4000)}`);
	return result.stdout;
}

if (process.argv[2] === '--inside') {
	assert.notEqual(process.getuid(), 0);
	for (const file of [
		'/etc/codex/config.toml',
		'/etc/codex/requirements.toml',
		'/etc/codex/hooks.json',
		'/etc/claude-code/managed-settings.json',
		'/etc/claude-code/managed-settings.d/10-fhold.json',
		'/etc/opencode/opencode.json'
	])
		assert.throws(() => accessSync(file, constants.W_OK), `Agent must not write ${file}`);

	const { withCodexRecall, reviewRecall } = await import('/usr/local/bin/fhold-codex-recall.mjs');
	const config = await withCodexRecall((rpc) =>
		rpc('config/read', { includeLayers: true, cwd: '/work' })
	);
	assert.equal(config.config.approval_policy, 'never', 'Codex loads the supplied default');
	const codexFile = '/home/fhold/.codex/config.toml';
	writeFileSync(codexFile, `approval_policy = "on-request"\n${readFileSync(codexFile, 'utf8')}`);
	// config/read returns layered input; thread/start reports the actual policy
	// after native requirements have constrained it. No model turn is started.
	const thread = await withCodexRecall((rpc) =>
		rpc('thread/start', { cwd: '/work', ephemeral: true })
	);
	assert.equal(
		thread.approvalPolicy,
		'never',
		'Codex requirements constrain a conflicting user default'
	);
	assert.equal((await withCodexRecall(reviewRecall)).managed, true);
	const inventory = await withCodexRecall((rpc) => rpc('hooks/list', { cwds: ['/work'] }));
	assert.ok(
		inventory.data[0].hooks.some(
			(hook) =>
				hook.isManaged && hook.command === 'printf operator-hook >> /tmp/operator-codex-hook'
		),
		'Additional operator hooks must coexist with the built-in inventory'
	);
	// Exercise the operator hook in the real CLI. The deliberately unreachable
	// provider keeps this independent of a model account or paid request.
	spawnSync('codex', ['exec', '--skip-git-repo-check', 'Reply OK'], {
		cwd: '/work',
		encoding: 'utf8',
		timeout: 20_000
	});
	assert.ok(readFileSync('/tmp/operator-codex-hook', 'utf8').includes('operator-hook'));
	console.log('Codex: supplied approval policy and managed hooks loaded');

	const opencode = JSON.parse(
		run('opencode', ['debug', 'config'], {
			env: {
				...process.env,
				OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: 'allow', edit: 'allow' } })
			}
		})
	);
	assert.equal(
		opencode.permission.bash,
		'deny',
		'Managed OpenCode policy overrides inline task permissions'
	);
	assert.equal(opencode.permission.edit, 'deny');
	for (const name of ['remote', 'remote-read', 'scheduled']) {
		const agent = JSON.parse(run('opencode', ['debug', 'agent', name]));
		assert.equal(agent.tools.bash, false, `${name}: shell restrictions must remain`);
		assert.equal(agent.tools.task, false, `${name}: delegation restrictions must remain`);
		if (name === 'remote') {
			assert.equal(agent.tools.read, false);
			assert.equal(agent.tools.edit, false);
		} else {
			assert.equal(agent.tools.read, true, `${name}: ordinary reads must remain usable`);
			assert.ok(
				agent.permission.some(
					(rule) =>
						rule.permission === 'read' &&
						rule.pattern === '/stash/secrets/*' &&
						rule.action === 'deny'
				)
			);
			if (name === 'remote-read') assert.equal(agent.tools.edit, false);
			else
				assert.ok(
					agent.permission.some(
						(rule) =>
							rule.permission === 'edit' &&
							rule.pattern === '/stash/inbox/*' &&
							rule.action === 'allow'
					)
				);
		}
	}
	console.log('OpenCode: managed task permissions override conflicting inline permissions');

	const settingsFile = '/home/fhold/.claude/settings.json';
	const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
	settings.permissions = { defaultMode: 'bypassPermissions', allow: ['Bash'] };
	writeFileSync(settingsFile, JSON.stringify(settings));
	const claude = spawnSync(
		'claude',
		['-p', 'Reply with OK', '--verbose', '--output-format', 'stream-json'],
		{
			cwd: '/work',
			encoding: 'utf8',
			timeout: 30_000,
			env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
		}
	);
	const messages = claude.stdout
		.split('\n')
		.filter((line) => line.startsWith('{'))
		.map((line) => JSON.parse(line));
	const init = messages.find((message) => message.type === 'system' && message.subtype === 'init');
	assert.ok(init, `Claude must report native session settings: ${claude.stderr.slice(-2000)}`);
	assert.equal(init.permissionMode, 'plan', 'Managed Claude mode overrides conflicting user mode');
	assert.ok(!init.tools.includes('Bash'), 'Managed deny removes Bash despite user allow');
	assert.equal(
		readFileSync('/tmp/operator-claude-hook', 'utf8'),
		'operator-hook',
		'Additional operator hooks must execute once alongside the built-in hooks'
	);
	console.log('Claude: managed task mode and deny rules override conflicting user settings');
} else {
	const image = process.argv[2];
	assert.ok(image, 'Usage: node scripts/smoke-managed-policy.mjs IMAGE');
	const root = mkdtempSync(join(tmpdir(), 'fhold-managed-policy-'));
	const name = `fhold-managed-policy-${process.pid}`;
	const files = [
		[
			'codex.toml',
			'/etc/codex/config.toml',
			'approval_policy = "never"\n' +
				'model="offline"\nmodel_provider="offline"\n[model_providers.offline]\n' +
				'name="offline"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\n' +
				'requires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n'
		],
		[
			'requirements.toml',
			'/etc/codex/requirements.toml',
			'allow_managed_hooks_only = true\nallowed_approval_policies = ["never"]\n[features]\nhooks = true\n' +
				'[hooks]\nmanaged_dir="/etc/codex"\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\n' +
				'type="command"\ncommand="printf operator-hook >> /tmp/operator-codex-hook"\n'
		],
		[
			'claude.json',
			'/etc/claude-code/managed-settings.json',
			JSON.stringify({
				allowManagedHooksOnly: true,
				permissions: { defaultMode: 'plan', deny: ['Bash'] },
				hooks: {
					SessionStart: [
						{
							hooks: [
								{ type: 'command', command: 'printf operator-hook >> /tmp/operator-claude-hook' }
							]
						}
					]
				}
			})
		],
		[
			'opencode.json',
			'/etc/opencode/opencode.json',
			JSON.stringify({ permission: { '*': 'allow', bash: 'deny', edit: 'deny' } })
		]
	];
	const mounts = [];
	for (const [file, target, content] of files) {
		writeFileSync(join(root, file), content, { mode: 0o644 });
		mounts.push('--mount', `type=bind,source=${join(root, file)},target=${target},readonly`);
	}
	try {
		run('docker', [
			'run',
			'-d',
			'--name',
			name,
			'--init',
			'--network',
			'none',
			'--cap-drop=ALL',
			'--security-opt',
			'no-new-privileges:true',
			'-e',
			'FH_SCHEDULER_ENABLED=0',
			'-e',
			'FH_CODEX_REMOTE=0',
			'-e',
			'FH_CLAUDE_REMOTE=0',
			'-e',
			'OPENCODE_SERVER_PASSWORD=synthetic-policy-smoke-only',
			...mounts,
			'--mount',
			`type=bind,source=${fileURLToPath(import.meta.url)},target=/tmp/smoke-managed-policy.mjs,readonly`,
			image
		]);
		const deadline = Date.now() + 60_000;
		while (
			run('docker', ['inspect', name, '--format', '{{.State.Health.Status}}']).trim() !== 'healthy'
		) {
			assert.ok(Date.now() < deadline, 'Fresh managed instance must become healthy');
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		console.log(run('docker', ['exec', name, 'bun', '/tmp/smoke-managed-policy.mjs', '--inside']));
		console.log('Managed policy image smoke passed without account sign-in or hook approval.');
	} finally {
		run('docker', ['rm', '-f', name]);
		console.log(`Synthetic policy fixtures retained at ${root}`);
	}
}
