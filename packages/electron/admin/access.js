import { offerRestart } from './restart.js';
import { render } from './snapshot.js';
import { policyLabels, state } from './state.js';
import { all, byId, notice, operation, setFormClean, setText } from './ui.js';

const portals = ['discord', 'slack'];
const clients = ['claude', 'mcp'];
const appLabels = {
	discord: 'Discord',
	slack: 'Slack',
	claude: 'Claude Desktop',
	mcp: 'this MCP app'
};
let editor;

export function credentialOptions(snapshot) {
	return Object.entries(snapshot.config.credentials)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([value, config]) => ({ value, label: `${value} — ${policyLabels[config.policy]}` }));
}

function selectedPolicy(app) {
	return document.querySelector(`input[name="${app}-policy"]:checked`)?.value;
}

function choosePolicy(app, policy) {
	const input = byId(`${app}-policy-${policy}`);
	if (input) input.checked = true;
}

function usages(username) {
	const snapshot = state.currentSnapshot;
	const uses = [];
	for (const portal of portals) {
		if (snapshot.config.portals[portal].credential === username)
			uses.push(`${appLabels[portal]} bot`);
		for (const [userId, credential] of Object.entries(snapshot.portalMappings[portal]?.users || {}))
			if (credential === username) uses.push(`${appLabels[portal]} user ${userId}`);
	}
	return uses;
}

function confirmPolicy(username, previous, policy, subject = `saved access “${username}”`) {
	if (previous === policy) return true;
	const full =
		policy === 'full'
			? ' Full access allows tools, file changes and tasks within your agent’s existing permissions. Continue only for apps and people you trust.'
			: '';
	if (!previous)
		return policy !== 'full' || window.confirm(`Allow Full access for ${subject}?${full}`);
	const known = usages(username);
	return window.confirm(
		`Change ${subject} to ${policyLabels[policy]}? This also changes everyone using the same access.${known.length ? ` Known uses: ${known.join(', ')}.` : ''} Other apps may also use it; fhold cannot detect them. Existing conversations are preserved.${full}`
	);
}

function uniqueName(base) {
	let name = base;
	for (let suffix = 2; Object.hasOwn(state.currentConfig.credentials, name); suffix++)
		name = `${base}-${suffix}`;
	return name;
}

export function updateAppPermissions(app) {
	const username = byId(`${app}-credential`).value;
	const saved = state.currentConfig?.credentials[username]?.policy;
	const policy = selectedPolicy(app) || saved || 'read';
	const changed =
		saved &&
		(saved !== policy ||
			(portals.includes(app) && state.currentConfig.portals[app].credential !== username));
	setText(
		`${app}-policy-help`,
		saved
			? `${changed ? (portals.includes(app) ? `Unsaved permissions · save ${appLabels[app]} settings` : 'Save permissions before connecting') : `Saved: ${policyLabels[saved]}`}.`
			: 'Choose permissions for a new connection. To change an existing connection, use Advanced access below.'
	);
	const details = byId(`${app}-connect-details`);
	if (details) details.hidden = !saved || saved !== policy;
	if (clients.includes(app))
		setText(`save-${app}-permissions`, saved ? 'Save permissions' : 'Create connection');
}

export function applyAppPermissions(config, app) {
	const username = byId(`${app}-credential`).value;
	const policy = selectedPolicy(app);
	if (!config.credentials[username] || !['chat', 'read', 'full'].includes(policy)) {
		notice(
			'The configured connection is unavailable. Reopen this instance before saving.',
			'error'
		);
		return false;
	}
	if (config.portals[app].credential !== username) {
		notice('The bot connection changed. Reopen this instance before saving.', 'error');
		return false;
	}
	if (
		!confirmPolicy(
			username,
			config.credentials[username].policy,
			policy,
			`${appLabels[app]} permissions`
		)
	)
		return false;
	config.portals[app].credential = username;
	config.credentials[username].policy = policy;
	return true;
}

export async function copyAccessKey(username) {
	if (!username || state.operationInFlight) return;
	return operation(
		'Copying connection key',
		async () => {
			const value = await state.api.credentialKey(username);
			await state.api.copyText(value.key);
			return true;
		},
		'Connection key copied. Paste it into the app’s connection settings.'
	);
}

