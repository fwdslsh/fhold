import { runHostingProcess, type HostingProcess } from './process.js';
import type { ConnectionSetup, HostingChoice } from './types.js';

/** Native Azure authentication and per-command scope; never change the global account. */
export function azureClient(run: HostingProcess = runHostingProcess) {
	const environment = { AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no' };
	async function text(args: string[], timeoutMs = 45_000): Promise<string> {
		return run('az', [...args, '--only-show-errors'], { timeoutMs, env: environment });
	}
	async function json(args: string[]): Promise<unknown> {
		const output = await text([...args, '--output', 'json']);
		try {
			return output.trim() ? JSON.parse(output) : undefined;
		} catch {
			throw new Error('Azure CLI returned invalid JSON. Update the CLI and check this connection.');
		}
	}
	function choices(value: unknown): HostingChoice[] {
		if (!Array.isArray(value)) throw new Error('Azure did not return a list of available choices.');
		return value.map((item: unknown) => {
			if (
				!item ||
				typeof item !== 'object' ||
				!('value' in item) ||
				typeof item.value !== 'string' ||
				!('label' in item) ||
				typeof item.label !== 'string'
			)
				throw new Error('Azure returned an invalid subscription or resource group.');
			return { value: item.value, label: item.label };
		});
	}
	const setup: ConnectionSetup = {
		async signIn() {
			// az opens the browser and owns the complete vendor flow and token cache.
			await text(['login', '--output', 'none'], 180_000);
		},
		async choices(field, values = {}) {
			if (field === 'subscriptionId')
				return choices(
					await json(['account', 'list', '--query', "[?state=='Enabled'].{value:id,label:name}"])
				);
			if (field !== 'resourceGroup') throw new Error('Unknown Azure connection field.');
			const subscriptionId = values.subscriptionId ?? '';
			if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(subscriptionId))
				throw new Error('Choose a subscription before listing resource groups.');
			return choices(
				await json([
					'group',
					'list',
					'--subscription',
					subscriptionId,
					'--query',
					'[].{value:name,label:name}'
				])
			);
		}
	};
	return { text, json, setup };
}
