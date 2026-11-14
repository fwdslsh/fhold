import { defineCommand } from 'citty';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
	createFholdState,
	LOCAL_CONNECTION,
	openInstanceSession,
	requireInstall,
	waitForAssistant,
	invokeOperation,
	type ComposedInstanceSession
} from '@fhold/lib';

import { runStartAction } from './lifecycle.js';
import { enableRemote } from './remote.js';
import { runSessionProviderCommand } from '../lib/session-provider-command.js';

/** The native Connect/Ready steps shared by local and hosted instances. */
export async function completeSessionSetup(
	session: ComposedInstanceSession,
	argv: string[],
	write: (text: string) => void = console.log
): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		strict: true,
		options: {
			provider: { type: 'string' },
			method: { type: 'string' },
			model: { type: 'string' },
			'password-file': { type: 'string' }
		}
	});
	const passwordFile = values['password-file'];
	let password: string | undefined;
	if (passwordFile) {
		password = readFileSync(passwordFile === '-' ? 0 : passwordFile, 'utf8').replace(
			/[\r\n]+$/,
			''
		);
		if (!password || /[\r\n]/.test(password))
			throw new Error('Native password input must contain one nonempty line.');
	}
	await invokeOperation(session.agent.connect, password ? { password } : {});
	const request = {
		...(values.provider ? { provider: values.provider } : {}),
		...(values.model ? { model: values.model } : {})
	};
	let readiness = await invokeOperation(session.agent.readiness, request);
	if (!readiness.ok && values.provider) {
		if (passwordFile === '-')
			throw new Error(
				`Provider readiness failed: ${readiness.error}. Use provider login with a private password file so native sign-in can continue.`
			);
		await runSessionProviderCommand(
			session,
			[
				'login',
				values.provider,
				...(values.method ? ['--method', values.method] : []),
				...(passwordFile ? ['--password-file', passwordFile] : [])
			],
			write
		);
		readiness = await invokeOperation(session.agent.readiness, request);
	}
	if (!readiness.ok)
		throw new Error(
			`Provider readiness failed: ${readiness.error}. Use provider login or provider key, then repeat setup.`
		);
	write(JSON.stringify(readiness, null, 2));
	write(
		'Verified a real native Assistant response. Native worker sign-in and client consent remain separate.'
	);
}

export async function completeSetup(options: {
	homeDir?: string;
	provider?: string;
	method?: string;
	claudeRemote?: boolean;
	codexRemote?: boolean;
}): Promise<void> {
	const state = createFholdState(options.homeDir);
	requireInstall(state.homeDir);
	await runStartAction(state.homeDir);
	await waitForAssistant(state.homeDir);
	const session = openInstanceSession(LOCAL_CONNECTION, {
		kind: 'local-docker',
		connectionId: 'local',
		homeDir: state.homeDir
	});
	try {
		await completeSessionSetup(session, [
			...(options.provider ? ['--provider', options.provider] : []),
			...(options.method ? ['--method', options.method] : [])
		]);
	} finally {
		await session.close();
	}
	if (options.claudeRemote) await enableRemote('claude', { homeDir: state.homeDir });
	if (options.codexRemote) await enableRemote('codex', { homeDir: state.homeDir });
}

export default defineCommand({
	meta: {
		name: 'setup',
		description: 'Start Assistant, sign in to a provider, and verify readiness'
	},
	args: {
		provider: { type: 'string', description: 'Provider id' },
		method: { type: 'string', description: 'Numeric OAuth method index from provider list' },
		'claude-remote': {
			type: 'boolean',
			description: 'Guide experimental Claude Remote Control sign-in after provider setup'
		},
		'codex-remote': {
			type: 'boolean',
			description: 'Guide experimental Codex remote sign-in after provider setup'
		}
	},
	run: async ({ args }) => {
		await completeSetup({
			provider: args.provider ? String(args.provider) : undefined,
			method: args.method ? String(args.method) : undefined,
			claudeRemote: args['claude-remote'] === true,
			codexRemote: args['codex-remote'] === true
		});
	}
});
