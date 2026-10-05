import { render } from './snapshot.js';
import { state } from './state.js';
import { byId, notice, operation, setFormClean } from './ui.js';
import { offerRestart } from './restart.js';

export async function saveConfigAndOfferRestart(config, formId, progress, success) {
	const saved = await operation(
		progress,
		async () => {
			const saved = await state.api.saveConfig({ config, baseConfig: state.currentConfig });
			setFormClean(formId);
			render(saved);
			return saved;
		},
		success
	);
	if (saved) await offerRestart(saved);
	return saved;
}

export function bindConfigurationEvents() {
	for (const app of ['opencode', 'mcp']) {
		const section = app === 'opencode' ? 'assistant' : 'gateway';
		byId(`${app}-network-form`).addEventListener('submit', async (event) => {
			event.preventDefault();
			if (state.operationInFlight || !state.currentConfig) return;
			const bindAddress = byId(`${section}-bind`).value.trim();
			const port = Number(byId(`${section}-port`).value);
			const otherPort = state.currentConfig[app === 'opencode' ? 'gateway' : 'assistant'].port;
			if (port === otherPort) {
				notice('OpenCode and MCP must use different ports.', 'error', { persist: true });
				byId(`${section}-port`).focus();
				return;
			}
			const loopback = bindAddress === '::1' || bindAddress.startsWith('127.');
			if (
				app === 'opencode' &&
				!loopback &&
				!window.confirm(
					'Direct OpenCode access bypasses Guardian. Continue only on a trusted network with TLS.'
				)
			)
				return;
			const config = structuredClone(state.currentConfig);
			config[section] = { ...config[section], bindAddress, port };
			const title = app === 'opencode' ? 'OpenCode' : 'MCP';
			await saveConfigAndOfferRestart(
				config,
				`${app}-network-form`,
				`Saving ${title} network settings`,
				`${title} network settings saved.`
			);
		});
	}
}
