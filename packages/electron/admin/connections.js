import { applyAppPermissions, copyAccessKey, updateAppPermissions } from './access.js';
import { saveConfigAndOfferRestart } from './configuration.js';
import { offerRestart } from './restart.js';
import { csv, isHealthy, isRunning, known } from './model.js';
import { state } from './state.js';
import {
	all,
	byId,
	notice,
	operation,
	setBadge,
	setFormClean,
	setText,
	showConnectionApp
} from './ui.js';

export function secretConfigured(snapshot, portal, name) {
	const config = known(snapshot.apps?.config);
	return config?.portalSecrets?.[portal]?.[name] === true;
}

export function renderPortalSecrets(snapshot) {
	for (const portal of ['discord', 'slack']) {
		const ready = portalTokensReady(snapshot, portal);
		setBadge(
			byId(`${portal}-token-status`),
			ready ? 'Saved' : 'Not configured',
			ready ? 'success' : 'neutral'
		);
	}
}

function portalTokensReady(snapshot, portal) {
	return (
		secretConfigured(snapshot, portal, `${portal}_bot_token`) &&
		(portal !== 'slack' || secretConfigured(snapshot, 'slack', 'slack_app_token'))
	);
}

export function renderConnectionStatus(snapshot) {
	const unavailable = snapshot.services?.state === 'unavailable';
	const services = known(snapshot.services) || [];
	const config = snapshot.docker?.config;
	const connections = known(snapshot.apps?.connections);
	const connectionError =
		connections?.error ||
		(snapshot.apps?.connections?.state === 'unavailable'
			? snapshot.apps.connections.reason
			: undefined);
	const assistant = services.find((service) => service.name === 'assistant');
	setBadge(
		byId('opencode-connection-status'),
		unavailable
			? 'Status unavailable'
			: connectionError
				? 'Connection unavailable'
				: isHealthy(assistant)
					? 'Available'
					: isRunning(assistant)
						? 'Needs attention'
						: 'Stopped',
		!unavailable && !connectionError && isHealthy(assistant) ? 'success' : 'neutral'
	);
	setBadge(
		byId('mcp-connection-status'),
		config?.gateway.enabled ? 'Enabled' : 'Disabled',
		'neutral'
	);
	for (const portal of ['discord', 'slack']) {
		const enabled = config?.portals?.[portal]?.enabled === true;
		const appStatus = known(snapshot.apps?.status)?.[portal];
		const service = services.find((entry) => entry.name === portal);
		const healthy = enabled && !unavailable && isHealthy(service);
		setBadge(
			byId(`${portal}-connection-status`),
			enabled || appStatus?.configured
				? unavailable
					? 'Status unavailable'
					: healthy
						? 'Running'
						: isRunning(service)
							? 'Needs attention'
							: 'Not running'
				: portalTokensReady(snapshot, portal)
					? 'Configured'
					: 'Not configured',
			healthy ? 'success' : 'neutral'
		);
	}
}

export function updateGuardianGuide() {
	if (!state.currentSnapshot) return;
	const config = state.currentSnapshot.docker?.config;
	if (!config) {
		setText(
			'claude-guardian-help',
			'This app configuration is not managed through the selected connection.'
		);
		setText(
			'mcp-guardian-help',
			'This app configuration is not managed through the selected connection.'
		);
		return;
	}
	const saved = config.gateway.enabled;
	const pending = known(state.currentSnapshot.pendingChanges)?.pending;
	const selected = byId('gateway').checked;
	const guide =
		selected !== saved
			? 'Unsaved change. Save MCP settings to apply.'
			: saved
				? pending
					? 'MCP access is enabled in settings. Saved changes apply at the next restart.'
					: 'MCP access is enabled in settings. Your instance must be running to connect.'
				: 'MCP access is disabled.';
	setText('claude-guardian-help', guide);
	setText('mcp-guardian-help', guide);
	for (const button of all('[data-enable-gateway]')) button.hidden = saved;
}

export function updateConditionalConnections() {
	updateGuardianGuide();
	for (const app of ['claude', 'mcp', 'discord', 'slack']) updateAppPermissions(app);
}

