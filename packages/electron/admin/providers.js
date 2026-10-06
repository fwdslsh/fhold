import { promptVisible } from './model.js';
import { refresh } from './snapshot.js';
import { renderPhase } from './runtime.js';
import { state } from './state.js';
import { all, byId, message, notice, setBusy, setOptions, showView } from './ui.js';

const text = (id, value) => {
	if (byId(id)) byId(id).textContent = value;
};
const hide = (id, value) => {
	if (byId(id)) byId(id).hidden = value;
};
const field = (id) => byId(id)?.value || '';
const home = () => state.currentSnapshot?.homeDir;
const selectedId = () => state.providerEditor?.provider || field('provider');
const endpointPresets = {
	ollama: { name: 'Ollama', placeholder: 'http://server-address:11434/v1' },
	lmstudio: { name: 'LM Studio', placeholder: 'http://server-address:1234/v1' },
	'llama.cpp': { name: 'llama.cpp', placeholder: 'http://server-address:8080/v1' }
};

export function providerById(id) {
	return state.providerSummaries.find((provider) => provider.id === id);
}

function setStatus(id, title, detail, tone = 'neutral') {
	const status = byId(id);
	if (!status) return;
	status.hidden = false;
	status.className = `inline-status ${tone}`;
	status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
	status.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
	const heading = document.createElement('strong');
	heading.textContent = title;
	const description = document.createElement('span');
	description.textContent = detail;
	status.replaceChildren(heading, description);
}

function accountEvidence(provider) {
	const evidence = [];
	if (provider.disabled)
		evidence.push(provider.endpoint ? 'Endpoint disabled' : 'Service disabled');
	if (provider.authenticated) evidence.push('Sign-in saved');
	if (provider.configured) evidence.push('Setup saved');
	if (!evidence.length && provider.connected) evidence.push('Available in agent');
	return `${evidence.join(' · ') || 'Not set up'} · not tested`;
}

function selectedModel() {
	return byId('provider-model-manual')?.checked
		? field('provider-model-id').trim()
		: field('provider-model');
}

function testedModel(provider, model) {
	return Boolean(
		state.lastReadiness?.ok &&
			state.lastReadinessProvider === provider &&
			state.lastReadinessModel === model
	);
}

function clearTest() {
	state.lastReadiness = null;
	state.lastReadinessProvider = null;
	state.lastReadinessModel = null;
	state.lastReadinessAuthSaved = false;
	state.providerTestTarget = null;
	if (byId('use-provider-model')) byId('use-provider-model').disabled = true;
	hide('use-provider-model', true);
	const useActions = byId('use-provider-model')?.closest('.provider-use-actions');
	if (useActions) useActions.hidden = true;
	hide('finish-provider-setup', true);
}

function invalidateDraft() {
	clearTest();
	if (state.providerEditor) {
		state.providerEditor.saved = false;
		state.dirtyForms.add('provider-form');
	}
	text('provider-editor-message', 'Changes have not been saved or tested.');
	renderProviderSelection();
}

export function resetOAuthAttempt() {
	state.activeOAuth = null;
	for (const control of all('[data-oauth-key]')) control.value = '';
	hide('oauth-progress', true);
	hide('oauth-code-field', true);
	if (byId('oauth-code')) byId('oauth-code').value = '';
	hide('finish-provider-oauth', true);
	hide('cancel-provider-oauth', true);
	lockOAuthControls(false);
}

function lockOAuthControls(locked) {
	for (const control of all(
		'#provider-editor input, #provider-editor select, #provider-editor button, [data-provider-id], [data-provider-shortcut]'
	)) {
		if (
			[
				'oauth-code',
				'finish-provider-oauth',
				'cancel-provider-oauth',
				'cancel-provider-editor'
			].includes(control.id)
		)
			continue;
		control.disabled = locked;
	}
	if (!locked) updateModelControls();
}

export function resetProviderState() {
	state.providerEpoch += 1;
	state.providerCatalogEpoch += 1;
	state.providerHome = home();
	state.providerEditor = null;
	state.providerCurrentModel = undefined;
	state.providerConfigurationIssue = undefined;
	state.providerSummaries = [];
	state.providersLoaded = false;
	state.providerLoadPromise = undefined;
	state.awaitingSetupFinish = false;
	state.dirtyForms.delete('provider-form');
	clearTest();
	resetOAuthAttempt();
	for (const id of [
		'provider-key',
		'provider-endpoint-key',
		'provider-endpoint-name',
		'provider-base-url',
		'provider-endpoint-id',
		'oauth-code',
		'provider-search',
		'provider-model-id'
	]) {
		if (byId(id)) byId(id).value = '';
	}
	hide('provider-editor', true);
	hide('provider-current-model', false);
	hide('provider-saved-accounts', false);
}

function ensureInstance() {
	if (state.providerHome !== home()) resetProviderState();
}

function captureRequest() {
	return { home: home(), epoch: state.providerEpoch, editor: state.providerEditor };
}

function currentRequest(request, editor = false) {
	return (
		request.home === home() &&
		request.epoch === state.providerEpoch &&
		(!editor || request.editor === state.providerEditor)
	);
}

