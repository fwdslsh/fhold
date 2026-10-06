import { promptVisible } from './model.js';
import { refresh } from './snapshot.js';
import { renderPhase } from './runtime.js';
import { commonProviders, state } from './state.js';
import { all, byId, notice, operation, setBadge, setOptions, setText, showView } from './ui.js';

export function providerById(id) {
	return state.providerSummaries.find((provider) => provider.id === id);
}

export function selectedProviderMethod() {
	const provider = providerById(byId('provider').value);
	const index = Number(byId('provider-method').value);
	return provider?.authMethods.find((method) => method.index === index);
}

export function updateOAuthPromptVisibility() {
	const method = selectedProviderMethod();
	if (!method?.prompts) return;
	const values = Object.fromEntries(
		all('[data-oauth-key]').map((control) => [control.dataset.oauthKey, control.value])
	);
	for (const [index, prompt] of method.prompts.entries()) {
		const field = byId(`oauth-prompt-${index}`);
		const visible = promptVisible(prompt, values);
		field.hidden = !visible;
		const control = field.querySelector('[data-oauth-key]');
		control.disabled = !visible;
		control.required = visible;
	}
}

export function renderOAuthPrompts(method) {
	const container = byId('oauth-prompt-fields');
	container.replaceChildren();
	for (const [index, prompt] of (method?.prompts || []).entries()) {
		const label = document.createElement('label');
		label.className = 'field';
		label.id = `oauth-prompt-${index}`;
		const caption = document.createElement('span');
		caption.textContent = prompt.message;
		const control = document.createElement(prompt.type === 'select' ? 'select' : 'input');
		control.id = `oauth-input-${index}`;
		control.dataset.oauthKey = prompt.key;
		if (prompt.type === 'select') {
			setOptions(control, [
				{ value: '', label: 'Choose one' },
				...prompt.options.map((option) => ({
					value: option.value,
					label: option.hint ? `${option.label} — ${option.hint}` : option.label
				}))
			]);
		} else {
			control.type = /key|secret|token|password/i.test(`${prompt.key} ${prompt.message}`)
				? 'password'
				: 'text';
			control.autocomplete = 'off';
			control.placeholder = prompt.placeholder || '';
		}
		control.addEventListener('input', updateOAuthPromptVisibility);
		control.addEventListener('change', updateOAuthPromptVisibility);
		label.append(caption, control);
		container.append(label);
	}
	updateOAuthPromptVisibility();
}

export function resetOAuthAttempt() {
	state.activeOAuth = null;
	for (const control of all('[data-oauth-key]')) control.value = '';
	byId('oauth-progress').hidden = true;
	byId('oauth-code-field').hidden = true;
	byId('oauth-code').value = '';
	byId('finish-provider-oauth').hidden = true;
	byId('provider').disabled = false;
	byId('provider-search').disabled = false;
	byId('provider-method').disabled = false;
	byId('cancel-provider-oauth').hidden = true;
	for (const button of [
		byId('show-all-providers'),
		byId('load-providers'),
		byId('test-provider'),
		byId('start-provider-oauth'),
		...all('[data-provider-id]')
	])
		button.disabled = state.operationInFlight;
}

function accountEvidence(provider) {
	if (!provider) return 'Choose an account to continue.';
	if (provider.authenticated) return 'Sign-in saved · not verified';
	if (provider.connected) return 'Available in agent · not verified';
	return 'Not signed in';
}

function providerStatus(title, detail, tone = 'neutral') {
	const status = byId('provider-status');
	status.className = `inline-status ${tone}`;
	status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
	status.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
	const heading = document.createElement('strong');
	heading.textContent = title;
	const description = document.createElement('span');
	description.textContent = detail;
	status.replaceChildren(heading, description);
}

