// Placement is the only provider-specific part of the common installation wizard.
import { state } from './state.js';
import { byId, all, notice, operation, setOptions, setText } from './ui.js';
import { refresh } from './snapshot.js';

function canRetryFailedStep(result) {
	return (
		result?.state === 'failed' &&
		['infrastructure', 'initialization', 'application'].includes(result.step) &&
		!!result.reference
	);
}

function selectedContinuation() {
	return state.installOptions?.continuations?.find(
		(item) => item.reference === byId('install-resume-reference').value
	);
}

function renderSavedRetry() {
	byId('install-retry-saved-step').hidden = !canRetryFailedStep(selectedContinuation());
}

function suggestCloudPlacement() {
	if (state.installOptions?.kind !== 'azure-container-apps') return;
	const name = byId('install-instance-name').value.trim() || 'personal-agent';
	const environment = byId('install-environment-name');
	const storage = byId('install-storage-name');
	const environmentName = `${name.slice(0, 55)}-env`;
	if (!environment.value || environment.value === environment.dataset.suggestedName)
		environment.value = environmentName;
	environment.dataset.suggestedName = environmentName;
	storage.dataset.suffix ||= crypto.randomUUID().replaceAll('-', '').slice(0, 8);
	const storageName = `fh${name.replace(/[^a-z0-9]/g, '').slice(0, 14)}${storage.dataset.suffix}`;
	if (!storage.value || storage.value === storage.dataset.suggestedName)
		storage.value = storageName;
	storage.dataset.suggestedName = storageName;
}

export function renderInstallPlacement() {
	const options = state.installOptions;
	const cloud = options?.kind === 'azure-container-apps';
	for (const id of ['install-cloud-placement', 'install-cloud-advanced']) {
		byId(id).hidden = !cloud;
		for (const input of byId(id).querySelectorAll('input,select,textarea')) input.disabled = !cloud;
	}
	byId('install-directory-placement').hidden = cloud;
	for (const input of byId('install-directory-placement').querySelectorAll('input,button'))
		input.disabled = cloud;
	byId('install-assistant-port').disabled = cloud || byId('install-automatic-ports').checked;
	byId('install-gateway-port').disabled = cloud || byId('install-automatic-ports').checked;
	byId('install-review').hidden = true;
	byId('install-continuation').hidden = true;
	byId('install-saved-continuations').hidden = true;
	byId('install-cloud-retry').hidden = !cloud;
	setText('install', cloud ? 'Review installation' : 'Install fhold');
	if (!cloud) return;
	setOptions(
		byId('install-environment'),
		[{ value: '', label: 'Create an environment' }, ...options.environments],
		''
	);
	setOptions(
		byId('install-storage'),
		[{ value: '', label: 'Create a storage account' }, ...options.storageAccounts],
		''
	);
	byId('install-region').value = options.location;
	byId('install-timezone').value = options.timezone;
	byId('install-image').value = options.image;
	byId('install-availability').value = 'always';
	byId('install-environment-name').value = '';
	byId('install-environment-name').required = true;
	byId('install-storage-name').value = '';
	byId('install-storage-name').required = true;
	byId('install-mounts').value = '';
	byId('install-cloud-confirm').checked = false;
	suggestCloudPlacement();
	const continuations = options.continuations || [];
	byId('install-saved-continuations').hidden = !continuations.length;
	setOptions(
		byId('install-resume-reference'),
		continuations.map((item) => ({
			value: item.reference,
			label: `${item.ref.resourceId?.split('/').at(-1) || item.step} · ${item.state} · ${item.step}`
		}))
	);
	renderSavedRetry();
}

export function cloudInstallRequest() {
	const environment = byId('install-environment').value;
	const storage = byId('install-storage').value;
	const mounts = byId('install-mounts')
		.value.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const match = /^(\S+)\s+(\/.*)$/.exec(line);
			if (!match)
				throw new Error(
					'Enter each shared folder as an environment storage name followed by its absolute mount path.'
				);
			return { storageName: match[1], mountPath: match[2].trim() };
		});
	return {
		kind: 'azure-container-apps',
		name: byId('install-instance-name').value.trim(),
		location: byId('install-region').value.trim(),
		environment: {
			name: environment || byId('install-environment-name').value.trim(),
			create: !environment
		},
		storage: { name: storage || byId('install-storage-name').value.trim(), create: !storage },
		availability: byId('install-availability').value,
		timezone: byId('install-timezone').value.trim(),
		image: byId('install-image').value.trim(),
		...(byId('install-cpu').value ? { cpu: Number(byId('install-cpu').value) } : {}),
		...(byId('install-memory').value.trim() ? { memory: byId('install-memory').value.trim() } : {}),
		...(mounts.length ? { mounts } : {})
	};
}

function renderPreview(preview) {
	setText('install-review-summary', preview.summary);
	setText('install-review-image', preview.image);
	const list = byId('install-review-resources');
	list.replaceChildren();
	for (const resource of preview.resources) {
		const row = document.createElement('li');
		row.textContent = `${resource.action === 'create' ? 'Create' : 'Reuse'} ${resource.type}: ${resource.name}`;
		list.append(row);
	}
	setText('install-review-warnings', preview.warnings.join('\n'));
	byId('install-review').hidden = false;
	setText('install', 'Install assistant');
	byId('install-review-title').focus();
}