export function updatePortalTokenFields() {
	const snapshot = state.currentSnapshot;
	for (const portal of ['discord', 'slack']) {
		const botConfigured = snapshot && secretConfigured(snapshot, portal, `${portal}_bot_token`);
		const title = portal === 'discord' ? 'Discord' : 'Slack';
		setText(
			`${portal}-bot-token-label`,
			`${title} bot token${botConfigured ? ' (saved; leave blank to keep)' : ''}`
		);
		if (portal === 'slack') {
			const appConfigured = snapshot && secretConfigured(snapshot, portal, 'slack_app_token');
			setText(
				'slack-app-token-label',
				`Slack app token${appConfigured ? ' (saved; leave blank to keep)' : ''}`
			);
		}
		setText(
			`${portal}-token-help`,
			'Tokens are stored privately and never shown again. Blank fields keep saved tokens.'
		);
	}
}

export function showPortalTokenForm(portal, field = `${portal}-bot-token`) {
	showConnectionApp(portal);
	byId(`${portal}-tokens`).open = true;
	updatePortalTokenFields();
	byId(`${portal}-token-form`).scrollIntoView({ block: 'nearest' });
	queueMicrotask(() => byId(field).focus());
}

export function renderConnectionLinks(snapshot) {
	const details = known(snapshot.apps?.connections) || {};
	const opencode = details.opencode;
	const mcp = details.mcp;
	const claude = details.claude;
	const directLink = byId('direct-url');
	directLink.textContent = opencode?.url || 'Not connected';
	directLink.setAttribute('href', opencode?.url || 'about:blank');
	directLink.hidden = !opencode?.url;
	setText(
		'opencode-connection-help',
		details.error ||
			opencode?.note ||
			snapshot.apps?.connections?.reason ||
			'Connect to inspect this native agent.'
	);
	setText(
		'direct-username',
		opencode?.username || known(snapshot.agent?.access)?.username || 'Not reported'
	);
	setText('claude-url', claude?.url || 'Not connected');
	setText('mcp-url', mcp?.url || 'Not connected');
	setText('claude-extension-help', claude?.note || 'Connect to inspect this client link.');
	const extensionLink = byId('claude-extension-download');
	extensionLink.setAttribute('href', claude?.extension || 'about:blank');
	extensionLink.hidden = !claude?.extension;
	for (const id of ['direct-url', 'claude-url', 'mcp-url', 'guardian-health-url-detail'])
		for (const button of all(`[data-copy-field="${id}"]`))
			button.disabled =
				!byId(id).textContent ||
				byId(id).textContent === 'Not connected' ||
				state.operationInFlight;
	updateGuardianGuide();
}

export function renderConnectionDetails(snapshot) {
	renderConnectionLinks(snapshot);
	const ready = (name) => {
		const operation = snapshot.operations?.[name];
		return operation?.support === 'supported' && operation.availability?.state === 'ready';
	};
	byId('direct-password').value = '';
	byId('direct-password').type = 'password';
	byId('show-direct-password').checked = false;
	byId('native-agent-password').value = '';
	// Only an explicitly connected native agent may be inspected. The field is
	// intentionally cleared on every render and never enters drafts or recents.
	byId('native-agent-connect').hidden =
		(snapshot.agent?.access?.state === 'known' &&
			!snapshot.operations?.['agent.connect']?.input?.requiresPassword &&
			!snapshot.operations?.['agent.connect']?.input?.acceptsPassword) ||
		!ready('agent.connect');
	setText(
		'connect-native-agent',
		snapshot.agent?.access?.state === 'known' ? 'Reconnect to agent' : 'Connect to agent'
	);
	byId('native-agent-password-field').hidden =
		snapshot.operations?.['agent.connect']?.input?.requiresPassword !== true &&
		snapshot.operations?.['agent.connect']?.input?.acceptsPassword !== true;
	byId('provider-agent-access').hidden =
		snapshot.agent?.access?.state === 'known' || !ready('agent.connect');
	for (const id of ['load-direct-password', 'copy-direct-password', 'show-direct-password'])
		byId(id).disabled = state.operationInFlight || !ready('agent.assistantPassword');
	for (const control of byId('opencode-network-form').querySelectorAll('input, button'))
		control.disabled = state.operationInFlight || !ready('docker.saveConfig');
	updateGuardianGuide();
}