export function renderProviderAccounts() {
	const list = byId('provider-saved-list');
	list.replaceChildren();
	const accounts = state.providerSummaries.filter(
		(provider) =>
			provider.authenticated || (provider.connected && ['env', 'config'].includes(provider.source))
	);
	for (const provider of accounts) {
		const row = document.createElement('li');
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'provider-account';
		button.dataset.providerId = provider.id;
		button.disabled = Boolean(state.activeOAuth);
		button.setAttribute('aria-pressed', String(byId('provider').value === provider.id));
		const name = document.createElement('span');
		name.className = 'provider-account-name';
		name.textContent = provider.name;
		const status = document.createElement('small');
		status.className = 'provider-account-state';
		status.textContent =
			state.lastReadiness?.ok && state.lastReadiness.provider === provider.id
				? 'Verified in this check'
				: state.lastReadiness &&
						!state.lastReadiness.ok &&
						state.lastReadinessProvider === provider.id
					? 'Last check failed'
					: accountEvidence(provider);
		button.append(name, status);
		row.append(button);
		list.append(row);
	}
	byId('provider-saved-empty').hidden = accounts.length > 0;
}

export function renderProviderSelection() {
	const provider = providerById(byId('provider').value);
	byId('provider-account-actions').hidden = !provider;
	byId('finish-provider-setup').hidden =
		!state.awaitingSetupFinish ||
		!state.lastReadiness?.ok ||
		state.lastReadinessProvider !== provider?.id;
	if (provider && state.lastReadiness && state.lastReadinessProvider === provider.id) {
		renderReadiness(state.lastReadiness);
		return;
	}
	if (!provider) {
		providerStatus(
			'Choose an AI account.',
			'Select a saved account or search for the provider you want to use.'
		);
		setBadge(byId('provider-badge'), 'Choose provider', 'neutral');
		return;
	}
	const available = provider.authenticated || provider.connected;
	providerStatus(
		provider.authenticated ? `${provider.name} sign-in is saved.` : `${provider.name} is selected.`,
		available
			? 'Verify a real response, or update this account’s sign-in below.'
			: 'Add your API key or sign in to connect this account.'
	);
	setBadge(
		byId('provider-badge'),
		provider.authenticated ? 'Sign-in saved' : 'Not verified',
		'neutral'
	);
}

export function renderProviderMethod() {
	const provider = providerById(byId('provider').value);
	const method = selectedProviderMethod();
	byId('test-provider').hidden = !provider || !(provider.authenticated || provider.connected);
	byId('provider-method-field').hidden = !provider || provider.authMethods.length < 2;
	byId('api-key-fields').hidden = method?.type !== 'api';
	const saved = provider?.authenticated === true;
	byId('api-key-fields').open = !saved && !provider?.connected;
	setText('provider-account-heading', provider ? `${provider.name} account` : 'Account sign-in');
	setText(
		'provider-account-help',
		provider
			? state.lastReadiness?.ok && state.lastReadinessProvider === provider.id
				? 'Verified a real response in this check.'
				: accountEvidence(provider)
			: ''
	);
	setText('provider-key-heading', saved ? 'Replace API key' : 'Add API key');
	setText('provider-key-submit', saved ? 'Replace key and verify' : 'Save key and verify');
	setText('start-provider-oauth', saved ? 'Sign in again' : 'Sign in with your account');
	byId('oauth-provider-note').hidden = method?.type !== 'oauth';
	if (method?.type === 'oauth') renderOAuthPrompts(method);
	renderProviderSelection();
}

export function renderProviderMethods() {
	resetOAuthAttempt();
	byId('provider-key').value = '';
	const provider = providerById(byId('provider').value);
	const methods = provider?.authMethods || [];
	setOptions(
		byId('provider-method'),
		methods.length
			? [
					{ value: '', label: 'Choose a sign-in method' },
					...methods.map((method) => ({ value: String(method.index), label: method.label }))
				]
			: [{ value: '', label: 'No sign-in method available' }]
	);
	if (methods.length) byId('provider-method').value = String(methods[0].index);
	renderProviderMethod();
	renderProviderAccounts();
}

