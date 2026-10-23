import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { invokeOperation as invoke, type ComposedInstanceSession } from '@fhold/lib';
function privateInput(path: string): string {
	const value = readFileSync(path === '-' ? 0 : path, 'utf8').replace(/[\r\n]+$/, '');
	if (!value || /[\r\n]/.test(value))
		throw new Error('Credential input must contain one nonempty line.');
	return value;
}

/** HTTP-native account operations; host credentials and native passwords remain separate. */
export async function runSessionProviderCommand(
	session: ComposedInstanceSession,
	argv: string[],
	write: (text: string) => void,
	readCode: () => Promise<string> = async () => {
		if (!process.stdin.isTTY)
			throw new Error('Complete code-based sign-in in an interactive terminal or Admin.');
		const terminal = createInterface({ input: process.stdin, output: process.stdout });
		try {
			return await terminal.question('Paste the complete native sign-in code: ');
		} finally {
			terminal.close();
		}
	}
): Promise<void> {
	const command = argv[0] ?? 'list';
	if (!['list', 'key', 'logout', 'login', 'test'].includes(command))
		throw new Error('Use provider list, key, logout, login or test.');
	const { values, positionals } = parseArgs({
		args: argv.slice(1),
		allowPositionals: true,
		strict: true,
		options: {
			'password-file': { type: 'string' },
			...(command === 'key' ? { 'key-file': { type: 'string' as const } } : {}),
			...(command === 'login' ? { method: { type: 'string' as const } } : {}),
			...(command === 'test' ? { model: { type: 'string' as const } } : {}),
			json: { type: 'boolean' }
		}
	});
	const provider = positionals[0];
	const passwordFile =
		typeof values['password-file'] === 'string' ? values['password-file'] : undefined;
	const keyFile = typeof values['key-file'] === 'string' ? values['key-file'] : undefined;
	const method = typeof values.method === 'string' ? values.method : undefined;
	const model = typeof values.model === 'string' ? values.model : undefined;
	if (positionals.length > 1 || (command === 'list' && provider))
		throw new Error('Unexpected provider arguments.');
	if (['key', 'logout', 'login'].includes(command) && !provider)
		throw new Error('Choose a provider ID.');
	if (command === 'test' && model && !provider)
		throw new Error('Choose a provider for this model test.');
	if (command === 'key' && !keyFile) throw new Error('Read the key with --key-file <path|->.');
	if (passwordFile === '-' && keyFile === '-')
		throw new Error('Password and API key cannot both consume stdin. Use a private file for one.');
	if (method !== undefined && !/^\d+$/.test(method))
		throw new Error('Choose the numeric sign-in method index from provider list.');
	const connect = session.agent.connect;
	if (connect?.support === 'supported' && connect.input?.requiresPassword && !passwordFile)
		throw new Error(
			'This connection needs the native OpenCode password. Use --password-file <private-file|->. It is used only in this session, not saved in host connections.'
		);
	await invoke(session.agent.connect, passwordFile ? { password: privateInput(passwordFile) } : {});
	if (command === 'list') {
		write(JSON.stringify(await invoke(session.agent.providers, undefined), null, 2));
	} else if (command === 'key') {
		if (!provider || !keyFile) throw new Error('Choose a provider and key file.');
		await invoke(session.agent.setKey, { provider, key: privateInput(keyFile) });
		write(
			'Provider credential saved through the native agent. Run provider test to verify a model.'
		);
	} else if (command === 'logout') {
		if (!provider) throw new Error('Choose a provider.');
		await invoke(session.agent.removeProvider, { provider });
		write(`Removed the saved ${provider} credential.`);
	} else if (command === 'test') {
		const result = await invoke(session.agent.readiness, {
			...(provider ? { provider } : {}),
			...(model ? { model } : {})
		});
		write(JSON.stringify(result, null, 2));
		if (!result.ok) throw new Error(`Provider readiness failed: ${result.error}`);
	} else {
		if (!provider) throw new Error('Choose a provider.');
		const inventory = await invoke(session.agent.providers, undefined);
		const methods =
			inventory.providers
				.find((item) => item.id === provider)
				?.authMethods.filter((method) => method.type === 'oauth') ?? [];
		const selected =
			method === undefined && methods.length === 1
				? methods[0]
				: methods.find((item) => item.index === Number(method));
		if (!selected)
			throw new Error(
				'Choose an OAuth method with --method <index> from provider list. API keys use provider key.'
			);
		if (selected.prompts?.length)
			throw new Error(
				'This provider requires additional native sign-in fields. Complete sign-in in Admin or OpenCode.'
			);
		const authorization = await invoke(session.agent.oauthStart, {
			provider,
			method: selected.index
		});
		write(`${authorization.url}\n${authorization.instructions}`);
		const code = authorization.method === 'code' ? await readCode() : undefined;
		await invoke(session.agent.oauthFinish, {
			provider,
			method: selected.index,
			...(code ? { code } : {})
		});
		write('Native provider sign-in completed. Run provider test to verify a model.');
	}
}
