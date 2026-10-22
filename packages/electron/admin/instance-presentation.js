// One presentation contract for every instance. Hosting adapters own support;
// screens consume capabilities, never provider names or a fabricated StackConfig.
import { state } from './state.js';
import { all, byId, setBadge, setOptions, setText } from './ui.js';

export function instancePresentation(snapshot) {
	const platform = snapshot.phase === 'remote' ? snapshot.hosting : undefined;
	const supported = { supported: true };
	return {
		name: platform?.name || snapshot.config?.deployment?.projectName || 'Your assistant',
		location:
			platform?.providerLabel ||
			snapshot.connectionLabel ||
			(platform ? 'Connected host' : 'This computer'),
		path: platform?.location || snapshot.homeDir,
		managed: !platform,
		platform,
		services: platform?.services || snapshot.services || [],
		capabilities: platform?.capabilities || {
			start: supported,
			restart: supported,
			stop: supported,
			settings: supported,
			transfer: supported
		}
	};
}

export function instanceCapability(name, snapshot = state.currentSnapshot) {
	if (!snapshot) return { supported: false, reason: 'Open an instance first.' };
	const view = instancePresentation(snapshot);
	// Image updates require the full management facade, not merely a settings
	// capability. A platform lifecycle API cannot apply a Docker image cohort.
	if (name === 'update')
		return view.managed
			? { supported: true }
			: {
					supported: false,
					reason: 'Use your deployment tools to change this instance’s image.'
				};
	const capability = view.capabilities[name];
	return capability?.supported
		? capability
		: {
				supported: false,
				reason: capability?.reason || 'Unavailable through this connection.'
			};
}

export function renderInstanceCapabilities(snapshot) {
	for (const fields of all('[data-instance-feature]')) {
		const capability = instanceCapability(fields.dataset.instanceFeature, snapshot);
		fields.disabled = !capability.supported;
		fields.setAttribute('aria-disabled', String(!capability.supported));
		// Fieldsets natively disable form controls, not links. Keep an unavailable
		// section's links visible but non-interactive as well.
		for (const link of fields.querySelectorAll('a')) {
			link.inert = !capability.supported;
			link.setAttribute('aria-disabled', String(!capability.supported));
		}
		const note = byId(`${fields.id}-unavailable`);
		note.hidden = capability.supported;
		note.textContent = capability.supported
			? ''
			: `Unavailable through this connection. ${capability.reason || 'Use your deployment tools to manage this setting.'}`;
	}
}

export function renderInstanceDetails(snapshot) {
	const view = instancePresentation(snapshot);
	setText('overview-home', view.path);
	setText('home', view.path);
	setText('instance-name', view.name);
	setText('config-path', snapshot.configPath || 'Not available through this connection');
	const platform = view.platform;
	const portal = byId('deployment-portal');
	portal.hidden = !platform?.portalUrl;
	portal.href = platform?.portalUrl || 'about:blank';
	setText(
		'deployment-revisions',
		(platform?.revisions || [])
			.map(
				(item) =>
					`${item.name}: ${item.active ? 'active' : 'inactive'}, ${item.replicas ?? 'unknown'} replica(s), ${item.health}`
			)
			.join('\n')
	);
	byId('deployment-revisions').hidden = !platform?.revisions?.length;
	for (const [id, choices, placeholder] of [
		[
			'log-revision',
			(platform?.revisions || []).map((item) => ({ value: item.name, label: item.name })),
			'Current'
		],
		[
			'log-container',
			(platform?.containers || []).map((item) => ({ value: item.name, label: item.name })),
			'All services'
		]
	]) {
		const select = byId(id);
		const selected = select.value;
		setOptions(select, [{ value: '', label: placeholder }, ...choices], selected);
		select.disabled = choices.length === 0;
	}
	const sources = platform?.logSources || [];
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
	const platform = instancePresentation(snapshot).platform;
	if (!platform) return;
	for (const id of ['overview-opencode-link', 'direct-url', 'assistant-url-detail']) {
		const link = byId(id);
		link.hidden = !platform.clientUrl;
		link.href = platform.clientUrl || 'about:blank';
		if (id === 'direct-url') link.textContent = platform.clientUrl || 'Not reported';
	}
	setText(
		'opencode-connection-help',
		platform.guidance?.client || 'Use the authentication configured for this instance.'
	);
	setText('direct-username', 'Not available through this connection');
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
		platform.clientUrl ? 'Address available' : 'Address not reported'
	);
	setText('provider-default-service', 'Not inspected');
	setText('provider-default-model', 'Not available');
	setText(
		'provider-default-status',
		platform.guidance?.access || 'Use OpenCode or your deployment tools to manage AI settings.'
	);
	setText('provider-saved-empty', 'Saved setups are not inspected through this connection.');
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
	for (const id of ['provider-saved-list', 'saved-access', 'discord-mappings', 'slack-mappings'])
		byId(id).replaceChildren();
	byId('runtime-recovery-status').replaceChildren();
	byId('runtime-recovery-status').className = 'inline-status neutral';
	setText(
		'runtime-recovery-status',
		'Checkpoint configuration is not inspected through this connection.'
	);
}