export function renderProviderOptions() {
	const query = byId('provider-search').value.trim().toLocaleLowerCase();
	const previous = byId('provider').value;
	let visible = state.providerSummaries;
	if (query) {
		visible = state.providerSummaries.filter((provider) =>
			`${provider.name} ${provider.id}`.toLocaleLowerCase().includes(query)
		);
	} else if (!state.providerCatalogExpanded) {
		visible = state.providerSummaries.filter(
			(provider) => provider.authenticated || provider.connected || commonProviders.has(provider.id)
		);
	}
	const selected = visible.some((provider) => provider.id === previous) ? previous : '';
	setOptions(
		byId('provider'),
		[
			{ value: '', label: visible.length ? 'Choose a provider' : 'No matching providers' },
			...visible.map((provider) => ({
				value: provider.id,
				label: `${provider.name}${provider.authenticated ? ' — sign-in saved' : provider.connected ? ' — available in agent' : ''}`
			}))
		],
		selected
	);
	setText(
		'show-all-providers',
		state.providerCatalogExpanded
			? 'Show common providers'
			: `Show all ${state.providerSummaries.length} providers`
	);
	setText(
		'provider-search-help',
		query
			? visible.length
				? `${visible.length} matching ${visible.length === 1 ? 'provider' : 'providers'}. Choose one below.`
				: 'No providers match. Try another name or clear the search.'
			: state.providerCatalogExpanded
				? `${visible.length} providers available to choose from.`
				: 'Common providers are shown. Search to find any provider.'
	);
	if (previous !== selected) renderProviderMethods();
}

export function renderProviders(providers) {
	state.providerSummaries = providers
		.filter(
			(provider) => provider.authMethods.length > 0 || provider.authenticated || provider.connected
		)
		.sort((left, right) => {
			const leftReady = Number(left.authenticated || left.connected);
			const rightReady = Number(right.authenticated || right.connected);
			const leftCommon = Number(commonProviders.has(left.id));
			const rightCommon = Number(commonProviders.has(right.id));
			return (
				rightReady - leftReady || rightCommon - leftCommon || left.name.localeCompare(right.name)
			);
		});
	const previous = byId('provider').value;
	renderProviderOptions();
	if (!state.activeOAuth && previous === byId('provider').value) renderProviderMethods();
	renderProviderAccounts();
}

export function renderReadiness(result) {
	if (result.ok) {
		const provider = providerById(result.provider);
		providerStatus(
			`${provider?.name || result.provider || 'Your provider'} responded successfully.`,
			`Verified a real agent response${result.model ? ` using ${result.model}` : ''}.`,
			'success'
		);
		setBadge(byId('provider-badge'), 'Verified', 'success');
		setText('provider-account-help', 'Verified a real response in this check.');
	} else {
		providerStatus(
			state.lastReadinessAuthSaved
				? 'Sign-in saved, but the account could not respond.'
				: 'Could not verify this account.',
			result.error || 'Check the sign-in or API key and try again.',
			'error'
		);
		setBadge(byId('provider-badge'), 'Needs attention', 'error');
	}
	byId('finish-provider-setup').hidden = !state.awaitingSetupFinish || !result.ok;
}

export async function loadProviders(withNotice = true, force = false) {
	if (state.providersLoaded && !withNotice && !force) return;
	const action = async () => {
		if (!state.providerLoadPromise) {
			state.providerLoadPromise = state.api
				.providers()
				.then((providers) => {
					state.providersLoaded = true;
					renderProviders(providers);
					return providers;
				})
				.catch(() => {
					providerStatus(
						'Cannot load AI accounts.',
						'Check that your agent is running, then choose Refresh accounts.',
						'error'
					);
					setBadge(byId('provider-badge'), 'Unavailable', 'error');
					throw new Error(
						'Cannot reach your agent. Check that it is running, then refresh accounts.'
					);
				})
				.finally(() => {
					state.providerLoadPromise = undefined;
				});
		}
		return state.providerLoadPromise;
	};
	if (withNotice) await operation('Finding AI providers', action, 'Provider list updated.');
	else {
		try {
			await action();
		} catch {
			// The shared loader already renders the actionable account error.
		}
	}
}