// Wrap provider actions locally: generic operation() treats readiness as a
// global result, before this flow can check its instance/model ownership.
async function providerOperation(progress, action, success, editor = true) {
	if (state.operationInFlight) return { ok: false };
	const request = captureRequest();
	const controls = all('#provider-editor input, #provider-editor select').map((control) => ({
		control,
		disabled: control.disabled
	}));
	setBusy(true);
	for (const { control } of controls) control.disabled = true;
	notice(`${progress}…`, 'progress', { persist: true });
	try {
		const value = await action();
		if (!currentRequest(request, editor)) return { ok: false };
		if (success) notice(success, 'success');
		else notice('');
		return { ok: true, value };
	} catch (error) {
		if (currentRequest(request, editor)) {
			const detail = message(error);
			text('provider-editor-message', detail);
			notice(detail, 'error', { persist: true });
		}
		return { ok: false };
	} finally {
		if (currentRequest(request, editor)) {
			for (const { control, disabled } of controls) control.disabled = disabled;
			setBusy(false);
			if (state.activeOAuth) lockOAuthControls(true);
			else updateModelControls();
		}
	}
}

export function selectedProviderMethod() {
	const index = Number(field('provider-method'));
	return providerById(selectedId())?.authMethods?.find((method) => method.index === index);
}

