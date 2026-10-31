import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { invokeOperation, type ComposedInstanceSession, type HostingLogOptions } from '@fhold/lib';
import { runSessionProviderCommand } from './session-provider-command.js';
import { runSessionDataCommand } from './session-data-command.js';
import { runSessionConnectCommand } from './session-connect-command.js';
import { completeHostedSetup } from '../commands/setup.js';

/** Shared remote verbs. The adapter, not the CLI, supplies their implementation. */
export async function runSessionCommand(
	session: ComposedInstanceSession,
	argv: string[],
	write: (text: string) => void = console.log
): Promise<void> {
	const action = argv[0] || 'status';
	if (action === 'setup') return completeHostedSetup(session, argv.slice(1), write);
	if (action === 'provider') return runSessionProviderCommand(session, argv.slice(1), write);
	if (action === 'backup' || action === 'restore')
		return runSessionDataCommand(session, argv, write);
	if (action === 'connect') return runSessionConnectCommand(session, argv.slice(1), write);
	const options: ParseArgsOptionsConfig =
		action === 'update'
			? {
					confirm: { type: 'boolean' as const },
					resume: { type: 'boolean' as const },
					pull: { type: 'boolean' as const },
					container: { type: 'string' as const },
					image: { type: 'string' as const }
				}
			: action === 'logs' || action === 'console'
				? {
						tail: { type: 'string' as const },
						type: { type: 'string' as const },
						revision: { type: 'string' as const },
						replica: { type: 'string' as const },
						container: { type: 'string' as const }
					}
				: action === 'status'
					? {}
					: { confirm: { type: 'boolean' as const }, revision: { type: 'string' as const } };
	const parsed = parseArgs({ args: argv.slice(1), options, allowPositionals: true, strict: true });
	const values = parsed.values;
	if (parsed.positionals.length) throw new Error(`Unexpected argument for ${action}.`);
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
			await invokeOperation(session.host.console, value);
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
			write(await invokeOperation(session.host.logs, value));
		}
	} else if (action === 'update') {
		if (!values.confirm)
			throw new Error('Deployment changes can interrupt work. Repeat with --confirm when ready.');
		if (values.resume) {
			if (values.pull !== undefined || values.container !== undefined || values.image !== undefined)
				throw new Error(
					'--resume continues saved changes and cannot be combined with --pull, --container or --image.'
				);
			const settings = await invokeOperation(session.host.deployment.inspect, undefined);
			if (!settings.pending) throw new Error('There are no saved deployment changes to resume.');
			const outcome = await invokeOperation(session.host.deployment.apply, undefined, {
				confirmed: true
			});
			write(JSON.stringify(outcome, null, 2));
			return;
		}
		const input = {
			...(typeof values.pull === 'boolean' ? { pull: values.pull } : {}),
			...(typeof values.container === 'string' ? { container: values.container } : {}),
			...(typeof values.image === 'string' ? { image: values.image } : {})
		};
		const outcome = await invokeOperation(session.host.deployment.update, input, {
			confirmed: true
		});
		write(JSON.stringify(outcome, null, 2));
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
				? await invokeOperation(session.host.restart, actionOptions, { confirmed: true })
				: await invokeOperation(session.host[action as 'start' | 'stop'], undefined, {
						confirmed: true
					});
		write(JSON.stringify(result, null, 2));
	} else
		throw new Error(
			`This provider does not expose ${action}. Use the instance's native interface or deployment tooling. No local instance was changed.`
		);
}