export async function verifyProvider(progress, action, { savedAuth = false } = {}) {
	if (state.operationInFlight) return false;
	const wasSetup = state.currentSnapshot?.phase === 'setup_incomplete' || state.awaitingSetupFinish;
	state.lastReadiness = null;
	state.lastReadinessProvider = byId('provider').value;
	state.lastReadinessAuthSaved = false;
	renderProviderAccounts();
	setText('provider-account-help', 'Checking this account…');
	providerStatus('Checking this account…', 'Asking your agent for a short response.');
	setBadge(byId('provider-badge'), 'Checking', 'neutral');
	byId('finish-provider-setup').hidden = true;
	const controls = [...byId('provider-form').querySelectorAll('input, select')].map((control) => ({
		control,
		disabled: control.disabled
	}));
	for (const { control } of controls) control.disabled = true;
	let result;
	try {
		result = await operation(
			progress,
			async () => {
				const checked = await action();
				state.lastReadinessAuthSaved = savedAuth;
				return checked;
			},
			'AI account verified.'
		);
	} finally {
		for (const { control, disabled } of controls) control.disabled = disabled;
	}
	if (!state.lastReadiness) {
		providerStatus(
			'Could not update this account.',
			byId('notice-message').textContent || 'Please try again.',
			'error'
		);
		setBadge(byId('provider-badge'), 'Needs attention', 'error');
		setText('provider-account-help', accountEvidence(providerById(state.lastReadinessProvider)));
		renderProviderAccounts();
		return false;
	}
	if (savedAuth) await loadProviders(false, true);
	if (!result?.ok) {
		renderReadiness(state.lastReadiness);
		setText('provider-account-help', 'Last check failed. Update the sign-in or try again.');
		renderProviderAccounts();
		return false;
	}
	state.awaitingSetupFinish = wasSetup;
	await refresh();
	renderReadiness(result);
	renderProviderAccounts();
	return true;
}

