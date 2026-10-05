import { offerRestart } from './restart.js';
import { policyDescriptions, policyLabels, state } from './state.js';
import { all, byId, notice, operation, setFormClean, setOptions, setText } from './ui.js';

let keyEditor;

const appNames = {
	claude: 'Claude Desktop',
	mcp: 'your MCP app',
	discord: 'Discord',
	slack: 'Slack'
};

export function credentialOptions(snapshot) {
	return Object.entries(snapshot.config.credentials)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([value, config]) => ({ value, label: `${value} — ${policyLabels[config.policy]}` }));
}

export function clearClientKey(client) {
	byId(`${client}-key`).value = '';
	byId(`show-${client}-key`).checked = false;
	byId(`${client}-key`).type = 'password';
}

export function updateClientPolicy(client) {
	if (!state.currentSnapshot) return;
	const username = byId(`${client}-credential`).value;
	const policy = state.currentSnapshot.config.credentials[username]?.policy;
	const help = byId(`${client}-policy-help`);
	if (!policy) {
		help.textContent = 'Choose a key, or create one for this app.';
		help.className = 'help-text';
		return;
	}
	const prefix = ['discord', 'slack'].includes(client) ? 'The bot can' : 'This app can';
	const ability = {
		chat: 'chat only. It cannot use tools, change files or carry out tasks.',
		read: 'chat and read non-sensitive workspace files. It cannot change files or run commands.',
		full: 'use tools, change files and carry out tasks within your agent’s existing permissions. Use this only for apps and people you trust.'
	};
	help.textContent = `${prefix} ${ability[policy]}`;
	help.className = 'help-text';
}

function keyUsages(snapshot, username) {
	const usages = [];
	for (const portal of ['discord', 'slack']) {
		if (snapshot.config.portals[portal].credential === username)
			usages.push(`${appNames[portal]} default`);
		const count = Object.values(snapshot.portalMappings[portal]?.users || {}).filter(
			(name) => name === username
		).length;
		if (count) usages.push(`${appNames[portal]} · ${count} ${count === 1 ? 'user' : 'users'}`);
	}
	return usages;
}

function keyAction(label, action, username, className = 'secondary') {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = className;
	button.textContent = label;
	button.dataset.keyAction = action;
	button.dataset.username = username;
	button.setAttribute('aria-label', `${label}: ${username}`);
	return button;
}

export async function copyAccessKey(username) {
	if (!username || state.operationInFlight) return;
	return operation(
		'Copying access key',
		async () => {
			const value = await state.api.credentialKey(username);
			await state.api.copyText(value.key);
		},
		`Key “${username}” copied. Paste it into the app you are connecting.`
	);
}

export function renderCredentials(snapshot) {
	const usernames = Object.keys(snapshot.config.credentials).sort();
	const choices = credentialOptions(snapshot);
	const list = byId('access-keys');
	list.replaceChildren();
	for (const username of usernames) {
		const policy = snapshot.config.credentials[username].policy;
		const usages = keyUsages(snapshot, username);
		const card = document.createElement('article');
		card.className = 'panel access-key-card';
		const header = document.createElement('div');
		header.className = 'access-key-card-heading';
		const name = document.createElement('h2');
		name.textContent = username;
		const permissions = document.createElement('span');
		permissions.className = 'status-badge neutral';
		permissions.textContent = policyLabels[policy];
		header.append(name, permissions);
		const description = document.createElement('p');
		description.className = 'help-text';
		description.textContent = policyDescriptions[policy];
		const usage = document.createElement('p');
		usage.className = 'access-key-usage';
		usage.textContent = usages.length
			? `Assigned to ${usages.join(' · ')}`
			: 'Available for your apps';
		const actions = document.createElement('div');
		actions.className = 'button-row compact';
		actions.append(
			keyAction('Copy key', 'copy', username),
			keyAction('Edit permissions', 'edit', username, 'text-button')
		);
		const more = document.createElement('details');
		more.className = 'disclosure access-key-more';
		const summary = document.createElement('summary');
		summary.textContent = 'Replace or revoke';
		const explanation = document.createElement('p');
		explanation.className = 'help-text';
		explanation.textContent =
			'Replace a key if it was shared accidentally. Revoke it to remove access. Apps using the old key will need to be updated.';
		const destructive = document.createElement('div');
		destructive.className = 'button-row compact';
		const revoke = keyAction('Revoke key', 'revoke', username, 'danger subtle');
		revoke.disabled = usages.length > 0 || usernames.length === 1;
		destructive.append(keyAction('Replace key', 'replace', username), revoke);
		more.append(summary, explanation, destructive);
		if (revoke.disabled) {
			const why = document.createElement('p');
			why.className = 'help-text';
			why.textContent = usages.length
				? 'Choose another key for the saved Discord or Slack assignments before revoking this one.'
				: 'Keep at least one access key. Create another before revoking this one.';
			more.append(why);
		}
		card.append(header, description, usage, actions, more);
		list.append(card);
	}
	for (const portal of ['discord', 'slack']) {
		setOptions(byId(`${portal}-credential`), choices, snapshot.config.portals[portal].credential);
		setOptions(
			byId(`${portal}-mapping-credential`),
			[{ value: '', label: 'Same as everyone else (app default)' }, ...choices],
			byId(`${portal}-mapping-credential`).value
		);
	}
	for (const client of ['claude', 'mcp']) {
		const selected = byId(`${client}-credential`).value;
		setOptions(
			byId(`${client}-credential`),
			[{ value: '', label: 'Choose a key…' }, ...choices],
			selected
		);
		clearClientKey(client);
		updateClientPolicy(client);
	}
}

