import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import type { ComposedInstanceSession, HostingLogOptions, Operation } from '@fhold/lib';
import { runSessionProviderCommand } from './session-provider-command.js';

async function invoke<I, O>(operation: Operation<I, O>, input: I, confirmed = false): Promise<O> {
	if (operation.support !== 'supported') throw new Error(operation.reason);
	const availability = operation.availability();
	if (availability.state !== 'ready') throw new Error(availability.reason);
	return operation.invoke(input, { confirmed });
}

/** Shared remote verbs. The adapter, not the CLI, supplies their implementation. */
export async function runSessionCommand(
	session: ComposedInstanceSession,
	argv: string[],
	write: (text: string) => void = console.log
): Promise<void> {
	const action = argv[0] || 'status';
	if (action === 'provider') return runSessionProviderCommand(session, argv.slice(1), write);
	const options: ParseArgsOptionsConfig =
		action === 'logs' || action === 'console'
			? {
					tail: { type: 'string' as const },
					type: { type: 'string' as const },
					revision: { type: 'string' as const },
					replica: { type: 'string' as const },
					container: { type: 'string' as const }
				}
			: action === 'status'
				? {}
				: action === 'connect'
					? { json: { type: 'boolean' as const } }
					: { confirm: { type: 'boolean' as const }, revision: { type: 'string' as const } };
	const parsed = parseArgs({ args: argv.slice(1), options, allowPositionals: true, strict: true });
	const values = parsed.values;
	if (action !== 'connect' && parsed.positionals.length)
		throw new Error(`Unexpected argument for ${action}.`);
	if (action === 'status') write(JSON.stringify(await session.inspect(), null, 2));
	else if (action === 'logs' || action === 'console') {
		const value: HostingLogOptions = {};
		for (const key of ['revision', 'replica', 'container'] as const)
			if (typeof values[key] === 'string') value[key] = values[key];
		if (action === 'console') {
			if (values.tail !== undefined || values.type !== undefined)
				throw new Error(
					'Console accepts revision, replica and container selection, not log options.'
				);
			if (!session.host.console)
				throw new Error(
					'This provider does not expose an interactive console. Use its native host terminal.'
				);
			await invoke(session.host.console, value);
		} else {
			if (values.tail !== undefined) {
				if (typeof values.tail !== 'string' || !/^\d+$/.test(values.tail))
					throw new Error('Log tail must be a non-negative integer.');
				value.tail = Number(values.tail);
			}
			if (values.type !== undefined) {
				if (!['system', 'console'].includes(String(values.type)))
					throw new Error('Choose system or console logs.');
				value.type = values.type as 'system' | 'console';
			}
			write(await invoke(session.host.logs, value));
		}
	} else if (action === 'connect') {
		if (
			parsed.positionals.length > 1 ||
			(parsed.positionals[0] && parsed.positionals[0] !== 'opencode')
		)
			throw new Error(
				'This provider exposes the native OpenCode connection. Use connect opencode.'
			);
		const snapshot = await session.inspect();
		const deployment =
			snapshot.deployment.state === 'known' ? snapshot.deployment.value : undefined;
		if (!deployment?.clientUrl)
			throw new Error(
				'No reachable OpenCode ingress is configured. Check this app in the hosting provider.'
			);
		const result = {
			url: deployment.clientUrl,
			note: 'Opening this address may wake the agent. Use its existing native authentication.'
		};
		write(values.json ? JSON.stringify(result, null, 2) : `${result.url}\n${result.note}`);
	} else if (['start', 'stop', 'restart'].includes(action)) {
		if (!values.confirm)
			throw new Error(
				'This changes remote containers and can interrupt work. Repeat with --confirm when ready.'
			);
		if (values.revision !== undefined && typeof values.revision !== 'string')
			throw new Error('Revision must be a revision name.');
		if (values.revision !== undefined && action !== 'restart')
			throw new Error('Revision selection is available only for restart.');
		const actionOptions =
			typeof values.revision === 'string' ? { revision: values.revision } : undefined;
		const result =
			action === 'restart'
				? await invoke(session.host.restart, actionOptions, true)
				: await invoke(session.host[action as 'start' | 'stop'], undefined, true);
		write(JSON.stringify(result, null, 2));
	} else
		throw new Error(
			`This provider does not expose ${action}. Use the instance's native interface or deployment tooling. No local instance was changed.`
		);
}