export function renderCredentials(snapshot) {
	const choices = credentialOptions(snapshot);
	const list = byId('saved-access');
	list.replaceChildren();
	for (const choice of choices) {
		const row = document.createElement('div');
		row.className = 'mapping-row';
		const label = document.createElement('span');
		label.textContent = choice.label;
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'secondary';
		button.textContent = 'Manage';
		button.dataset.manageSavedAccess = choice.value;
		button.setAttribute('aria-label', `Manage saved access ${choice.value}`);
		row.append(label, button);
		list.append(row);
	}
	for (const app of [...portals, ...clients]) {
		const field = byId(`${app}-credential`);
		const dirty =
			state.dirtyForms.has(`${app}-connections-form`) ||
			state.dirtyForms.has(`${app}-permissions-form`);
		const selected =
			portals.includes(app) && !dirty ? snapshot.config.portals[app].credential : field.value;
		field.value = selected && Object.hasOwn(snapshot.config.credentials, selected) ? selected : '';
		if (portals.includes(app) && !dirty)
			choosePolicy(app, snapshot.config.credentials[selected]?.policy);
		if (clients.includes(app) && !dirty)
			choosePolicy(app, snapshot.config.credentials[field.value]?.policy || 'read');
		updateAppPermissions(app);
	}
}

export function renderMappings(snapshot) {
	for (const portal of portals) {
		const list = byId(`${portal}-mappings`);
		list.replaceChildren();
		for (const [userId, username] of Object.entries(snapshot.portalMappings[portal]?.users || {})) {
			const row = document.createElement('div');
			row.className = 'mapping-row';
			const label = document.createElement('span');
			label.textContent = `User ${userId} · ${policyLabels[snapshot.config.credentials[username]?.policy] || 'Unavailable'}`;
			row.append(label);
			const actions = document.createElement('div');
			actions.className = 'button-row compact mapping-actions';
			for (const [text, action] of [
				['Change permissions', 'changePersonPermissions'],
				['Use bot permissions', 'useBotPermissions']
			]) {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'text-button';
				button.textContent = text;
				button.dataset[action] = portal;
				button.dataset.userId = userId;
				button.setAttribute('aria-label', `${text} for ${portal} user ${userId}`);
				actions.append(button);
			}
			row.append(actions);
			list.append(row);
		}
		if (!list.children.length) {
			const empty = document.createElement('p');
			empty.className = 'help-text';
			empty.textContent = 'All allowed people use the bot’s permissions.';
			list.append(empty);
		}
	}
}

function openEditor({ username, portal, userId } = {}) {
	if (state.operationInFlight || !state.currentConfig) return;
	editor = {
		username,
		portal,
		userId,
		baseline: structuredClone(state.currentConfig),
		focus: document.activeElement
	};
	byId('permissions-form').reset();
	byId('person-id-field').hidden = !portal;
	byId('person-id').required = Boolean(portal);
	byId('person-id').pattern = portal === 'discord' ? '[0-9]{5,32}' : '[UW][A-Z0-9]{2,31}';
	byId('person-id').title =
		portal === 'discord'
			? 'Enter the numeric Discord user ID.'
			: 'Enter the Slack member ID, starting with U or W.';
	setText('person-id-label', portal ? `${appLabels[portal]} user ID` : 'Person ID');
	byId('person-id').value = userId || '';
	byId('person-id').readOnly = Boolean(userId);
	byId('saved-access-name-field').hidden = Boolean(username) || Boolean(portal);
	byId('saved-access-name').required = !username && !portal;
	byId('saved-access-name').value = '';
	setText(
		'permissions-heading',
		portal
			? userId
				? `Permissions for user ${userId}`
				: 'Permissions for a person'
			: username
				? `Permissions for ${username}`
				: 'New saved access'
	);
	setText(
		'permissions-guidance',
		portal
			? `They must also be allowed to use the ${appLabels[portal]} bot. This changes permissions, not the allowed people.`
			: 'Saved access can be reused by apps. Its permissions apply to every use.'
	);
	setText(
		'permissions-impact',
		username
			? `These permissions apply to everyone using the same access.${usages(username).length ? ` Known uses: ${usages(username).join(', ')}.` : ''} External apps may not be listed. Existing conversations are preserved.`
			: portal
				? 'This person will have separate conversations from the bot’s shared access.'
				: 'Separate access is created only when you save.'
	);
	byId('permissions-impact').hidden = false;
	setText('save-permissions', portal ? 'Save person permissions' : 'Save permissions');
	byId(
		`dialog-policy-${username ? state.currentConfig.credentials[username].policy : portal ? 'chat' : 'read'}`
	).checked = true;
	byId('permissions-error').hidden = true;
	byId('permissions-dialog').showModal();
	(portal && !userId
		? byId('person-id')
		: !portal && !username
			? byId('saved-access-name')
			: document.querySelector('input[name="dialog-policy"]:checked')
	).focus();
}