export function updateOAuthPromptVisibility() {
	const method = selectedProviderMethod();
	if (!method?.prompts) return;
	const values = Object.fromEntries(
		all('[data-oauth-key]').map((control) => [control.dataset.oauthKey, control.value])
	);
	for (const [index, prompt] of method.prompts.entries()) {
		const wrapper = byId(`oauth-prompt-${index}`);
		const visible = promptVisible(prompt, values);
		wrapper.hidden = !visible;
		const control = wrapper.querySelector('[data-oauth-key]');
		control.disabled = !visible || Boolean(state.activeOAuth);
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
		if (prompt.type === 'select')
			setOptions(control, [
				{ value: '', label: 'Choose one' },
				...prompt.options.map((option) => ({
					value: option.value,
					label: option.hint ? `${option.label} — ${option.hint}` : option.label
				}))
			]);
		else {
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

function renderCurrentModel() {
	const current = state.providerCurrentModel;
	const provider = providerById(current?.provider);
	text(
		'provider-default-service',
		current ? provider?.name || current.provider : 'No default AI service selected'
	);
	text('provider-default-model', current?.model || 'Choose a service and model to get started.');
	if (state.providerConfigurationIssue)
		setStatus(
			'provider-default-status',
			'Setup needs attention.',
			state.providerConfigurationIssue,
			'error'
		);
	else if (provider?.disabled)
		setStatus(
			'provider-default-status',
			'This endpoint is disabled.',
			'Choose another default model, or edit this endpoint to explicitly re-enable and test it.',
			'error'
		);
	else if (!current)
		setStatus(
			'provider-default-status',
			'Choose your agent’s AI.',
			'Saved sign-ins below are not necessarily the default used by your agent.'
		);
	else if (
		state.lastReadinessProvider === current.provider &&
		state.lastReadinessModel === current.model &&
		state.lastReadiness
	) {
		setStatus(
			'provider-default-status',
			state.lastReadiness.ok
				? 'This model responded in this check.'
				: 'This model could not respond.',
			state.lastReadiness.ok
				? 'Existing conversations and clients may choose another model.'
				: state.lastReadiness.error || 'Check the sign-in and try again.',
			state.lastReadiness.ok ? 'success' : 'error'
		);
	} else
		setStatus(
			'provider-default-status',
			'Default for new conversations.',
			'Not tested in this visit. Existing conversations and clients may choose another model.'
		);
	if (byId('test-current-model'))
		byId('test-current-model').disabled =
			!current || provider?.disabled || state.operationInFlight || Boolean(state.activeOAuth);
	if (byId('change-provider-model'))
		byId('change-provider-model').disabled = state.operationInFlight || Boolean(state.activeOAuth);
	const canFinish =
		state.awaitingSetupFinish && current && testedModel(current.provider, current.model);
	hide('finish-provider-setup', !canFinish);
	// The contextual statuses distinguish the current default from an unapplied candidate.
	hide('provider-badge', true);
}

export function renderProviderAccounts() {
	const list = byId('provider-saved-list');
	list.replaceChildren();
	const accounts = state.providerSummaries.filter(
		(provider) => provider.authenticated || provider.configured
	);
	for (const provider of accounts) {
		const row = document.createElement('li');
		const button = document.createElement('div');
		button.className = 'provider-account-info';
		const name = document.createElement('span');
		name.className = 'provider-account-name';
		name.textContent = provider.name;
		const evidence = document.createElement('small');
		evidence.className = 'provider-account-state';
		evidence.textContent = accountEvidence(provider);
		button.append(name, evidence);
		const actions = document.createElement('div');
		actions.className = 'button-row compact';
		for (const [kind, label] of [
			['edit', 'Edit setup'],
			...(provider.authenticated ? [['auth', 'Remove saved sign-in']] : []),
			...(provider.endpoint?.editable && !provider.disabled
				? [['endpoint', 'Disable endpoint']]
				: [])
		]) {
			const action = document.createElement('button');
			action.type = 'button';
			action.className = 'text-button';
			action.dataset.providerId = provider.id;
			action.dataset.providerAction = kind;
			action.textContent = label;
			action.setAttribute('aria-label', `${label}: ${provider.name}`);
			action.disabled = state.operationInFlight || Boolean(state.activeOAuth);
			actions.append(action);
		}
		row.append(button, actions);
		list.append(row);
	}
	hide('provider-saved-empty', accounts.length > 0);
}

function updateModelControls() {
	const editor = state.providerEditor;
	const model = selectedModel();
	const disabled = state.operationInFlight || Boolean(state.activeOAuth);
	if (byId('test-provider'))
		byId('test-provider').disabled = disabled || !editor?.provider || !model;
	text(
		'test-provider',
		editor?.endpoint && !editor.saved
			? providerById(editor.provider)?.disabled
				? 'Re-enable & test response'
				: 'Save setup & test response'
			: 'Test response'
	);
	text(
		'provider-test-cost',
		editor?.endpoint && !editor.saved
			? providerById(editor.provider)?.disabled
				? 'This saves and re-enables the endpoint, then sends a small real request that may incur a charge. It remains enabled if the response test fails. Your default model does not change.'
				: 'This saves the server setup, then sends a small real request that may incur a charge. Saved setup remains if the response test fails.'
			: 'This sends a small real request that may incur a charge. It does not change your default model.'
	);
	const saved = editor && (!editor.endpoint || editor.saved);
	if (byId('use-provider-model'))
		byId('use-provider-model').disabled =
			disabled || !editor?.provider || !model || !saved || !testedModel(editor.provider, model);
	hide(
		'use-provider-model',
		!editor?.provider || !model || !saved || !testedModel(editor.provider, model)
	);
	const useActions = byId('use-provider-model')?.closest('.provider-use-actions');
	if (useActions) useActions.hidden = byId('use-provider-model').hidden;
	hide('provider-model-id-field', !byId('provider-model-manual')?.checked);
	if (byId('provider-model'))
		byId('provider-model').disabled = disabled || Boolean(byId('provider-model-manual')?.checked);
	if (byId('load-provider-models')) byId('load-provider-models').disabled = disabled;
	renderCurrentModel();
}

export function renderProviderSelection() {
	const editor = state.providerEditor;
	if (!editor) {
		renderCurrentModel();
		return;
	}
	const model = selectedModel();
	if (
		state.lastReadiness &&
		state.lastReadinessProvider === editor.provider &&
		state.lastReadinessModel === model
	)
		renderReadiness(state.lastReadiness);
	else
		setStatus(
			'provider-status',
			model ? 'Ready to test this model.' : 'Choose a model.',
			'Test sends a short real request. Your agent’s default changes only when you choose Use this model.'
		);
	updateModelControls();
}

export function renderProviderMethod() {
	const editor = state.providerEditor;
	const provider = providerById(selectedId());
	const method = selectedProviderMethod();
	const endpoint = editor?.endpoint;
	hide('provider-endpoint-fields', !endpoint);
	hide('provider-method-field', endpoint || !provider || (provider.authMethods || []).length < 2);
	hide('api-key-fields', endpoint || method?.type !== 'api');
	hide('oauth-provider-note', endpoint || method?.type !== 'oauth');
	text(
		'provider-account-heading',
		endpoint ? 'Server details' : `${provider?.name || 'AI service'} sign-in`
	);
	text(
		'provider-account-help',
		endpoint
			? 'Enter the API address shown by your running model server.'
			: provider
				? accountEvidence(provider)
				: 'Choose a service first.'
	);
	text(
		'provider-endpoint-key-help',
		provider?.authenticated
			? 'Leave blank to keep the saved key. Enter a new key only to replace it. Existing keys are never shown.'
			: 'Only needed if your server requires authentication. Keys are stored privately in your agent.'
	);
	text('provider-key-heading', provider?.authenticated ? 'Replace API key' : 'Add API key');
	text(
		'provider-key-submit',
		provider?.authenticated ? 'Replace key & choose model' : 'Save key & choose model'
	);
	text(
		'start-provider-oauth',
		provider?.authenticated ? 'Sign in again' : 'Sign in with your account'
	);
	text('finish-provider-oauth', 'Finish sign-in & choose model');
	hide(
		'provider-details-next',
		!endpoint && !(provider?.authenticated || provider?.connected || provider?.configured)
	);
	text('provider-details-next', endpoint ? 'Choose model' : 'Keep saved setup & choose model');
	if (method?.type === 'oauth' && !endpoint) renderOAuthPrompts(method);
}

export function renderProviderMethods() {
	resetOAuthAttempt();
	if (byId('provider-key')) byId('provider-key').value = '';
	const methods = providerById(selectedId())?.authMethods || [];
	setOptions(
		byId('provider-method'),
		methods.length
			? methods.map((method) => ({ value: String(method.index), label: method.label }))
			: [{ value: '', label: 'No sign-in method available' }]
	);
	renderProviderMethod();
}

export function renderProviderOptions() {
	const query = field('provider-search').trim().toLocaleLowerCase();
	const previous = field('provider');
	const visible = state.providerSummaries.filter((provider) =>
		`${provider.name} ${provider.id}`.toLocaleLowerCase().includes(query)
	);
	setOptions(
		byId('provider'),
		[
			{ value: '', label: visible.length ? 'Choose a service' : 'No matching services' },
			...visible.map((provider) => ({
				value: provider.id,
				label: `${provider.name}${provider.disabled ? ' (disabled)' : ''}`
			}))
		],
		visible.some((provider) => provider.id === previous) ? previous : ''
	);
	text(
		'provider-search-help',
		query
			? visible.length
				? `${visible.length} matching services.`
				: 'No services match. Try another name or clear the search.'
			: 'Search all services reported by your agent.'
	);
	if (previous && previous !== field('provider') && state.providerEditor?.other) {
		state.providerEditor.provider = '';
		clearTest();
		renderProviderMethods();
	}
}

export function renderProviders(settings) {
	ensureInstance();
	// Returned effective settings supersede any older, pre-edit catalog read.
	state.providerCatalogEpoch += 1;
	state.providerLoadPromise = undefined;
	state.providerSummaries = (settings.providers || [])
		.slice()
		.sort((left, right) => left.name.localeCompare(right.name));
	state.providerCurrentModel = settings.currentModel;
	state.providerConfigurationIssue = settings.configurationIssue;
	if (
		state.lastReadiness &&
		(state.providerConfigurationIssue || providerById(state.lastReadinessProvider)?.disabled)
	)
		clearTest();
	state.providersLoaded = true;
	renderProviderOptions();
	renderProviderAccounts();
	updateModelControls();
}

export async function loadProviders(withNotice = true, force = false) {
	ensureInstance();
	if (state.providersLoaded && !withNotice && !force) return;
	if (state.activeOAuth) return;
	if (state.providerLoadPromise && !force) return state.providerLoadPromise;
	if (force) clearTest();
	const request = { home: home(), epoch: ++state.providerCatalogEpoch };
	const ownsCatalog = () => request.home === home() && request.epoch === state.providerCatalogEpoch;
	const promise = state.api
		.providers()
		.then((settings) => {
			if (!ownsCatalog()) return;
			renderProviders(settings);
			if (withNotice) notice('AI setup list refreshed. No response test was run.', 'success');
			return settings;
		})
		.catch(() => {
			if (ownsCatalog()) {
				setStatus(
					'provider-default-status',
					'Cannot load AI settings.',
					'Check that your agent is running, then refresh the setup list.',
					'error'
				);
				if (withNotice)
					notice(
						'Cannot reach your agent. Check that it is running, then refresh the setup list.',
						'error',
						{ persist: true }
					);
			}
		})
		.finally(() => {
			if (state.providerLoadPromise === promise) state.providerLoadPromise = undefined;
		});
	state.providerLoadPromise = promise;
	return promise;
}

function showEditorStage(stage, focus = true) {
	if (!state.providerEditor) return;
	state.providerEditor.stage = stage;
	hide('provider-service-step', stage !== 'service');
	hide('provider-account-actions', stage !== 'details');
	hide('provider-model-step', stage !== 'model');
	hide('provider-editor-back', stage === 'service');
	if (stage === 'details') renderProviderMethod();
	if (stage === 'model') renderModels();
	if (focus)
		byId(
			stage === 'model'
				? 'provider-model'
				: stage === 'details'
					? 'provider-account-heading'
					: 'provider-editor-title'
		)?.focus();
}

function renderModels() {
	const editor = state.providerEditor;
	if (!editor) return;
	const previous = selectedModel();
	const models = editor.discoveredModels || providerById(editor.provider)?.models || [];
	setOptions(
		byId('provider-model'),
		[
			{ value: '', label: 'Choose a model' },
			...models.map((model) => ({
				value: model.id,
				label: model.name === model.id ? model.name : `${model.name} (${model.id})`
			}))
		],
		previous
	);
	const manual = models.length === 0;
	if (manual) byId('provider-model-manual').checked = true;
	text(
		'provider-model-help',
		models.length
			? editor.discoveredModels
				? 'These model IDs were reported by your server. Choose a model that supports text conversations and agent tools.'
				: 'These models support text and agent tools according to your agent’s native configuration.'
			: 'Load models from your server, or enter its exact model ID. Choose a model that supports text conversations and agent tools.'
	);
	text(
		'load-provider-models',
		editor.endpoint ? 'Load models from server' : 'Refresh model choices'
	);
	text(
		'provider-use-help',
		'Testing does not change your agent. Use this model explicitly to set the default for new conversations.'
	);
	renderProviderSelection();
}

export function closeProviderEditor({ focus = true, preserveTest = false } = {}) {
	state.providerEpoch += 1;
	resetOAuthAttempt();
	state.providerEditor = null;
	state.dirtyForms.delete('provider-form');
	if (!preserveTest) clearTest();
	for (const id of [
		'provider-key',
		'provider-endpoint-key',
		'provider-endpoint-name',
		'provider-base-url',
		'provider-endpoint-id',
		'oauth-code',
		'provider-search',
		'provider-model-id'
	])
		if (byId(id)) byId(id).value = '';
	hide('provider-editor', true);
	hide('provider-current-model', false);
	hide('provider-saved-accounts', false);
	text('provider-editor-message', '');
	renderCurrentModel();
	if (focus) byId('change-provider-model')?.focus();
}

export function openProviderEditor(kind = 'add', id = '') {
	if (state.operationInFlight || state.activeOAuth) return;
	ensureInstance();
	closeProviderEditor({ focus: false });
	const provider = providerById(id);
	state.providerEditor = {
		kind,
		provider: id,
		endpoint: Boolean(provider?.endpoint?.editable),
		saved: !provider?.disabled,
		other: false,
		stage: 'service'
	};
	hide('provider-editor', false);
	hide('provider-current-model', true);
	hide('provider-saved-accounts', true);
	text(
		'provider-editor-title',
		kind === 'edit'
			? `Edit ${provider?.name || 'saved setup'}`
			: kind === 'change'
				? 'Change your agent’s AI'
				: 'Add an AI service'
	);
	text(
		'provider-editor-message',
		provider?.disabled
			? 'This endpoint is disabled. Re-enable & test response saves its setup and enables it again, but does not change your default model. Its saved sign-in is kept.'
			: kind === 'edit'
				? 'Edits update this saved service’s connection settings. Choosing a different default model still requires Use this model.'
				: 'Your default model choice stays unchanged until you choose Use this model.'
	);
	byId('provider-model-manual').checked = false;
	setOptions(byId('provider-model'), [{ value: '', label: 'Choose a model' }]);
	if (provider?.endpoint?.editable)
		fillEndpoint(id, provider.endpoint.name, provider.endpoint.url, true);
	if (id) {
		renderProviderOptions();
		byId('provider').value = id;
		renderProviderMethods();
		if (kind === 'change' && provider?.models?.length) showEditorStage('model');
		else showEditorStage('details');
	} else showEditorStage('service');
}

function fillEndpoint(id, name, url, editing = false) {
	byId('provider-endpoint-id').value = id;
	byId('provider-endpoint-id').readOnly = editing;
	byId('provider-endpoint-name').value = name;
	byId('provider-base-url').value = url;
	byId('provider-endpoint-key').value = '';
	hide('provider-endpoint-id-field', Boolean(endpointPresets[id]));
	hide('provider-endpoint-advanced', Boolean(endpointPresets[id]));
}

function chooseShortcut(id) {
	if (state.operationInFlight || state.activeOAuth || !state.providerEditor) return;
	clearTest();
	byId('provider-key').value = '';
	byId('provider-endpoint-key').value = '';
	byId('provider-model-id').value = '';
	byId('provider-model-manual').checked = false;
	setOptions(byId('provider-model'), [{ value: '', label: 'Choose a model' }]);
	const editor = state.providerEditor;
	editor.other = id === 'other';
	editor.endpoint = Boolean(endpointPresets[id]) || id === 'custom';
	editor.provider = editor.other ? '' : id;
	editor.saved = !editor.endpoint;
	editor.discoveredModels = undefined;
	hide('provider-catalog', !editor.other);
	if (editor.other) {
		renderProviderOptions();
		byId('provider-search').focus();
		return;
	}
	if (editor.endpoint) {
		const preset = endpointPresets[id];
		const baseId = preset ? (providerById(id) ? `${id}-server` : id) : 'custom';
		let customId = baseId;
		for (let suffix = 2; providerById(customId); suffix += 1) customId = `${baseId}-${suffix}`;
		editor.provider = customId;
		fillEndpoint(editor.provider, preset?.name || '', '');
		hide('provider-endpoint-id-field', Boolean(preset));
		hide('provider-endpoint-advanced', Boolean(preset));
		byId('provider-base-url').placeholder = preset?.placeholder || 'https://server-address/v1';
	} else if (!providerById(id)) {
		text(
			'provider-editor-message',
			'This service is not reported by your agent. Choose Other to search its native service list.'
		);
		return;
	}
	renderProviderOptions();
	byId('provider').value = editor.provider;
	renderProviderMethods();
	showEditorStage('details');
}

export function renderReadiness(result) {
	const target = state.providerTestTarget;
	if (
		!target ||
		state.lastReadinessProvider !== target.provider ||
		state.lastReadinessModel !== target.model
	)
		return;
	const id = target.current ? 'provider-default-status' : 'provider-status';
	setStatus(
		id,
		result.ok ? 'This model responded successfully.' : 'This model could not respond.',
		result.ok
			? `Tested ${target.model} in this visit. Testing alone does not change the default.`
			: result.error || 'Check the saved setup and try again.',
		result.ok ? 'success' : 'error'
	);
	if (!target.current && state.providerEditor?.provider === target.provider) {
		const alreadyDefault =
			state.providerCurrentModel?.provider === target.provider &&
			state.providerCurrentModel?.model === target.model;
		text(
			'provider-editor-message',
			result.ok
				? alreadyDefault
					? 'This model responded in this check. It is already your default model.'
					: 'This model responded in this check. Choose Use this model to make it your default.'
				: state.providerEditor.endpoint && state.providerEditor.saved
					? 'Endpoint setup is saved and enabled, but the response test failed. Check the setup and try again. Testing did not change your default model.'
					: 'The response test failed. Check the setup and try again. Testing did not change your default model.'
		);
	}
	updateModelControls();
}

export async function verifyProvider(
	progress,
	action,
	{ provider = selectedId(), model = selectedModel(), current = false } = {}
) {
	if (!provider || !model || state.operationInFlight || state.activeOAuth) return false;
	const wasSetup = state.currentSnapshot?.phase === 'setup_incomplete' || state.awaitingSetupFinish;
	clearTest();
	state.lastReadinessProvider = provider;
	state.lastReadinessModel = model;
	state.providerTestTarget = { provider, model, current };
	const target = state.providerTestTarget;
	setStatus(
		current ? 'provider-default-status' : 'provider-status',
		'Testing response…',
		`Asking ${model} for a short real response.`
	);
	const request = captureRequest();
	const outcome = await providerOperation(progress, action, undefined, !current);
	if (!currentRequest(request, !current) || state.providerTestTarget !== target) return false;
	state.lastReadiness = outcome.ok
		? outcome.value
		: {
				ok: false,
				error:
					field('notice-message') ||
					byId('notice-message')?.textContent ||
					'The response test failed. Try again.'
			};
	if (
		state.lastReadiness?.ok &&
		(state.lastReadiness.provider !== provider || state.lastReadiness.model !== model)
	)
		state.lastReadiness = {
			ok: false,
			error: 'Your agent returned a different model. The selected model was not verified.'
		};
	if (state.lastReadiness?.ok) {
		state.awaitingSetupFinish = wasSetup;
		await refresh();
	}
	if (!currentRequest(request, !current) || state.providerTestTarget !== target) return false;
	renderReadiness(state.lastReadiness);
	return state.lastReadiness?.ok === true;
}

async function saveKey() {
	const provider = selectedId();
	const key = field('provider-key');
	if (!provider || selectedProviderMethod()?.type !== 'api' || !key) {
		notice('Choose an API-key service and enter its key first.', 'error', { persist: true });
		byId('provider-key').focus();
		return;
	}
	clearTest();
	const request = captureRequest();
	const outcome = await providerOperation(
		'Saving sign-in',
		() => state.api.providerKey({ provider, key }),
		'Sign-in saved. Choose a model, then test its response.'
	);
	if (!currentRequest(request, true)) return;
	byId('provider-key').value = '';
	if (!outcome.ok) return;
	const settings = await loadProviders(false, true);
	if (!settings || state.providerEditor?.provider !== provider) return;
	state.providerEditor.saved = true;
	state.dirtyForms.delete('provider-form');
	text('provider-editor-message', 'Sign-in saved. It has not been response-tested.');
	showEditorStage('model');
}

async function loadModels() {
	const editor = state.providerEditor;
	if (!editor?.endpoint) {
		await loadProviders(true, true);
		renderModels();
		return;
	}
	const url = field('provider-base-url').trim();
	const key = field('provider-endpoint-key');
	if (!url) {
		notice('Enter the server address before loading its models.', 'error', { persist: true });
		return;
	}
	const outcome = await providerOperation(
		'Loading server models',
		() => state.api.providerModels({ url, ...(key ? { key } : {}) }),
		undefined
	);
	if (!outcome.ok) return;
	editor.discoveredModels = outcome.value.map((id) => ({ id, name: id }));
	if (editor.discoveredModels.length) byId('provider-model-manual').checked = false;
	text(
		'provider-editor-message',
		editor.discoveredModels.length
			? 'Models loaded. Setup is saved only when you test the selected model.'
			: 'Your server reported no models. You can enter an exact model ID instead.'
	);
	renderModels();
}

async function testSelectedModel() {
	const editor = state.providerEditor;
	if (!editor || byId('test-provider').disabled) return;
	const provider = selectedId();
	const model = selectedModel();
	const endpoint = editor.endpoint && !editor.saved;
	const payload = endpoint
		? {
				provider,
				name: field('provider-endpoint-name').trim(),
				url: field('provider-base-url').trim(),
				model,
				...(field('provider-endpoint-key') ? { key: field('provider-endpoint-key') } : {})
			}
		: undefined;
	const request = captureRequest();
	if (payload)
		text(
			'provider-editor-message',
			providerById(provider)?.disabled
				? 'This will save and re-enable the endpoint, then test a short response. It remains enabled if the response fails.'
				: 'This will save the endpoint setup, then test a short response. The setup remains saved if the response fails.'
		);
	await verifyProvider(
		endpoint ? 'Saving setup and testing response' : 'Testing model response',
		async () => {
			if (payload) {
				const settings = await state.api.providerEndpoint(payload);
				if (!currentRequest(request, true))
					throw new Error('Setup changed before the response test.');
				byId('provider-endpoint-key').value = '';
				renderProviders(settings);
				if (!providerById(provider) || providerById(provider).disabled)
					throw new Error(
						'Your agent did not confirm this endpoint as enabled. Review its settings before testing.'
					);
				editor.saved = true;
				state.dirtyForms.delete('provider-form');
				text(
					'provider-editor-message',
					'Endpoint setup saved. It stays saved even if this response test fails.'
				);
			}
			return state.api.readiness({ provider, model });
		},
		{ provider, model }
	);
}

async function removeProvider(id, endpoint) {
	if (state.operationInFlight || state.activeOAuth) return;
	const provider = providerById(id);
	if (!provider) return;
	const isDefault = state.providerCurrentModel?.provider === id;
	if (isDefault) {
		notice(
			endpoint
				? 'Choose another default model before disabling this endpoint.'
				: 'Choose another default model before removing this service’s saved sign-in.',
			'error',
			{ persist: true }
		);
		return;
	}
	const prompt = endpoint
		? `Disable the ${provider.name} endpoint in this instance? Its definition and saved sign-in are kept. You can edit its setup to re-enable and test it. This does not revoke your vendor account.`
		: `Remove the saved sign-in for ${provider.name} from this instance? This does not revoke your vendor account or remove endpoint/environment configuration.`;
	if (!window.confirm(prompt)) return;
	clearTest();
	const outcome = await providerOperation(
		endpoint ? 'Disabling endpoint' : 'Removing saved sign-in',
		() => state.api.providerRemove({ provider: id, ...(endpoint ? { endpoint: true } : {}) }),
		endpoint
			? 'Endpoint disabled. Its definition and saved sign-in are kept.'
			: 'Saved sign-in removed. The vendor account was not revoked.',
		false
	);
	if (!outcome.ok) return;
	closeProviderEditor({ focus: false });
	renderProviders(outcome.value);
	byId('load-providers').focus();
}

export function bindProvidersEvents() {
	const on = (id, event, handler) => byId(id)?.addEventListener(event, handler);
	on('load-providers', 'click', () => void loadProviders(true, true));
	on('add-provider-service', 'click', () => openProviderEditor('add'));
	on('change-provider-model', 'click', () =>
		openProviderEditor('change', state.providerCurrentModel?.provider || '')
	);
	on('cancel-provider-editor', 'click', () => {
		if (!state.operationInFlight) closeProviderEditor();
	});
	on('provider-editor-back', 'click', () => {
		if (state.operationInFlight || state.activeOAuth) return;
		clearTest();
		showEditorStage(state.providerEditor?.stage === 'model' ? 'details' : 'service');
	});
	for (const button of all('[data-provider-shortcut]'))
		button.addEventListener('click', () => chooseShortcut(button.dataset.providerShortcut));
	on('provider-saved-list', 'click', (event) => {
		const button = event.target.closest('[data-provider-id]');
		if (!button) return;
		if (button.dataset.providerAction === 'auth' || button.dataset.providerAction === 'endpoint')
			void removeProvider(button.dataset.providerId, button.dataset.providerAction === 'endpoint');
		else openProviderEditor('edit', button.dataset.providerId);
	});
	on('provider-search', 'input', () => {
		if (!state.operationInFlight && !state.activeOAuth) renderProviderOptions();
	});
	on('show-all-providers', 'click', () => {
		if (!state.operationInFlight && !state.activeOAuth) {
			byId('provider-search').value = '';
			renderProviderOptions();
		}
	});
	on('provider', 'change', () => {
		if (state.operationInFlight || state.activeOAuth || !state.providerEditor) return;
		state.providerEditor.provider = field('provider');
		state.providerEditor.endpoint = Boolean(providerById(selectedId())?.endpoint?.editable);
		state.providerEditor.saved = !providerById(selectedId())?.disabled;
		state.providerEditor.discoveredModels = undefined;
		byId('provider-model-id').value = '';
		byId('provider-model-manual').checked = false;
		setOptions(byId('provider-model'), [{ value: '', label: 'Choose a model' }]);
		const endpoint = providerById(selectedId())?.endpoint;
		if (endpoint?.editable) fillEndpoint(selectedId(), endpoint.name, endpoint.url, true);
		clearTest();
		renderProviderMethods();
		if (selectedId()) showEditorStage('details');
	});
	on('provider-method', 'change', () => {
		if (!state.operationInFlight && !state.activeOAuth) {
			resetOAuthAttempt();
			clearTest();
			renderProviderMethod();
		}
	});
	on('provider-form', 'submit', (event) => {
		event.preventDefault();
		if (state.operationInFlight || state.activeOAuth || state.providerEditor?.stage !== 'details')
			return;
		if (state.providerEditor.endpoint) byId('provider-details-next').click();
		else void saveKey();
	});
	on('provider-details-next', 'click', () => {
		if (state.operationInFlight || state.activeOAuth || !state.providerEditor) return;
		if (state.providerEditor.endpoint) {
			const provider = field('provider-endpoint-id').trim();
			if (
				!provider ||
				!field('provider-endpoint-name').trim() ||
				!field('provider-base-url').trim()
			) {
				notice(
					'Complete the service name and server address first. Custom services also need an ID under Advanced.',
					'error',
					{ persist: true }
				);
				return;
			}
			state.providerEditor.provider = provider;
		}
		showEditorStage('model');
	});
	for (const id of [
		'provider-key',
		'provider-endpoint-id',
		'provider-endpoint-name',
		'provider-base-url',
		'provider-endpoint-key'
	])
		on(id, 'input', () => {
			if (!state.operationInFlight && !state.activeOAuth) invalidateDraft();
		});
	on('provider-model', 'change', () => {
		if (!state.operationInFlight && !state.activeOAuth) {
			clearTest();
			if (state.providerEditor?.endpoint) state.providerEditor.saved = false;
			renderProviderSelection();
		}
	});
	on('provider-model-manual', 'change', () => {
		if (!state.operationInFlight && !state.activeOAuth) {
			clearTest();
			if (state.providerEditor?.endpoint) state.providerEditor.saved = false;
			renderProviderSelection();
		}
	});
	on('provider-model-id', 'input', () => {
		if (!state.operationInFlight && !state.activeOAuth) invalidateDraft();
	});
	on('load-provider-models', 'click', () => {
		if (!state.operationInFlight && !state.activeOAuth) void loadModels();
	});
	on('test-provider', 'click', () => void testSelectedModel());
	on('test-current-model', 'click', () => {
		const current = state.providerCurrentModel;
		if (!current || state.operationInFlight || state.activeOAuth) return;
		void verifyProvider('Testing current model response', () => state.api.readiness(current), {
			...current,
			current: true
		});
	});
	on('use-provider-model', 'click', async () => {
		const provider = selectedId();
		const model = selectedModel();
		if (byId('use-provider-model').disabled || !testedModel(provider, model)) return;
		const request = captureRequest();
		const outcome = await providerOperation('Changing your agent’s default model', () =>
			state.api.providerUse({ provider, model })
		);
		if (!outcome.ok) return;
		renderProviders(outcome.value);
		if (
			state.providerCurrentModel?.provider !== provider ||
			state.providerCurrentModel?.model !== model ||
			state.providerConfigurationIssue ||
			providerById(provider)?.disabled
		) {
			clearTest();
			text(
				'provider-editor-message',
				'Your agent did not confirm this model as its default. Review its current settings and test again.'
			);
			notice('Your agent did not confirm the selected default model.', 'error', { persist: true });
			renderProviderSelection();
			return;
		}
		notice(
			'Default model changed. Existing conversations may keep their selected model.',
			'success'
		);
		text('provider-editor-message', 'This is now your default model for new conversations.');
		await refresh();
		if (!currentRequest(request, true)) return;
		closeProviderEditor({ preserveTest: true });
	});
	on('finish-provider-setup', 'click', () => {
		const current = state.providerCurrentModel;
		if (state.operationInFlight || !current || !testedModel(current.provider, current.model))
			return;
		state.awaitingSetupFinish = false;
		hide('finish-provider-setup', true);
		renderPhase(state.currentSnapshot.phase);
		showView('overview', { focus: true });
	});
	on('start-provider-oauth', 'click', async () => {
		if (state.operationInFlight || state.activeOAuth) return;
		const provider = selectedId();
		const method = selectedProviderMethod();
		if (!provider || method?.type !== 'oauth') return;
		const inputs = {};
		for (const control of all('[data-oauth-key]:not(:disabled)')) {
			if (!control.value) {
				notice('Complete the sign-in fields first.', 'error', { persist: true });
				control.focus();
				return;
			}
			inputs[control.dataset.oauthKey] = control.value;
		}
		clearTest();
		const outcome = await providerOperation(
			'Opening provider sign-in',
			() => state.api.providerOAuthStart({ provider, method: method.index, inputs }),
			'Sign-in opened. Finish it here before choosing a model.'
		);
		if (!outcome.ok) return;
		const result = outcome.value;
		state.activeOAuth = { provider, method: method.index, mode: result.method };
		lockOAuthControls(true);
		hide('cancel-provider-oauth', false);
		hide('oauth-progress', false);
		text(
			'oauth-instructions',
			result.instructions || 'Return here when your provider finishes sign-in.'
		);
		hide('oauth-code-field', result.method !== 'code');
		hide('finish-provider-oauth', false);
		if (result.method === 'code') byId('oauth-code').focus();
	});
	on('cancel-provider-oauth', 'click', () => {
		if (!state.operationInFlight) {
			resetOAuthAttempt();
			renderProviderMethod();
		}
	});
	on('finish-provider-oauth', 'click', async () => {
		if (!state.activeOAuth || state.operationInFlight) return;
		const attempt = state.activeOAuth;
		const code = field('oauth-code').trim();
		if (attempt.mode === 'code' && !code) {
			notice('Paste your provider’s authorization code first.', 'error', { persist: true });
			byId('oauth-code').focus();
			return;
		}
		const outcome = await providerOperation(
			'Saving provider sign-in',
			() =>
				state.api.providerOAuthFinish({
					provider: attempt.provider,
					method: attempt.method,
					...(code ? { code } : {})
				}),
			'Sign-in saved. Choose a model, then test its response.'
		);
		if (!outcome.ok) return;
		resetOAuthAttempt();
		const settings = await loadProviders(false, true);
		if (!settings || state.providerEditor?.provider !== attempt.provider) return;
		state.providerEditor.saved = true;
		state.dirtyForms.delete('provider-form');
		text('provider-editor-message', 'Sign-in saved. No response test has been run.');
		showEditorStage('model');
	});
}
