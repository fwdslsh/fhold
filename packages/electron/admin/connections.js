import { clearClientKey, updateClientPolicy } from './access.js';
import { saveConfigAndOfferRestart } from './configuration.js';
import { offerRestart } from './restart.js';
import { csv, endpoint, isHealthy, isRunning } from './model.js';
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
	return snapshot.portalSecrets[portal]?.[name] === true;
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
	const unavailable = !!snapshot.dockerError;
	const assistant = snapshot.services.find((service) => service.name === 'assistant');
	setBadge(
		byId('opencode-connection-status'),
		unavailable
			? 'Status unavailable'
			: isHealthy(assistant)
				? 'Available'
				: isRunning(assistant)
					? 'Needs attention'
					: 'Stopped',
		!unavailable && isHealthy(assistant) ? 'success' : 'neutral'
	);
	setBadge(
		byId('mcp-connection-status'),
		snapshot.config.gateway.enabled ? 'Enabled' : 'Disabled',
		'neutral'
	);
	for (const portal of ['discord', 'slack']) {
		const enabled = snapshot.config.portals[portal].enabled;
		const service = snapshot.services.find((entry) => entry.name === portal);
		const healthy = enabled && !unavailable && isHealthy(service);
		setBadge(
			byId(`${portal}-connection-status`),
			enabled
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
	const saved = state.currentSnapshot.config.gateway.enabled;
	const pending = state.currentSnapshot.pendingRestart?.required === true;
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
	for (const portal of ['discord', 'slack']) updateClientPolicy(portal);
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

export function renderConnectionDetails(snapshot) {
	const details = snapshot.connectionDetails;
	if (!details) return;
	const directLink = byId('direct-url');
	directLink.textContent = details.opencode.url;
	directLink.setAttribute('href', details.opencode.url);
	directLink.hidden = false;
	setText('direct-username', details.opencode.username || 'user');
	setText('claude-url', details.claude.url);
	setText('mcp-url', details.mcp.url);
	setText('claude-extension-help', details.claude.note);
	const extensionLink = byId('claude-extension-download');
	extensionLink.setAttribute('href', details.claude.extension || 'about:blank');
	extensionLink.hidden = !details.claude.extension;
	byId('direct-password').value = '';
	byId('direct-password').type = 'password';
	byId('show-direct-password').checked = false;
	updateGuardianGuide();
}

export function renderNetworkDetails(snapshot) {
	const assistantUrl = endpoint(
		snapshot.config.assistant.bindAddress,
		snapshot.config.assistant.port
	);
	const healthUrl = endpoint(
		snapshot.config.gateway.bindAddress,
		snapshot.config.gateway.port,
		'/health'
	);
	for (const id of ['assistant-url-detail', 'overview-opencode-link']) {
		const link = byId(id);
		if (id === 'assistant-url-detail') link.textContent = assistantUrl;
		link.setAttribute('href', assistantUrl);
		link.hidden = false;
	}
	setText('guardian-health-url-detail', healthUrl);
	setText(
		'guardian-api-status',
		snapshot.config.gateway.enabled
			? 'MCP access is enabled in settings.'
			: 'Enable MCP access above to use these endpoints.'
	);
}

export async function loadDirectPassword(copyOnly) {
	const verb = copyOnly ? 'copy' : 'load';
	if (
		!window.confirm(
			`${verb === 'copy' ? 'Copy' : 'Load'} the trusted OpenCode password? It provides full local access.`
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

export async function loadClientKey(client, copyOnly) {
	const username = byId(`${client}-credential`).value;
	if (!username) return;
	if (
		!window.confirm(
			`${copyOnly ? 'Copy' : 'Load'} the key for ${username}? Its policy controls what this client can do.`
		)
	)
		return;
	const result = await operation(
		`${copyOnly ? 'Copying' : 'Loading'} access key`,
		async () => {
			const value = await state.api.credentialKey(username);
			if (copyOnly) await state.api.copyText(value.key);
			return value;
		},
		copyOnly ? `Key for ${username} copied.` : `Key for ${username} loaded and kept masked.`
	);
	if (result && !copyOnly) byId(`${client}-key`).value = result.key;
}

export function bindConnectionsEvents() {
	for (const id of ['gateway', 'discord', 'slack'])
		byId(id).addEventListener('change', updateConditionalConnections);
	for (const portal of ['discord', 'slack'])
		byId(`${portal}-credential`).addEventListener('change', () => updateClientPolicy(portal));

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
			config.portals[portal] = {
				...config.portals[portal],
				enabled,
				credential: byId(`${portal}-credential`).value,
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

	for (const client of ['claude', 'mcp']) {
		byId(`${client}-credential`).addEventListener('change', () => clearClientKey(client));
		byId(`${client}-credential`).addEventListener('change', () => updateClientPolicy(client));
		byId(`show-${client}-key`).addEventListener('change', () => {
			byId(`${client}-key`).type = byId(`show-${client}-key`).checked ? 'text' : 'password';
		});
	}

	for (const button of all('[data-load-client-key]')) {
		button.addEventListener('click', () => void loadClientKey(button.dataset.loadClientKey, false));
	}

	for (const button of all('[data-copy-client-key]')) {
		button.addEventListener('click', () => void loadClientKey(button.dataset.copyClientKey, true));
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