export function bindProvidersEvents() {
	byId('load-providers').addEventListener('click', () => void loadProviders(true));
	byId('finish-provider-setup').addEventListener('click', () => {
		if (
			state.operationInFlight ||
			!state.lastReadiness?.ok ||
			state.lastReadinessProvider !== byId('provider').value
		)
			return;
		state.awaitingSetupFinish = false;
		byId('finish-provider-setup').hidden = true;
		renderPhase(state.currentSnapshot.phase);
		showView('overview', { focus: true });
	});
	byId('provider-saved-list').addEventListener('click', (event) => {
		if (state.operationInFlight || state.activeOAuth) return;
		const button = event.target.closest('[data-provider-id]');
		if (!button || !providerById(button.dataset.providerId)) return;
		byId('provider-search').value = '';
		renderProviderOptions();
		byId('provider').value = button.dataset.providerId;
		renderProviderMethods();
		byId('test-provider').focus();
	});

	byId('provider-search').addEventListener('input', () => {
		if (!state.operationInFlight && !state.activeOAuth) renderProviderOptions();
	});

	byId('show-all-providers').addEventListener('click', () => {
		if (state.operationInFlight || state.activeOAuth) return;
		state.providerCatalogExpanded = !state.providerCatalogExpanded;
		renderProviderOptions();
	});

	byId('provider').addEventListener('change', () => {
		if (!state.operationInFlight && !state.activeOAuth) renderProviderMethods();
	});

	byId('provider-method').addEventListener('change', () => {
		if (state.operationInFlight || state.activeOAuth) return;
		resetOAuthAttempt();
		renderProviderMethod();
	});

	byId('test-provider').addEventListener(
		'click',
		() =>
			void verifyProvider('Checking provider readiness', () => {
				const provider = byId('provider').value;
				if (!provider) throw new Error('Choose an AI provider first.');
				return state.api.readiness({ provider });
			})
	);

	byId('provider-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		const provider = byId('provider').value;
		const method = selectedProviderMethod();
		const key = byId('provider-key').value;
		if (!provider) {
			notice('Choose an AI provider first.', 'error', { persist: true });
			byId('provider').focus();
			return;
		}
		if (method?.type !== 'api') {
			notice('Choose an API key sign-in method first.', 'error', { persist: true });
			byId('provider-method').focus();
			return;
		}
		if (!key) {
			notice('Enter the provider API key.', 'error', { persist: true });
			byId('provider-key').focus();
			return;
		}
		await verifyProvider(
			'Saving the provider key and checking readiness',
			() => state.api.providerKey({ provider, key }),
			{ savedAuth: true }
		);
		byId('provider-key').value = '';
	});

	byId('start-provider-oauth').addEventListener('click', async () => {
		if (state.operationInFlight || state.activeOAuth) return;
		const provider = byId('provider').value;
		const method = selectedProviderMethod();
		if (!provider || method?.type !== 'oauth') {
			notice('Choose a browser sign-in method first.', 'error', { persist: true });
			return;
		}
		const inputs = {};
		for (const control of all('[data-oauth-key]:not(:disabled)')) {
			if (!control.value) {
				notice(
					`Complete “${control.closest('.field').querySelector('span').textContent}” first.`,
					'error',
					{ persist: true }
				);
				control.focus();
				return;
			}
			inputs[control.dataset.oauthKey] = control.value;
		}
		byId('provider').disabled = true;
		byId('provider-search').disabled = true;
		byId('provider-method').disabled = true;
		const result = await operation(
			'Opening provider sign-in',
			() => state.api.providerOAuthStart({ provider, method: method.index, inputs }),
			'Provider sign-in opened in your browser.'
		);
		if (!result) resetOAuthAttempt();
		if (!result) return;
		state.activeOAuth = { provider, method: method.index, mode: result.method };
		byId('provider').disabled = true;
		byId('provider-search').disabled = true;
		byId('provider-method').disabled = true;
		byId('cancel-provider-oauth').hidden = false;
		for (const button of [
			byId('show-all-providers'),
			byId('load-providers'),
			byId('test-provider'),
			byId('start-provider-oauth'),
			...all('[data-provider-id]')
		])
			button.disabled = true;
		byId('oauth-progress').hidden = false;
		setText(
			'oauth-instructions',
			result.instructions || 'Return here when the provider says you are connected.'
		);
		byId('oauth-code-field').hidden = result.method !== 'code';
		byId('finish-provider-oauth').hidden = false;
		if (result.method === 'code') byId('oauth-code').focus();
	});
	byId('cancel-provider-oauth').addEventListener('click', () => {
		if (state.operationInFlight) return;
		resetOAuthAttempt();
		renderProviderMethod();
	});

	byId('finish-provider-oauth').addEventListener('click', async () => {
		if (!state.activeOAuth) return;
		const code = byId('oauth-code').value.trim();
		if (state.activeOAuth.mode === 'code' && !code) {
			notice('Paste the authorization code from your provider.', 'error', { persist: true });
			byId('oauth-code').focus();
			return;
		}
		const verified = await verifyProvider(
			'Completing provider sign-in and checking readiness',
			() =>
				state.api.providerOAuthFinish({
					provider: state.activeOAuth.provider,
					method: state.activeOAuth.method,
					...(code ? { code } : {})
				}),
			{ savedAuth: true }
		);
		if (verified || state.lastReadinessAuthSaved) resetOAuthAttempt();
	});
}
