#!/usr/bin/env -S bun --no-env-file
// Read-only, redacted container diagnostics. No host/cloud authority.
import { hostname } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { remoteEnvironment } from '/usr/local/bin/fhold-remote.mjs';

function run(args) {
	const result = Bun.spawnSync(args, { env: remoteEnvironment(process.env), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
	return { ok: result.exitCode === 0, output: result.stdout.toString() + result.stderr.toString() };
}
function worker(tool) {
	try {
		const result = JSON.parse(readFileSync(`${process.env.FH_RUNTIME_DIR || '/tmp/fhold-runtime'}/remote/${tool}.json`, 'utf8'));
		return { state: result.state, approval: result.approval };
	} catch { return { state: 'not-started' }; }
}
function claudeAccount() {
	try {
		const result = JSON.parse(run(['claude', 'auth', 'status']).output);
		return { signedIn: result.loggedIn === true && result.authMethod === 'claude.ai', method: result.authMethod };
	} catch { return { signedIn: false, status: 'unavailable' }; }
}
function recovery() {
	const runtime = process.env.FH_RUNTIME_DIR || '/tmp/fhold-runtime';
	// The Assistant deliberately does not inherit storage selectors/credentials.
	if (!existsSync(`${runtime}/recovery.pid`)) return { enabled: false };
	try {
		const value = JSON.parse(readFileSync(`${runtime}/recovery-status.json`, 'utf8'));
		return { enabled: true, healthy: value.healthy === true, lastPublishedAt: value.lastPublishedAt };
	} catch { return { enabled: true, healthy: false }; }
}
const codexAccount = run(['codex', 'login', 'status']);
console.log(JSON.stringify({
	version: process.env.PLATFORM_VERSION,
	hostname: hostname(),
	uid: process.getuid(),
	workspace: '/work',
	knowledge: '/stash',
	schedulerEnabled: process.env.FH_SCHEDULER_ENABLED !== '0',
	recovery: recovery(),
	codex: { ...worker('codex'), sandbox: process.env.FH_CODEX_SANDBOX || 'workspace-write', signedIn: codexAccount.ok && /Logged in using ChatGPT/i.test(codexAccount.output) },
	claude: { ...worker('claude'), ...claudeAccount() },
	note: 'Account, local worker and pairing are prerequisites; verify a real native-client tool request separately.'
}, null, 2));