export function renderNetworkDetails(snapshot) {
	const links = known(snapshot.apps?.connections);
	const deployment = known(snapshot.deployment);
	const assistantUrl = links?.opencode?.url || deployment?.clientUrl || '';
	let healthUrl = '';
	if (links?.mcp?.url) {
		try {
			const url = new URL(links.mcp.url);
			url.pathname = url.pathname.endsWith('/mcp')
				? `${url.pathname.slice(0, -4)}/health`
				: url.pathname;
			healthUrl = url.toString();
		} catch {}
	}
	for (const id of ['assistant-url-detail', 'overview-opencode-link']) {
		const link = byId(id);
		if (id === 'assistant-url-detail') link.textContent = assistantUrl;
		link.setAttribute('href', assistantUrl || 'about:blank');
		link.hidden = !assistantUrl;
	}
	const browser = snapshot.operations?.['agent.browserLink'];
	const canOpen = browser?.support === 'supported' && browser.availability?.state === 'ready';
	const open = byId('overview-opencode-link');
	if (!assistantUrl && canOpen) {
		open.hidden = false;
		open.setAttribute('href', '#');
	}
	setText('guardian-health-url-detail', healthUrl);
	for (const button of all('[data-copy-field="guardian-health-url-detail"]'))
		button.disabled = !healthUrl || state.operationInFlight;
	setText(
		'guardian-api-status',
		links?.mcp?.url
			? 'MCP access is enabled in settings.'
			: 'Enable MCP access above to use these endpoints.'
	);
}

async function connectNativeAgent() {
	const target = JSON.stringify(state.currentSnapshot?.identity?.ref);
	const password = byId('native-agent-password').value;
	byId('native-agent-password').value = '';
	const setup = state.awaitingSetupFinish;
	try {
		const connected = await operation(
			'Connecting to agent',
			() => state.api.connectAgent({ ...(password ? { password } : {}) }),
			'Agent connected for this Admin session.'
		);
		if (JSON.stringify(state.currentSnapshot?.identity?.ref) !== target) return undefined;
		if (connected) {
			const { resetProviderState } = await import('./providers.js');
			if (JSON.stringify(state.currentSnapshot?.identity?.ref) !== target) return undefined;
			resetProviderState();
			state.awaitingSetupFinish = setup;
			await import('./snapshot.js').then(({ refresh }) => refresh());
		} else if (state.currentSnapshot?.operations?.['agent.connect']?.input?.acceptsPassword) {
			showConnectionApp('opencode');
			byId('native-agent-connect').hidden = false;
			byId('native-agent-password-field').hidden = false;
			byId('native-agent-password').focus();
		}
		return JSON.stringify(state.currentSnapshot?.identity?.ref) === target ? connected : undefined;
	} finally {
		byId('native-agent-password').value = '';
	}
}

export async function loadDirectPassword(copyOnly) {
	const verb = copyOnly ? 'copy' : 'load';
	if (
		!window.confirm(
			`${verb === 'copy' ? 'Copy' : 'Load'} the trusted OpenCode password? It provides full access to this instance.`
		)
	)
		return;
	const result = await operation(
		`${copyOnly ? 'Copying' : 'Loading'} OpenCode password`,
		async () => {
			const value = await state.api.assistantPassword();
			if (copyOnly) await state.api.copyText(value.password);
			return value;
		},
		copyOnly ? 'OpenCode password copied.' : 'OpenCode password loaded and kept masked.'
	);
	if (result && !copyOnly) byId('direct-password').value = result.password;
}

