import { render, refresh } from './snapshot.js';
import { state } from './state.js';
import { byId, notice, operation, setFormClean, setOptions } from './ui.js';
import { offerRestart } from './restart.js';
import { instanceCapability } from './instance-presentation.js';

export function deploymentOutcomeNotice(outcome) {
	if (!outcome) return;
	const detail = [
		outcome.message || outcome.step,
		outcome.reference ? `Reference: ${outcome.reference}` : ''
	]
		.filter(Boolean)
		.join(' ');
	notice(
		`${outcome.state}: ${detail}`,
		outcome.state === 'completed' ? 'success' : outcome.state === 'failed' ? 'error' : 'progress',
		{ persist: outcome.state !== 'completed' }
	);
}

export async function loadDeploymentSettings() {
	if (!instanceCapability('host.deployment.inspect').supported) return;
	const settings = await operation(
		'Reading deployment settings',
		() => state.api.deploymentSettings(),
		'Current deployment settings loaded.'
	);
	if (!settings) return;
	state.deploymentSettings = settings;
	setOptions(
		byId('deployment-container'),
		settings.containers.map((item) => ({
			value: item.name,
			label: `${item.name} · ${item.image}`
		})),
		settings.pending?.container
	);
	byId('deployment-availability').value = settings.pending?.availability || '';
	const availabilityReason =
		settings.unavailable?.availability ||
		(!settings.availability ? 'Availability controls are not available for this instance.' : '');
	byId('deployment-availability').disabled = Boolean(availabilityReason);
	byId('deployment-availability-help').textContent = availabilityReason;
	byId('deployment-image').value = settings.pending?.image || '';
	byId('deployment-image-help').textContent =
		settings.imageHelp || 'Use a full image reference. Unrelated containers are unchanged.';
	byId('deployment-timezone').value = settings.pending?.environment?.FH_TIMEZONE || '';
	byId('deployment-timezone').disabled = Boolean(settings.unavailable?.FH_TIMEZONE);
	byId('deployment-timezone-help').textContent = settings.unavailable?.FH_TIMEZONE || '';
	for (const [field, name] of [
		['schedule', 'FH_SCHEDULER_ENABLED'],
		['claude', 'FH_CLAUDE_REMOTE'],
		['codex', 'FH_CODEX_REMOTE']
	]) {
		byId(`deployment-${field}`).value = settings.pending?.environment?.[name] ?? '';
		byId(`deployment-${field}`).disabled = Boolean(settings.unavailable?.[name]);
		byId(`deployment-${field}-current`).textContent =
			settings.unavailable?.[name] ||
			(settings.environment[name] === undefined
				? 'Current value not reported'
				: `Saved: ${settings.environment[name] === '1' ? 'enabled' : 'disabled'}`);
	}
	byId('deployment-current').textContent =
		`${settings.availability ? `Saved availability: ${settings.availability === 'always' ? 'Always running' : 'On demand'}. ` : ''}${settings.environment.FH_TIMEZONE ? `Timezone: ${settings.environment.FH_TIMEZONE}. ` : ''}Only the fields you choose below will change.`;
	byId('discard-deployment').disabled =
		!settings.pending || !instanceCapability('host.deployment.discard').supported;
	byId('deployment-edit-form').hidden = false;
	if (settings.operation) deploymentOutcomeNotice(settings.operation);
}

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
	byId('load-deployment-settings').addEventListener('click', () => void loadDeploymentSettings());
	byId('deployment-edit-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (
			state.operationInFlight ||
			!state.deploymentSettings ||
			!instanceCapability('host.deployment.prepare').supported
		)
			return;
		const patch = {};
		if (!byId('deployment-availability').disabled && byId('deployment-availability').value)
			patch.availability = byId('deployment-availability').value;
		if (byId('deployment-image').value.trim()) {
			patch.image = byId('deployment-image').value.trim();
			patch.container = byId('deployment-container').value;
		}
		const environment = {};
		if (!byId('deployment-timezone').disabled && byId('deployment-timezone').value.trim())
			environment.FH_TIMEZONE = byId('deployment-timezone').value.trim();
		for (const [field, name] of [
			['schedule', 'FH_SCHEDULER_ENABLED'],
			['claude', 'FH_CLAUDE_REMOTE'],
			['codex', 'FH_CODEX_REMOTE']
		]) {
			if (!byId(`deployment-${field}`).disabled && byId(`deployment-${field}`).value !== '')
				environment[name] = byId(`deployment-${field}`).value;
		}
		if (Object.keys(environment).length) patch.environment = environment;
		if (!Object.keys(patch).length) return notice('Choose at least one change.');
		const saved = await operation(
			'Saving pending deployment changes',
			() => state.api.prepareDeployment(patch),
			'Changes saved locally for this target. The running deployment has not changed.'
		);
		if (!saved) return;
		state.deploymentSettings = saved;
		byId('discard-deployment').disabled =
			!saved.pending || !instanceCapability('host.deployment.discard').supported;
		setFormClean('deployment-edit-form');
		await refresh();
		await offerRestart();
	});
	byId('discard-deployment').addEventListener('click', async () => {
		if (state.operationInFlight || !instanceCapability('host.deployment.discard').supported) return;
		if (
			!window.confirm(
				'Discard this deployment draft? This does not undo changes already saved to the instance or change running resources. If an earlier apply stopped the instance, use Start to bring it back online.'
			)
		)
			return;
		await operation(
			'Discarding pending changes',
			async () => {
				await state.api.discardDeployment();
				state.deploymentSettings = null;
				byId('deployment-edit-form').hidden = true;
				await refresh();
			},
			'Pending changes discarded. Deployment resources are unchanged.'
		);
	});
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