async function saveEditor() {
	if (!editor || state.operationInFlight || !byId('permissions-form').reportValidity()) return;
	const draft = editor;
	const policy = document.querySelector('input[name="dialog-policy"]:checked').value;
	const userId = draft.portal ? draft.pendingUserId || byId('person-id').value.trim() : undefined;
	if (
		draft.portal &&
		!draft.userId &&
		!draft.pendingUserId &&
		Object.hasOwn(state.currentSnapshot.portalMappings[draft.portal]?.users || {}, userId)
	) {
		const username = state.currentSnapshot.portalMappings[draft.portal].users[userId];
		draft.username = username;
		draft.userId = userId;
		draft.baseline = structuredClone(state.currentConfig);
		byId('person-id').readOnly = true;
		byId(`dialog-policy-${state.currentConfig.credentials[username].policy}`).checked = true;
		setText('permissions-heading', `Permissions for user ${userId}`);
		setText(
			'permissions-impact',
			'Changing these permissions affects every app or person using this access. Existing conversations are preserved.'
		);
		setText(
			'permissions-error',
			'This person already has permissions. Their existing access is selected; review the permissions and save again.'
		);
		byId('permissions-error').hidden = false;
		return;
	}
	const username =
		draft.username ||
		(draft.portal
			? uniqueName(`${draft.portal}-user-${userId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}`)
			: byId('saved-access-name').value.trim());
	if (
		!confirmPolicy(
			username,
			draft.baseline.credentials[username]?.policy,
			policy,
			draft.portal
				? `${appLabels[draft.portal]} user ${userId} permissions`
				: draft.username
					? `saved access “${username}”`
					: 'the new saved access'
		)
	)
		return;
	const controls = [...byId('permissions-form').querySelectorAll('input, select')].map((input) => ({
		input,
		disabled: input.disabled
	}));
	for (const { input } of controls) input.disabled = true;
	byId('permissions-dialog').setAttribute('aria-busy', 'true');
	let result;
	try {
		result = await operation(
			'Saving permissions',
			async () => {
				let saved;
				if (draft.username) {
					const config = structuredClone(draft.baseline);
					config.credentials[username].policy = policy;
					saved = await state.api.saveConfig({ config, baseConfig: draft.baseline });
					draft.baseline = structuredClone(saved.config);
					render(saved);
				} else {
					saved = await state.api.credential({ action: 'create', username, policy });
					draft.username = username;
					draft.baseline = structuredClone(saved.config);
					if (draft.portal) {
						draft.pendingUserId = userId;
						byId('person-id').readOnly = true;
					}
					render(saved);
				}
				if (draft.portal && !draft.userId) {
					try {
						saved = await state.api.mapPortalUser({ portal: draft.portal, userId, username });
					} catch (error) {
						throw new Error(
							`Permissions are saved, but were not assigned to user ${userId}. Retry to assign the saved permissions. ${error instanceof Error ? error.message : String(error)}`
						);
					}
				}
				return saved;
			},
			'Permissions saved.'
		);
	} finally {
		for (const { input, disabled } of controls) input.disabled = disabled;
		byId('permissions-dialog').setAttribute('aria-busy', 'false');
	}
	if (!result) {
		setText('permissions-error', byId('notice-message').textContent);
		byId('permissions-error').hidden = false;
		return;
	}
	byId('permissions-dialog').close();
	await offerRestart(result);
}

