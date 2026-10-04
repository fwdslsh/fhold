#!/usr/bin/env bun

import { defineCommand, runCommand } from 'citty';
import { readFileSync } from 'node:fs';
import {
	assistantEndpoint,
	classifyInstall,
	readStackConfig,
	resolveFholdHome,
	stateSecretFile
} from '@fhold/lib';

import cliPackage from '../package.json' with { type: 'json' };

async function assistantHealthy(): Promise<boolean> {
	const homeDir = resolveFholdHome();
	try {
		const password = readFileSync(
			stateSecretFile(homeDir, 'fhold_opencode_password'),
			'utf8'
		).trim();
		if (!password) return false;
		const authorization = Buffer.from(`opencode:${password}`, 'utf8').toString('base64');
		const response = await fetch(`${assistantEndpoint(homeDir)}/config`, {
			headers: { authorization: `Basic ${authorization}` },
			signal: AbortSignal.timeout(1_500)
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function autoRun(): Promise<void> {
	const homeDir = resolveFholdHome();
	const installState = classifyInstall(homeDir);
	if (installState === 'not_installed') {
		const { bootstrapInstall } = await import('./commands/install.js');
		await bootstrapInstall({ start: true });
		return;
	}
	if (installState === 'incompatible_home') {
		throw new Error(
			`Refusing incompatible fhold home at ${homeDir}. Choose an empty FH_HOME for a new installation.`
		);
	}
	if (installState === 'setup_incomplete') {
		const { completeSetup } = await import('./commands/setup.js');
		await completeSetup({});
		return;
	}

	if (!(await assistantHealthy())) {
		const { runStartAction } = await import('./commands/lifecycle.js');
		await runStartAction();
	}

	const config = readStackConfig(homeDir);
	console.log('fhold Assistant is running.');
	console.log(`Native OpenCode: ${assistantEndpoint(homeDir)}`);
	if (config.ok && config.config.gateway.enabled) {
		console.log(
			`Guardian MCP: http://${config.config.gateway.bindAddress}:${config.config.gateway.port}/mcp`
		);
	}
}

const subCommands = {
	install: () => import('./commands/install.js').then((module) => module.default),
	setup: () => import('./commands/setup.js').then((module) => module.default),
	provider: () => import('./commands/provider.js').then((module) => module.default),
	backup: () => import('./commands/backup.js').then((module) => module.default),
	history: () => import('./commands/history.js').then((module) => module.default),
	connect: () => import('./commands/connect.js').then((module) => module.default),
	remote: () => import('./commands/remote.js').then((module) => module.default),
	restore: () => import('./commands/restore.js').then((module) => module.default),
	task: () => import('./commands/task.js').then((module) => module.default),
	update: () => import('./commands/update.js').then((module) => module.default),
	guardian: () => import('./commands/guardian.js').then((module) => module.default),
	credential: () => import('./commands/credential.js').then((module) => module.default),
	portal: () => import('./commands/portal.js').then((module) => module.default),
	config: () => import('./commands/config.js').then((module) => module.default),
	doctor: () => import('./commands/doctor.js').then((module) => module.default),
	start: () => import('./commands/lifecycle.js').then((module) => module.startCommand),
	stop: () => import('./commands/lifecycle.js').then((module) => module.stopCommand),
	restart: () => import('./commands/lifecycle.js').then((module) => module.restartCommand),
	logs: () => import('./commands/lifecycle.js').then((module) => module.logsCommand),
	status: () => import('./commands/lifecycle.js').then((module) => module.statusCommand)
} as const;

const COMMAND_USAGE: Readonly<Record<string, string>> = {
	install: 'fhold install [--name <instance-name>] [--no-start] [--config <stack.json>]',
	setup: 'fhold setup [--provider <id>] [--method <label>] [--claude-remote] [--codex-remote]',
	provider:
		'fhold provider list | login [provider] [--method <label>] | key <provider> --key-file <path|-> | logout <provider> | test',
	backup:
		'fhold backup --to <empty-directory> [--include-provider-auth] [--include-user-env] [--include-portal-maps] [--include-oauth]',
	history:
		'fhold history export --from <source-home> --image <source-assistant-image> --to <new-private-archive> [--runtime <resolved-opencode-data-directory>] | restore --from <archive> --directory-map <file> [--archive-interrupted] [--apply --same-instance]',
	connect:
		'fhold connect <opencode|mcp|claude|remote> [--credential <username>] [--show-key] [--json]',
	remote:
		'fhold remote enable <codex|claude> [--trust] [--sandbox <workspace-write|read-only|danger-full-access>] [--no-browser] | disable <codex|claude> | setup <codex|claude> | pair <codex|claude> | status <codex|claude> | logs <codex|claude>',
	restore:
		'fhold restore --from <source-home> [--dry-run|--apply] [--acknowledge-unrestored] [--include-provider-auth] [--include-user-env] [--include-portal-maps] [--include-oauth]',
	task: 'fhold task list | create <id> --schedule <cron> --prompt <text> | show <id> | pause <id> | resume <id> | run <id> | history [id] | remove <id> | adopt <file>',
	update: 'fhold update [--no-start] [--pull|--no-pull] (local fhold images never pull)',
	guardian: 'fhold guardian enable | disable | configure [--bind <ip>] [--port <port>]',
	credential:
		'fhold credential list | add <username> <chat|read|full> [--key-file <path>] [--show-key] | show <username> [--show-key] | set-policy <username> <chat|read|full> | rotate <username> [--key-file <path>] [--show-key] | remove <username> | map <discord|slack> <user-id> <username> | map oauth <issuer> <subject> <username> | unmap <discord|slack> <user-id> | unmap oauth <issuer> <subject> | mappings <discord|slack|oauth>',
	portal:
		'fhold portal enable <discord|slack> | disable <portal> | credential <portal> --credential <username> | show <portal> | access <portal> [allowlists] | token <portal> --bot-token-file <path|-> [--app-token-file <path|->]',
	config:
		'fhold config show | path | assistant [--bind <ip>] [--port <port>] [--timezone <IANA-zone>] [--memory <on|off>] | oauth [--resource <https-url> --issuer <https-url> --jwks-url <https-url>] [--disable]',
	doctor: 'fhold doctor [--json] [--readiness]',
	start: 'fhold start',
	stop: 'fhold stop',
	restart: 'fhold restart',
	logs: 'fhold logs',
	status: 'fhold status'
};

export function helpText(command?: string): string {
	if (command) {
		const usage = COMMAND_USAGE[command];
		if (!usage) throw new Error(`Unknown command: ${command}`);
		return `Usage: ${usage}\n${['remote', 'setup', 'config'].includes(command) ? 'Codex and Claude Code native remote access is experimental; host and account support vary.\n' : ''}`;
	}
	return [
		'fhold — manage your self-hosted personal agent',
		'',
		'Usage: fhold <command> [options]',
		'',
		'Commands:',
		...Object.entries(COMMAND_USAGE).map(([name, usage]) =>
			`  ${name.padEnd(9)} ${usage.replace(/^fhold\s+\S+\s*/, '')}`.trimEnd()
		),
		'',
		'Run `fhold help <command>` for command usage.',
		'Codex and Claude Code native remote access is experimental.',
		'Run `fhold --version` for the installed version.'
	].join('\n');
}

export const mainCommand = defineCommand({
	meta: {
		name: 'fhold',
		version: cliPackage.version,
		description: 'Manage your self-hosted fhold personal agent'
	},
	subCommands
});

const commandNames = new Set([...Object.keys(subCommands), '--help', '-h', 'help']);

export async function main(argv = process.argv.slice(2)): Promise<void> {
	if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
		console.log(cliPackage.version);
		return;
	}
	if (argv[0] === '--help' || argv[0] === '-h') {
		console.log(helpText());
		return;
	}
	if (argv[0] === 'help') {
		console.log(helpText(argv[1]));
		return;
	}
	if (argv.slice(1).some((arg) => arg === '--help' || arg === '-h')) {
		console.log(helpText(argv[0]));
		return;
	}
	if (argv.length === 0) {
		await autoRun();
		return;
	}
	if (!commandNames.has(argv[0] ?? '')) {
		throw new Error(`Unknown command: ${argv[0]}. Run \`fhold --help\` for available commands.`);
	}
	await runCommand(mainCommand, { rawArgs: argv });
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
