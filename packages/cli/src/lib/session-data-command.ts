import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { invokeOperation, type ComposedInstanceSession } from '@fhold/lib';

/** Archive paths belong to the caller; the data adapter owns any remote transfer. */
export async function runSessionDataCommand(
	session: ComposedInstanceSession,
	argv: string[],
	write: (text: string) => void
): Promise<void> {
	const action = argv[0];
	if (action !== 'backup' && action !== 'restore') throw new Error('Choose backup or restore.');
	const aliases: Record<string, string> = {
		confirmStopped: 'confirm-stopped',
		includeProviderAuth: 'include-provider-auth',
		includeUserEnv: 'include-user-env',
		includePortalMaps: 'include-portal-maps',
		includeOAuth: 'include-oauth',
		acknowledgeUnrestored: 'acknowledge-unrestored',
		dryRun: 'dry-run'
	};
	const options: ParseArgsOptionsConfig = {
		...(action === 'backup'
			? { to: { type: 'string' as const } }
			: {
					from: { type: 'string' as const },
					apply: { type: 'boolean' as const },
					'dry-run': { type: 'boolean' as const },
					'acknowledge-unrestored': { type: 'boolean' as const }
				}),
		full: { type: 'boolean' },
		json: { type: 'boolean' },
		'confirm-stopped': { type: 'boolean' },
		'include-provider-auth': { type: 'boolean' },
		'include-user-env': { type: 'boolean' },
		'include-portal-maps': { type: 'boolean' },
		'include-oauth': { type: 'boolean' }
	};
	const { values, positionals } = parseArgs({
		args: argv
			.slice(1)
			.map((value) =>
				value.replace(/^--([^=]+)/, (flag, name: string) =>
					aliases[name] ? `--${aliases[name]}` : flag
				)
			),
		strict: true,
		allowPositionals: true,
		options
	});
	if (positionals.length) throw new Error(`Unexpected argument for ${action}.`);
	if (values.apply && values['dry-run']) throw new Error('Choose either --apply or --dry-run.');
	const context = { confirmed: values['confirm-stopped'] === true };
	const included = {
		includeProviderAuth: values['include-provider-auth'] === true,
		includeUserEnv: values['include-user-env'] === true,
		includePortalMaps: values['include-portal-maps'] === true,
		includeOAuth: values['include-oauth'] === true
	};
	await session.inspect();
	if (action === 'backup') {
		if (typeof values.to !== 'string' || !values.to)
			throw new Error('Choose a local export directory with --to.');
		write(
			JSON.stringify(
				await invokeOperation(
					session.data.backup,
					{
						destination: values.to,
						full: values.full === true,
						...included
					},
					context
				),
				null,
				2
			)
		);
		return;
	}
	if (typeof values.from !== 'string' || !values.from)
		throw new Error('Choose a local export directory with --from.');
	const input = {
		sourceHome: values.from,
		...included,
		acknowledgeUnrestored: values['acknowledge-unrestored'] === true
	};
	// Keep each concrete operation's precise result type while sharing the preview/apply flow.
	if (values.full) {
		const preview = await invokeOperation(session.data.restoreInstance, input, context);
		write(
			JSON.stringify(
				values.apply
					? await invokeOperation(
							session.data.restoreInstance,
							{
								...input,
								apply: true,
								previewDigest: preview.digest
							},
							context
						)
					: preview,
				null,
				2
			)
		);
	} else {
		const preview = await invokeOperation(session.data.restoreData, input, context);
		write(
			JSON.stringify(
				values.apply
					? await invokeOperation(
							session.data.restoreData,
							{
								...input,
								apply: true,
								previewDigest: preview.digest
							},
							context
						)
					: preview,
				null,
				2
			)
		);
	}
}
