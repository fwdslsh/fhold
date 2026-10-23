// Provider-neutral projection for the fixed Admin screens. The normalized
// snapshot describes what is known and which named operation owns an action;
// renderer code never infers support from a provider kind or a local config.
import { state } from './state.js';
import { known } from './model.js';
import { all, byId, setBadge, setOptions, setText } from './ui.js';

function observationReason(observation, fallback) {
	return observation?.reason || fallback;
}

export function instancePresentation(snapshot) {
	const deployment = known(snapshot.deployment) || {};
	return {
		name: snapshot.identity?.name || 'Your assistant',
		location: deployment.providerLabel || snapshot.identity?.location || 'Connected instance',
		path: snapshot.docker?.homeDir || snapshot.identity?.location || 'Not reported',
		docker: snapshot.docker,
		deployment,
		services: known(snapshot.services) || [],
		serviceReason: observationReason(snapshot.services, 'Service status has not been inspected.')
	};
}

export function instanceCapability(operationKey, snapshot = state.currentSnapshot) {
	if (!snapshot) return { supported: false, reason: 'Open an instance first.' };
	const operation = snapshot.operations?.[operationKey];
	if (!operation)
		return { supported: false, reason: 'This operation is not available for this instance.' };
	if (operation.support !== 'supported') return { supported: false, reason: operation.reason };
	if (operation.availability.state !== 'ready')
		return { supported: false, reason: operation.availability.reason };
	return { supported: true };
}

export function renderInstanceCapabilities(snapshot) {
	for (const fields of all('[data-instance-feature]')) {
		const capability = instanceCapability(fields.dataset.instanceFeature, snapshot);
		fields.disabled = !capability.supported;
		fields.setAttribute('aria-disabled', String(!capability.supported));
		for (const link of fields.querySelectorAll('a')) {
			link.inert = !capability.supported;
			link.setAttribute('aria-disabled', String(!capability.supported));
		}
		const note = byId(`${fields.id}-unavailable`);
		note.hidden = capability.supported;
		note.textContent = capability.supported
			? ''
			: `Unavailable for this instance. ${capability.reason || 'Review its connection and deployment settings.'}`;
	}
}

export function renderInstanceDetails(snapshot) {
	const view = instancePresentation(snapshot);
	setText('overview-home', view.path);
	setText('home', view.path);
	setText('instance-name', view.name);
	setText('config-path', view.docker?.configPath || 'Not managed through this connection');
	const deployment = view.deployment;
	const portal = byId('deployment-portal');
	portal.hidden = !deployment.portalUrl;
	portal.href = deployment.portalUrl || 'about:blank';
	setText(
		'deployment-revisions',
		(deployment.revisions || [])
			.map(
				(item) =>
					`${item.name}: ${item.active ? 'active' : 'inactive'}, ${item.replicas ?? 'unknown'} replica(s), ${item.health}`
			)
			.join('\n')
	);
	byId('deployment-revisions').hidden = !deployment.revisions?.length;
	for (const [id, choices, placeholder] of [
		[
			'log-revision',
			(deployment.revisions || []).map((item) => ({ value: item.name, label: item.name })),
			'Current'
		],
		[
			'log-container',
			(deployment.containers || []).map((item) => ({ value: item.name, label: item.name })),
			'All services'
		]
	]) {
		const select = byId(id);
		const selected = select.value;
		setOptions(select, [{ value: '', label: placeholder }, ...choices], selected);
		select.disabled = choices.length === 0;
	}
	const sources = deployment.logSources || [];
	const source = byId('log-source');
	setOptions(
		source,
		sources.length
			? sources.map((item) => ({ value: item.type, label: item.label }))
			: [{ value: '', label: 'Service output' }],
		source.value
	);
	source.disabled = sources.length === 0;
	setText(
		'log-help',
		sources.length
			? 'Platform logs do not need a running agent. Console logs may be unavailable while the instance is idle.'
			: 'Recent output from this instance’s services. Revision and container filters are not provided by this connection.'
	);
}

export function selectedLogOptions() {
	const options = {};
	for (const [key, id] of [
		['type', 'log-source'],
		['revision', 'log-revision'],
		['container', 'log-container']
	]) {
		const field = byId(id);
		if (!field.disabled && field.value) options[key] = field.value;
	}
	return Object.keys(options).length ? options : undefined;
}

export function renderPlatformAccess(snapshot) {
	const deployment = instancePresentation(snapshot).deployment;
	const access = known(snapshot.agent?.access);
	for (const id of ['overview-opencode-link', 'direct-url', 'assistant-url-detail']) {
		const link = byId(id);
		link.hidden = !deployment.clientUrl;
		link.href = deployment.clientUrl || 'about:blank';
		if (id === 'direct-url') link.textContent = deployment.clientUrl || 'Not reported';
	}
	setText(
		'opencode-connection-help',
		deployment.guidance?.client || 'Connect explicitly before managing native agent settings.'
	);
	setText('direct-username', access?.username || 'Not reported');
	for (const id of [
		'mcp-connection-status',
		'discord-connection-status',
		'slack-connection-status',
		'discord-token-status',
		'slack-token-status',
		'claude-remote-status',
		'codex-remote-status',
		'codex-recall-status'
	])
		setBadge(byId(id), 'Not inspected');
	setBadge(
		byId('opencode-connection-status'),
		deployment.clientUrl ? 'Address available' : 'Address not reported'
	);
	if (!state.providersLoaded) {
		setText('provider-default-service', 'Not inspected');
		setText('provider-default-model', 'Not available');
		setText('provider-default-status', 'Connect to inspect native agent settings.');
		setText('provider-saved-empty', 'Connect to inspect saved provider setups.');
		byId('provider-saved-list').replaceChildren();
	}
	for (const id of [
		'claude-guardian-help',
		'mcp-guardian-help',
		'claude-policy-help',
		'mcp-policy-help',
		'discord-policy-help',
		'slack-policy-help',
		'codex-recall-guidance'
	])
		setText(id, 'Not inspected through this connection.');
	for (const id of ['saved-access', 'discord-mappings', 'slack-mappings'])
		byId(id).replaceChildren();
	byId('runtime-recovery-status').replaceChildren();
	byId('runtime-recovery-status').className = 'inline-status neutral';
	setText('runtime-recovery-status', 'Checkpoint configuration has not been inspected.');
}