function suggestedKeyName(app) {
	const base = app === 'claude' ? 'claude-desktop' : app === 'mcp' ? 'mcp-app' : app;
	if (!base) return '';
	let name = base;
	for (let suffix = 2; Object.hasOwn(state.currentConfig.credentials, name); suffix++)
		name = `${base}-${suffix}`;
	return name;
}

function openKeyEditor(username, app) {
	if (state.operationInFlight || !state.currentConfig) return;
	if (username && !Object.hasOwn(state.currentConfig.credentials, username)) return;
	keyEditor = { username, app, baseline: structuredClone(state.currentConfig) };
	const editing = Boolean(username);
	byId('access-key-form').reset();
	setFormClean('access-key-form');
	byId('access-key-name').value = username || suggestedKeyName(app);
	byId('access-key-name').readOnly = editing;
	byId('access-key-name').setCustomValidity('');
	setText(
		'access-key-heading',
		editing
			? `Permissions for ${username}`
			: app
				? `New key for ${appNames[app]}`
				: 'New access key'
	);
	setText(
		'access-key-guidance',
		editing
			? 'These permissions apply to every app or person using this key. Create a separate key if only one app needs different access.'
			: 'Give the key a name, then choose what the connected app or person can do.'
	);
	setText(
		'access-key-name-help',
		editing
			? 'The key value stays the same when you change its permissions.'
			: 'Use the app or person’s name, such as claude-desktop or alex.'
	);
	setText('save-access-key', editing ? 'Save permissions' : 'Create key');
	const policy = editing ? state.currentConfig.credentials[username].policy : 'read';
	byId(`access-key-${policy}`).checked = true;
	byId('access-key-full-warning').hidden = policy !== 'full';
	byId('access-key-error').hidden = true;
	byId('access-key-dialog').showModal();
	(editing ? byId(`access-key-${policy}`) : byId('access-key-name')).focus();
}

async function saveKeyEditor() {
	if (state.operationInFlight || !keyEditor) return;
	const editor = keyEditor;
	const username = byId('access-key-name').value.trim();
	const policy = byId('access-key-form').querySelector('[name="key-permission"]:checked').value;
	const editing = Boolean(editor.username);
	const nameField = byId('access-key-name');
	nameField.setCustomValidity(
		!editing && Object.hasOwn(state.currentConfig.credentials, username)
			? 'A key already has this name. Choose a different name.'
			: ['constructor', 'prototype'].includes(username)
				? 'Choose a different name for this key.'
				: ''
	);
	if (!nameField.reportValidity()) return;
	if (
		policy === 'full' &&
		(!editing || editor.baseline.credentials[username].policy !== 'full') &&
		!window.confirm(
			`Allow apps using “${username}” to use tools, change files and carry out tasks within your agent’s permissions? Only continue for apps and people you trust.`
		)
	)
		return;
	byId('access-key-error').hidden = true;
	byId('access-key-dialog').setAttribute('aria-busy', 'true');
	for (const input of byId('access-key-form').querySelectorAll('input')) input.disabled = true;
	let result;
	try {
		result = await operation(
			editing ? 'Saving key permissions' : 'Creating access key',
			async () => {
				let saved;
				if (editing) {
					const config = structuredClone(editor.baseline);
					config.credentials[username].policy = policy;
					saved = await state.api.saveConfig({ config, baseConfig: editor.baseline });
				} else saved = await state.api.credential({ action: 'create', username, policy });
				setFormClean('access-key-form');
				return saved;
			},
			editing
				? `Permissions for “${username}” saved.`
				: `Key “${username}” created. Copy it when you are ready to connect your app.`
		);
	} finally {
		for (const input of byId('access-key-form').querySelectorAll('input')) input.disabled = false;
		byId('access-key-dialog').setAttribute('aria-busy', 'false');
	}
	if (!result) {
		setText('access-key-error', byId('notice-message').textContent);
		byId('access-key-error').hidden = false;
		return;
	}
	byId('access-key-dialog').close();
	if (editor.app) {
		if (!editing) byId(`${editor.app}-credential`).value = username;
		if (['claude', 'mcp'].includes(editor.app)) clearClientKey(editor.app);
		updateClientPolicy(editor.app);
		if (!editing && ['discord', 'slack'].includes(editor.app)) {
			state.dirtyForms.add(`${editor.app}-connections-form`);
			notice(`Key “${username}” created. Save ${appNames[editor.app]} settings to use it.`);
			byId(`${editor.app}-connections-form`).querySelector('[type="submit"]').focus();
		} else
			document
				.querySelector(
					editing ? `[data-edit-app-key="${editor.app}"]` : `[data-copy-client-key="${editor.app}"]`
				)
				.focus();
	} else
		all('[data-key-action="copy"]')
			.find((button) => button.dataset.username === username)
			?.focus();
	if (editing) await offerRestart(result);
}

