import { defineCommand } from 'citty';
import { existsSync, statSync } from 'node:fs';
import {
	auditCompose,
	buildComposeOptions,
	classifyInstall,
	composeConfigJson,
	createFholdState,
	credentialKeyFile,
	credentialRegistryFile,
	diagnoseNativeRuntime,
	type DiagnosticCheck,
	ensureDockerReady,
	oauthConfigFile,
	oauthIdentityMapFile,
	portalCredentialBundleFile,
	portalCredentialMapFile,
	readStackConfig,
	requireInstall,
	stateSecretFile,
	unavailableNativeDiagnostics
} from '@fhold/lib';

import { defineAction } from '../lib/action.js';

type Check = DiagnosticCheck;

function fileCheck(
	name: string,
	path: string,
	requireContent = true,
	requirePrivate = true
): Check {
	if (!existsSync(path)) return { name, ok: false, detail: `missing: ${path}` };
	const stat = statSync(path);
	const privateMode = process.platform === 'win32' || (stat.mode & 0o077) === 0;
	const hasContent = !requireContent || stat.size > 0;
	return {
		name,
		ok: stat.isFile() && (!requirePrivate || privateMode) && hasContent,
		detail: `${path} (${stat.size} bytes, mode ${(stat.mode & 0o777).toString(8)})`
	};
}

export async function diagnoseStack(
	options: { readiness?: boolean } = {}
): Promise<{ ok: boolean; checks: Check[] }> {
	const state = createFholdState();
	requireInstall(state.homeDir);
	const checks: Check[] = [];
	checks.push({
		name: 'setup completion',
		ok: classifyInstall(state.homeDir) === 'installed',
		detail:
			classifyInstall(state.homeDir) === 'installed'
				? 'setup completed; current model readiness is checked only with --readiness'
				: 'incomplete; run `fhold setup` or `fhold provider test`'
	});
	const config = readStackConfig(state.homeDir);
	checks.push({
		name: 'stack config',
		ok: config.ok,
		detail: config.ok ? `${state.homeDir}/state/stack.json` : config.error
	});

	const docker = await ensureDockerReady();
	checks.push({ name: 'docker', ok: docker.ok, detail: docker.ok ? 'ready' : docker.message });
	checks.push(
		fileCheck('OpenCode password', stateSecretFile(state.homeDir, 'fhold_opencode_password')),
		fileCheck('Guardian handle key', stateSecretFile(state.homeDir, 'fhold_guardian_handle_key')),
		fileCheck('Guardian OAuth config', oauthConfigFile(state.homeDir)),
		fileCheck('Guardian OAuth identity map', oauthIdentityMapFile(state.homeDir))
	);
	if (config.ok) {
		checks.push(fileCheck('credential registry', credentialRegistryFile(state.homeDir)));
		for (const username of Object.keys(config.config.credentials)) {
			checks.push(fileCheck(`credential ${username}`, credentialKeyFile(state.homeDir, username)));
		}
		for (const portal of ['discord', 'slack'] as const) {
			checks.push(
				fileCheck(`${portal} credential map`, portalCredentialMapFile(state.homeDir, portal)),
				fileCheck(`${portal} credential bundle`, portalCredentialBundleFile(state.homeDir, portal))
			);
		}
	}

	if (config.ok && config.config.portals.discord.enabled) {
		checks.push(
			fileCheck('Discord bot token', stateSecretFile(state.homeDir, 'discord_bot_token'))
		);
	}
	if (config.ok && config.config.portals.slack.enabled) {
		checks.push(
			fileCheck('Slack bot token', stateSecretFile(state.homeDir, 'slack_bot_token')),
			fileCheck('Slack app token', stateSecretFile(state.homeDir, 'slack_app_token'))
		);
	}

	if (docker.ok) {
		const compose = await composeConfigJson(buildComposeOptions(state));
		checks.push({
			name: 'compose config',
			ok: compose.ok,
			detail: compose.ok ? 'valid' : compose.stderr || 'validation failed'
		});
		if (compose.ok) {
			const issues = auditCompose(compose.config, state.homeDir);
			checks.push({
				name: 'managed Compose recommendations',
				ok: issues.length === 0,
				advisory: true,
				detail: issues.length === 0 ? 'valid' : issues.join('; ')
			});
		}
		checks.push(...(compose.ok
			? await diagnoseNativeRuntime(state.homeDir, buildComposeOptions(state), options)
			: unavailableNativeDiagnostics('Compose configuration is invalid; native checks were not run.')));
	} else {
		checks.push(...unavailableNativeDiagnostics('Docker is unavailable; native checks were not run.'));
	}
	return { ok: checks.every((check) => check.ok || check.advisory), checks };
}

export default defineCommand({
	meta: { name: 'doctor', description: 'Check stack configuration, credentials, and Docker' },
	args: {
		json: { type: 'boolean', description: 'Print machine-readable JSON', default: false },
		readiness: {
			type: 'boolean',
			description: 'send a small real model request (may incur provider usage)',
			default: false
		}
	},
	run: defineAction(async ({ args }) => {
		const result = await diagnoseStack({ readiness: args.readiness === true });
		if (args.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			for (const check of result.checks) {
				console.log(`${check.status === 'not-checked' ? 'NOT CHECKED' : check.status === 'off' ? 'OFF' : check.ok ? 'ok' : check.advisory ? 'WARN' : 'FAIL'}  ${check.name}: ${check.detail}`);
			}
		}
		if (!result.ok) throw new Error('One or more checks failed.');
	})
});