async function installationResult(result) {
	if (result.state === 'completed') {
		state.installContinuation = null;
		await state.api.openInstance({ kind: 'hosted', ref: result.ref });
		state.awaitingSetupFinish = true;
		await refresh();
		notice(
			'Deployment completed. Connect your native agent and verify its AI service next.',
			'success',
			{ persist: true }
		);
		return;
	}
	state.installContinuation = result;
	byId('install-continuation').hidden = false;
	setText(
		'install-continuation-detail',
		`${result.state}: ${result.step}. ${result.message || ''} No operation will be replayed automatically. Closing setup does not delete accepted resources.`
	);
	setText(
		'install-continuation-reference',
		result.reference ||
			'No continuation reference returned. Inspect the selected connection before retrying.'
	);
	byId('install-continue').disabled = !result.reference;
	byId('install-retry-step').hidden = !canRetryFailedStep(result);
	byId('install').disabled = true;
	byId('install-review').hidden = true;
	setText('install', 'Installation requires review');
	notice(
		`${result.state}: ${result.message || result.step}`,
		result.state === 'failed' ? 'error' : 'progress',
		{ persist: true }
	);
}

export async function submitCloudInstall() {
	if (state.installContinuation) return;
	let request;
	try {
		request = cloudInstallRequest();
	} catch (error) {
		notice(error.message, 'error', { persist: true });
		return;
	}
	const connectionId = state.installConnection.id;
	const optionsAtStart = state.installOptions;
	const stillSelected = () =>
		state.installConnection?.id === connectionId && state.installOptions === optionsAtStart;
	const signature = JSON.stringify({ connectionId, request });
	if (state.installPreview?.signature !== signature) {
		const preview = await operation(
			'Reviewing installation',
			() => state.api.provisioningPreview({ connectionId, request }),
			'Review the resources and costs before installing. Nothing has been created.'
		);
		if (preview && stillSelected()) {
			state.installPreview = { signature, preview };
			renderPreview(preview);
		}
		return;
	}
	if (!byId('install-cloud-confirm').checked) {
		notice(
			'Confirm the reviewed resources and potential Azure charges before installing.',
			'error',
			{ persist: true }
		);
		byId('install-cloud-confirm').focus();
		return;
	}
	const result = await operation(
		'Installing assistant. Closing Admin stops observation, not accepted Azure work',
		() => state.api.provisioningInstall({ connectionId, request, confirmed: true }),
		'Installation result received.'
	);
	if (!stillSelected()) return;
	if (result) await installationResult(result);
	else {
		// A rejected/disconnected IPC call cannot prove that submission never happened.
		const resourceId = state.installPreview?.preview.ref.resourceId;
		state.installPreview = null;
		const options = await state.api.provisioningOptions(connectionId).catch(() => undefined);
		if (!stillSelected()) return;
		const continuation = options?.continuations?.find((item) => item.ref.resourceId === resourceId);
		await installationResult(
			continuation || {
				state: 'unknown',
				step: 'submission',
				message:
					'The installation response was lost. Reopen this connection to inspect saved progress before another attempt.'
			}
		);
	}
}

export function bindProvisioningEvents() {
	byId('install-resume-reference').addEventListener('change', renderSavedRetry);
	byId('install-instance-name').addEventListener('input', suggestCloudPlacement);
	for (const [select, field] of [
		['install-environment', 'install-environment-name'],
		['install-storage', 'install-storage-name']
	]) {
		byId(select).addEventListener('change', () => {
			byId(field).disabled = !!byId(select).value;
			byId(field).required = !byId(select).value;
		});
	}
	for (const input of all('#install-form input, #install-form select, #install-form textarea')) {
		input.addEventListener('input', () => {
			if (
				state.installOptions?.kind !== 'azure-container-apps' ||
				input.id === 'install-cloud-confirm'
			)
				return;
			state.installPreview = null;
			byId('install-cloud-confirm').checked = false;
			byId('install-review').hidden = true;
			setText('install', 'Review installation');
		});
	}
	for (const [id, saved, retry] of [
		['install-continue', false, false],
		['install-resume-saved', true, false],
		['install-retry-step', false, true],
		['install-retry-saved-step', true, true]
	]) {
		byId(id).addEventListener('click', async () => {
			if (state.operationInFlight) return;
			const reference = saved
				? byId('install-resume-reference').value
				: state.installContinuation?.reference;
			const connectionId = state.installConnection?.id;
			const optionsAtStart = state.installOptions;
			if (retry && !canRetryFailedStep(saved ? selectedContinuation() : state.installContinuation))
				return;
			if (
				!reference ||
				!window.confirm(
					retry
						? 'Retry this failed installation step? This reapplies the original deployment or restarts its initialization job and may incur Azure charges. Inspect and correct the failure before retrying.'
						: 'Inspect and continue this installation? Azure may create the remaining reviewed resources. Failed steps will not be submitted again.'
				)
			)
				return;
			const result = await operation(
				'Inspecting installation progress',
				() =>
					state.api.provisioningResume({
						connectionId,
						reference,
						confirmed: true,
						...(retry ? { retryFailedStep: true } : {})
					}),
				'Installation progress received.'
			);
			if (
				result &&
				state.installConnection?.id === connectionId &&
				state.installOptions === optionsAtStart
			)
				await installationResult(result);
		});
	}
}
