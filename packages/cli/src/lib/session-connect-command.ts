import { parseArgs } from 'node:util';
import {
	invokeOperation,
	type AppConnection,
	type ComposedInstanceSession,
	type InstanceSnapshot
} from '@fhold/lib';

function links(snapshot: InstanceSnapshot) {
	return snapshot.apps.connections.state === 'known' ? snapshot.apps.connections.value : undefined;
}

async function waitForDisconnect(): Promise<void> {
	await new Promise<void>((resolve) => {
		const stop = () => {
			process.removeListener('SIGINT', stop);
			process.removeListener('SIGTERM', stop);
			resolve();
		};
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
	});
}

/** Explicitly acquire a session route only when the adapter needs one. */
export async function runSessionConnectCommand(
	session: ComposedInstanceSession,
	argv: string[],
	write: (text: string) => void,
	wait: () => Promise<void> = waitForDisconnect
): Promise<void> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: {
			json: { type: 'boolean' },
			'show-password': { type: 'boolean' },
			'show-key': { type: 'boolean' },
			showKey: { type: 'boolean' },
			credential: { type: 'string' }
		}
	});
	if (
		positionals.length > 1 ||
		(positionals[0] && !['opencode', 'mcp', 'claude'].includes(positionals[0]))
	)
		throw new Error('Client must be opencode, mcp or claude.');
	let snapshot = await session.inspect();
	const existing = links(snapshot);
	const chosen = positionals[0] ?? (existing?.mcp ? 'mcp' : 'opencode');
	const client = chosen === 'mcp' || chosen === 'claude' ? chosen : 'opencode';
	const publicLink = existing?.[client];
	const deployment = snapshot.deployment.state === 'known' ? snapshot.deployment.value : undefined;
	const publicUrl = publicLink?.url ?? (client === 'opencode' ? deployment?.clientUrl : undefined);
	let sessionBound = false;
	let acquiredAccess: { endpoint: string; username?: string } | undefined;
	// A public URL is useful without signing into its native management API.
	// Printing it must not wake an idle instance or acquire private credentials.
	if (!publicUrl) {
		const acquired = await invokeOperation(session.agent.connect, {});
		acquiredAccess = acquired;
		sessionBound = acquired.sessionBound === true;
		snapshot = await session.inspect();
	}
	const observed = links(snapshot);
	const detail = observed?.[client];
	const url =
		detail?.url ?? publicUrl ?? (client === 'opencode' ? acquiredAccess?.endpoint : undefined);
	if (!url)
		throw new Error(
			observed?.error || 'Start this instance and enable the selected app before connecting.'
		);
	const output: AppConnection & { password?: string; credentialKey?: string } = {
		...(detail ?? publicLink),
		url,
		note: sessionBound
			? 'Keep this command running while using the connection; Ctrl+C disconnects only this session, not the agent.'
			: detail?.note ||
				'Opening this address may wake the agent. Use its existing native authentication.'
	};
	if (!output.username && client === 'opencode' && acquiredAccess?.username)
		output.username = acquiredAccess.username;
	if (values.credential && client !== 'opencode') output.credential = values.credential;
	if (values['show-password'] && client === 'opencode')
		output.password = (await invokeOperation(session.agent.assistantPassword, undefined)).password;
	if (values['show-key'] || values.showKey)
		output.credentialKey = (
			await invokeOperation(session.apps.credentials.revealKey, {
				username: values.credential ?? 'owner'
			})
		).key;
	if (values.json) write(JSON.stringify(output, null, 2));
	else {
		write(`${client}: ${output.url}`);
		if (output.username) write(`Username: ${output.username}`);
		if (output.password) write(`Password: ${output.password}`);
		else if (client === 'opencode') write('Add --show-password to reveal the OpenCode password.');
		if (output.credentialKey) write(`Credential key: ${output.credentialKey}`);
		write(output.note);
	}
	if (sessionBound) await wait();
}