export function renderMappings(snapshot) {
	for (const portal of ['discord', 'slack']) {
		const container = byId(`${portal}-mappings`);
		container.replaceChildren();
		const mappings = snapshot.portalMappings[portal]?.users || {};
		for (const [userId, username] of Object.entries(mappings)) {
			const row = document.createElement('div');
			row.className = 'mapping-row';
			const identity = document.createElement('div');
			identity.className = 'mapping-identity';
			const name = document.createElement('strong');
			name.textContent = `User ${userId}`;
			const access = document.createElement('small');
			const policy = snapshot.config.credentials[username]?.policy;
			access.textContent = `Key: ${username}${policy ? ` · ${policyLabels[policy]}` : ''}`;
			identity.append(name, access);
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'danger subtle';
			remove.textContent = 'Use app default';
			remove.dataset.removeMapping = 'true';
			remove.dataset.portal = portal;
			remove.dataset.userId = userId;
			row.append(identity, remove);
			container.append(row);
		}
		if (Object.keys(mappings).length === 0) {
			const empty = document.createElement('p');
			empty.className = 'help-text';
			empty.textContent = 'All allowed users share the bot’s key and permissions.';
			container.append(empty);
		}
	}
}

export function bindAccessEvents() {
	for (const button of all('[data-new-access-key]')) {
		button.addEventListener('click', () =>
			openKeyEditor(undefined, button.dataset.newAccessKey || undefined)
		);
	}
	for (const button of all('[data-edit-app-key]')) {
		button.addEventListener('click', () => {
			const field = byId(`${button.dataset.editAppKey}-credential`);
			if (!field.value) {
				notice('Choose an access key first, or create a new one for this app.', 'error');
				field.focus();
				return;
			}
			openKeyEditor(field.value, button.dataset.editAppKey);
		});
	}
	byId('access-key-form').addEventListener('submit', (event) => {
		event.preventDefault();
		void saveKeyEditor();
	});
	byId('access-key-form').addEventListener('change', () => {
		byId('access-key-full-warning').hidden = !byId('access-key-full').checked;
	});
	byId('access-key-name').addEventListener('input', () =>
		byId('access-key-name').setCustomValidity('')
	);
	byId('cancel-access-key').addEventListener('click', () => {
		if (!state.operationInFlight) byId('access-key-dialog').close();
	});
	byId('access-key-dialog').addEventListener('cancel', (event) => {
		if (state.operationInFlight) event.preventDefault();
	});
	byId('access-key-dialog').addEventListener('close', () => {
		keyEditor = undefined;
		setFormClean('access-key-form');
		byId('access-key-form').reset();
	});
	byId('access-keys').addEventListener('click', (event) => {
		const button = event.target.closest('[data-key-action]');
		if (!button || button.disabled || state.operationInFlight) return;
		const username = button.dataset.username;
		const action = button.dataset.keyAction;
		if (action === 'copy') void copyAccessKey(username);
		else if (action === 'edit') openKeyEditor(username);
		else if (
			action === 'replace' &&
			window.confirm(
				`Replace key “${username}”? The old key will stop working. Update every app where you pasted it with the replacement.`
			)
		)
			void operation(
				'Replacing access key',
				() => state.api.credential({ action: 'rotate', username }),
				`Key “${username}” replaced. Copy the new key into apps that used the old one.`
			);
		else if (
			action === 'revoke' &&
			window.confirm(
				`Revoke key “${username}”? Apps using it will lose access. This cannot be undone.`
			)
		)
			void operation(
				'Revoking access key',
				() => state.api.credential({ action: 'remove', username }),
				`Key “${username}” revoked.`
			);
	});

	for (const portal of ['discord', 'slack']) {
		byId(`${portal}-mapping-form`).addEventListener('submit', async (event) => {
			event.preventDefault();
			if (state.operationInFlight) return;
			const userId = byId(`${portal}-mapping-user`).value.trim();
			const username = byId(`${portal}-mapping-credential`).value || undefined;
			await operation(
				'Saving user access',
				async () => {
					const saved = await state.api.mapPortalUser({ portal, userId, username });
					setFormClean(`${portal}-mapping-form`);
					byId(`${portal}-mapping-user`).value = '';
					return saved;
				},
				username ? 'User permissions saved.' : 'User now uses the app’s default key.'
			);
		});
		byId(`${portal}-mappings`).addEventListener('click', (event) => {
			const button = event.target.closest('[data-remove-mapping]');
			if (!button || state.operationInFlight) return;
			if (
				window.confirm(
					`Use the bot’s default key and permissions for user ${button.dataset.userId}?`
				)
			) {
				void operation(
					'Removing user override',
					() => state.api.mapPortalUser({ portal, userId: button.dataset.userId }),
					'User now uses the app’s default key.'
				);
			}
		});
	}
}