async function saveClient(app) {
	if (state.operationInFlight || !state.currentConfig) return;
	const baseline = structuredClone(state.currentConfig);
	let username = byId(`${app}-credential`).value;
	const policy = selectedPolicy(app);
	if (!['chat', 'read', 'full'].includes(policy)) return;
	if (
		!confirmPolicy(
			username,
			baseline.credentials[username]?.policy,
			policy,
			app === 'claude' ? 'Claude Desktop' : 'this MCP app'
		)
	)
		return;
	const controls = [...byId(`${app}-permissions-form`).querySelectorAll('input, select')].map(
		(input) => ({ input, disabled: input.disabled })
	);
	for (const { input } of controls) input.disabled = true;
	let result;
	try {
		result = await operation(
			'Saving app permissions',
			async () => {
				let saved;
				if (username) {
					const config = structuredClone(baseline);
					config.credentials[username].policy = policy;
					saved = await state.api.saveConfig({ config, baseConfig: baseline });
				} else {
					username = uniqueName(app === 'claude' ? 'claude-desktop' : 'mcp-app');
					saved = await state.api.credential({ action: 'create', username, policy });
				}
				setFormClean(`${app}-permissions-form`);
				render(saved);
				byId(`${app}-credential`).value = username;
				choosePolicy(app, policy);
				updateAppPermissions(app);
				return saved;
			},
			'Permissions saved. Complete setup in your app.'
		);
	} finally {
		for (const { input, disabled } of controls) input.disabled = disabled;
	}
	if (result) await offerRestart(result);
}

export function bindAccessEvents() {
	for (const app of [...portals, ...clients]) {
		byId(`${app}-permissions`).addEventListener('change', () => updateAppPermissions(app));
	}
	for (const app of clients)
		byId(`${app}-permissions-form`).addEventListener('submit', (event) => {
			event.preventDefault();
			void saveClient(app);
		});
	byId('saved-access').addEventListener('click', (event) => {
		const button = event.target.closest('[data-manage-saved-access]');
		if (button) openEditor({ username: button.dataset.manageSavedAccess });
	});
	for (const button of all('[data-new-saved-access]'))
		button.addEventListener('click', () => openEditor());
	for (const button of all('[data-add-person-permissions]'))
		button.addEventListener('click', () =>
			openEditor({ portal: button.dataset.addPersonPermissions })
		);
	for (const portal of portals)
		byId(`${portal}-mappings`).addEventListener('click', async (event) => {
			const button = event.target.closest(
				'[data-change-person-permissions], [data-use-bot-permissions]'
			);
			if (!button || state.operationInFlight) return;
			const userId = button.dataset.userId;
			const username = state.currentSnapshot.portalMappings[portal].users[userId];
			if (button.hasAttribute('data-change-person-permissions'))
				return openEditor({ username, portal, userId });
			const defaultId = state.currentConfig.portals[portal].credential;
			if (
				!window.confirm(
					`Use the bot’s ${policyLabels[state.currentConfig.credentials[defaultId].policy]} permissions for user ${userId}? This may grant more access. Conversations remain tied to their previous access identity when it changes.`
				)
			)
				return;
			const saved = await operation(
				'Saving bot default for person',
				() => state.api.mapPortalUser({ portal, userId }),
				'Person now uses the bot’s permissions.'
			);
			if (saved) await offerRestart(saved);
		});
	byId('permissions-form').addEventListener('submit', (event) => {
		event.preventDefault();
		void saveEditor();
	});
	byId('cancel-permissions').addEventListener('click', () => {
		if (!state.operationInFlight) byId('permissions-dialog').close();
	});
	byId('permissions-dialog').addEventListener('cancel', (event) => {
		if (state.operationInFlight) event.preventDefault();
	});
	byId('permissions-dialog').addEventListener('close', () => {
		const closed = editor;
		editor = undefined;
		byId('permissions-form').reset();
		setFormClean('permissions-form');
		if (closed?.focus?.isConnected) closed.focus.focus();
		else if (closed?.portal)
			all('[data-add-person-permissions]')
				.find((button) => button.dataset.addPersonPermissions === closed.portal)
				?.focus();
		else
			all('[data-manage-saved-access]')
				.find((button) => button.dataset.manageSavedAccess === closed?.username)
				?.focus();
	});
}