export function bindConnectionsEvents() {
	byId('open-knowledge').addEventListener('click', () =>
		operation('Opening AKM UI', () => state.api.openKnowledge(), 'AKM UI opened in your browser.')
	);
	for (const id of ['gateway', 'discord', 'slack'])
		byId(id).addEventListener('change', updateConditionalConnections);

	byId('connect-native-agent').addEventListener('click', () => connectNativeAgent());
	byId('provider-connect-agent').addEventListener('click', () => {
		if (state.currentSnapshot?.operations?.['agent.connect']?.input?.requiresPassword) {
			showConnectionApp('opencode');
			byId('native-agent-password').focus();
		} else return connectNativeAgent();
	});
	for (const id of ['overview-opencode-link', 'direct-url', 'assistant-url-detail']) {
		byId(id).addEventListener('click', async (event) => {
			event.preventDefault();
			if (state.operationInFlight) return;
			const browser = state.currentSnapshot?.operations?.['agent.browserLink'];
			if (
				browser?.availability?.state !== 'ready' &&
				state.currentSnapshot?.operations?.['agent.connect']?.input?.requiresPassword
			) {
				showConnectionApp('opencode');
				byId('native-agent-password').focus();
				notice('Connect this agent once below, then Open OpenCode will sign your browser in.');
				return;
			}
			let opened = false;
			await operation(
				'Opening OpenCode',
				async () => {
					await state.api.openOpenCode();
					opened = true;
				},
				'OpenCode opened.'
			);
			if (!opened && state.currentSnapshot?.operations?.['agent.connect']?.input?.acceptsPassword) {
				showConnectionApp('opencode');
				byId('native-agent-connect').hidden = false;
				byId('native-agent-password-field').hidden = false;
				byId('native-agent-password').focus();
			}
		});
	}

	for (const button of all('[data-enable-gateway]')) {
		button.addEventListener('click', async () => {
			if (state.operationInFlight || !state.currentConfig) return;
			const config = structuredClone(state.currentConfig);
			config.gateway.enabled = true;
			byId('gateway').checked = true;
			state.dirtyForms.add('mcp-connections-form');
			updateConditionalConnections();
			await saveConfigAndOfferRestart(
				config,
				'mcp-connections-form',
				'Enabling Claude Desktop access',
				'Claude Desktop access saved.'
			);
		});
	}

	byId('mcp-connections-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (state.operationInFlight || !state.currentConfig) return;
		const enabled = byId('gateway').checked;
		if (
			!enabled &&
			['discord', 'slack'].some((portal) => state.currentConfig.portals[portal].enabled)
		) {
			notice(
				'Disable Discord and Slack before turning off MCP access; their bots need this service.',
				'error',
				{ persist: true }
			);
			return;
		}
		const config = structuredClone(state.currentConfig);
		config.gateway.enabled = enabled;
		await saveConfigAndOfferRestart(
			config,
			'mcp-connections-form',
			'Saving MCP access',
			'MCP settings saved.'
		);
	});

	for (const portal of ['discord', 'slack']) {
		byId(`${portal}-connections-form`).addEventListener('submit', async (event) => {
			event.preventDefault();
			if (state.operationInFlight || !state.currentConfig || !state.currentSnapshot) return;
			const enabled = byId(portal).checked;
			const access =
				portal === 'discord'
					? {
							guilds: csv(byId('discord-guilds').value),
							roles: csv(byId('discord-roles').value),
							users: csv(byId('discord-users').value),
							blockedUsers: csv(byId('discord-blocked-users').value)
						}
					: {
							channels: csv(byId('slack-channels').value),
							users: csv(byId('slack-users').value),
							blockedUsers: csv(byId('slack-blocked-users').value)
						};
			const allowed =
				portal === 'discord'
					? [...access.guilds, ...access.roles, ...access.users]
					: [...access.channels, ...access.users];
			const title = portal === 'discord' ? 'Discord' : 'Slack';
			if (enabled && allowed.length === 0) {
				showConnectionApp(portal);
				byId(`${portal}-access-disclosure`).open = true;
				notice(
					`Add at least one allowed ${portal === 'discord' ? 'server, role or user' : 'channel or user'} before enabling ${title}.`,
					'error',
					{ persist: true }
				);
				byId(`${portal}-users`).focus();
				return;
			}
			if (enabled && !portalTokensReady(state.currentSnapshot, portal)) {
				showPortalTokenForm(
					portal,
					portal === 'slack' && secretConfigured(state.currentSnapshot, portal, 'slack_bot_token')
						? 'slack-app-token'
						: `${portal}-bot-token`
				);
				notice(
					`Save ${title === 'Slack' ? 'both Slack tokens' : 'a Discord bot token'} before enabling ${title}.`,
					'error',
					{ persist: true }
				);
				return;
			}
			const config = structuredClone(state.currentConfig);
			if (!applyAppPermissions(config, portal)) return;
			config.portals[portal] = {
				...config.portals[portal],
				enabled,
				access
			};
			if (enabled) config.gateway.enabled = true;
			await saveConfigAndOfferRestart(
				config,
				`${portal}-connections-form`,
				`Saving ${title} settings`,
				`${title} settings saved.`
			);
		});
	}

	for (const button of all('[data-copy-field]')) {
		button.addEventListener('click', async () => {
			const value = byId(button.dataset.copyField).textContent;
			await operation('Copying connection value', () => state.api.copyText(value), 'Copied.');
		});
	}

	byId('load-direct-password').addEventListener('click', () => void loadDirectPassword(false));

	byId('copy-direct-password').addEventListener('click', () => void loadDirectPassword(true));

	byId('show-direct-password').addEventListener('change', () => {
		byId('direct-password').type = byId('show-direct-password').checked ? 'text' : 'password';
	});

	for (const button of all('[data-copy-client-key]')) {
		button.addEventListener('click', () => {
			const client = button.dataset.copyClientKey;
			const username = byId(`${client}-credential`).value;
			const policy = byId(`${client}-permissions`).querySelector('input:checked')?.value;
			const configuration = state.currentSnapshot?.apps?.config;
			if (
				!username ||
				configuration?.state !== 'known' ||
				configuration.value.credentials[username]?.policy !== policy
			) {
				notice('Save permissions before connecting this app.', 'error');
				byId(`save-${client}-permissions`).focus();
				return;
			}
			if (username) void copyAccessKey(username);
		});
	}

	for (const button of all('[data-external-url]')) {
		button.addEventListener(
			'click',
			() =>
				void operation(
					'Opening setup page',
					() => state.api.openExternal(button.dataset.externalUrl),
					'Setup page opened.'
				)
		);
	}

	for (const portal of ['discord', 'slack']) {
		byId(`${portal}-token-form`).addEventListener('submit', async (event) => {
			event.preventDefault();
			if (state.operationInFlight || !state.currentSnapshot) return;
			const botToken = byId(`${portal}-bot-token`).value;
			const appToken = portal === 'slack' ? byId('slack-app-token').value : undefined;
			const botConfigured = secretConfigured(state.currentSnapshot, portal, `${portal}_bot_token`);
			const appConfigured =
				portal === 'slack' && secretConfigured(state.currentSnapshot, portal, 'slack_app_token');
			const title = portal === 'discord' ? 'Discord' : 'Slack';
			if ((!botConfigured && !botToken) || (portal === 'slack' && !appConfigured && !appToken)) {
				notice(
					`Enter ${portal === 'slack' ? 'both Slack tokens' : 'the Discord bot token'} the first time.`,
					'error',
					{ persist: true }
				);
				return;
			}
			if (!botToken && !appToken) {
				notice(`Enter a ${title} token to replace, or leave the saved tokens unchanged.`, 'error', {
					persist: true
				});
				return;
			}
			const result = await operation(
				`Saving ${title} tokens`,
				async () => {
					const saved = await state.api.portalToken({ portal, botToken, appToken });
					byId(`${portal}-bot-token`).value = '';
					if (portal === 'slack') byId('slack-app-token').value = '';
					setFormClean(`${portal}-token-form`);
					return saved;
				},
				`${title} tokens saved privately.`
			);
			if (result) await offerRestart(result);
		});
	}
}
