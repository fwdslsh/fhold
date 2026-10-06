import { loadProviders } from './providers.js';
import { refresh } from './snapshot.js';
import { state } from './state.js';
import { checkInstallationReadiness, renderInstallationReadiness } from './instances.js';
import { all, byId, message, notice, operation, setBadge, setBusy, setSkipTarget, setText } from './ui.js';

export function restoreInput(apply) {
	return {
		sourceHome: byId('restore-source').value.trim(),
		apply,
		...(apply ? { acknowledgeUnrestored: byId('restore-acknowledge').checked } : {}),
		...(apply && state.restorePreviewDigest ? { previewDigest: state.restorePreviewDigest } : {}),
		includeProviderAuth: byId('restore-auth').checked,
		includeUserEnv: byId('restore-env').checked,
		includePortalMaps: byId('restore-maps').checked,
		includeOAuth: byId('restore-maps').checked
	};
}

export function restoreSignature() {
	return JSON.stringify(restoreInput(false));
}

export function invalidateRestorePreview() {
	state.restorePreviewSignature = null;
	state.restorePreviewDigest = null;
	byId('apply-restore').disabled = true;
	byId('restore-acknowledge').checked = false;
}

export function renderRestorePlan(result, applied) {
	byId('data-result').value = JSON.stringify(result, null, 2);
	const summary = byId('restore-summary');
	summary.replaceChildren();
	const title = document.createElement('strong');
	const detail = document.createElement('span');
	if (applied) {
		title.textContent = 'Imported portable files verified.';
		detail.textContent = `${result.copyCount} items copied. This does not restore native conversations, remote sign-ins or other unselected state. Tasks remain inactive.`;
		summary.className = 'inline-status success';
	} else if (result.conflicts > 0) {
		title.textContent = `Import preview found ${result.conflicts} conflict${result.conflicts === 1 ? '' : 's'}.`;
		detail.textContent = 'Choose a fresh destination or resolve the conflicts before applying.';
		summary.className = 'inline-status error';
	} else {
		title.textContent = `${result.copyCount} item${result.copyCount === 1 ? '' : 's'} ready to import.`;
		detail.textContent = result.warnings.length
			? `${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'} need review.`
			: 'No conflicts or warnings were found.';
		summary.className = 'inline-status success';
	}
	summary.append(title, detail);
	const inventory = byId('restore-preservation');
	inventory.replaceChildren();
	for (const item of result.preservation) {
		const row = document.createElement('details');
		row.className = 'disclosure preservation-row';
		const heading = document.createElement('summary');
		const name = document.createElement('span');
		name.textContent = item.category;
		const badge = document.createElement('span');
		setBadge(
			badge,
			item.disposition === 'selected'
				? 'Selected'
				: item.disposition === 'review-required'
					? 'Separate recovery'
					: 'Not included',
			item.disposition === 'selected' ? 'success' : 'neutral'
		);
		heading.append(name, badge);
		const note = document.createElement('p');
		note.className = 'help-text';
		note.textContent = item.note;
		row.append(heading, note);
		inventory.append(row);
	}
	byId('restore-acknowledge-row').hidden = !result.reviewRequired || applied;
}

export async function chooseDirectory(purpose, inputId) {
	if (state.operationInFlight) return;
	setBusy(true);
	try {
		const selected = await state.api.chooseDirectory({ purpose });
		if (!selected) return;
		byId(inputId).value = selected;
		byId(inputId).dispatchEvent(new Event('input', { bubbles: true }));
		byId(inputId).focus();
	} catch (error) {
		notice(message(error), 'error', { persist: true });
	} finally {
		setBusy(false);
	}
}

export function updateBackupScope() {
	const full = byId('backup-scope').value === 'instance';
	byId('backup-sensitive-options').hidden = full;
	byId('backup-full-help').hidden = !full;
	byId('export-backup').textContent = full ? 'Export entire instance' : 'Export portable content';
}

export function invalidateInstanceRestorePreview() {
	state.instanceRestorePreview = null;
	byId('apply-instance-restore').disabled = true;
	showInstanceImportStep(false);
}

function showInstanceImportStep(reviewing) {
	byId('instance-import-choices').hidden = reviewing;
	byId('instance-import-review').hidden = !reviewing;
	byId('instance-restore-back').hidden = !reviewing;
	for (const [index, step] of all('#instance-import-progress li').entries()) {
		const complete = reviewing && index === 0;
		step.classList.toggle('complete', complete);
		step.setAttribute('aria-current', index === (reviewing ? 1 : 0) ? 'step' : 'false');
		step.querySelector('span').textContent = complete ? '✓' : String(index + 1);
	}
	renderInstallationReadiness(state.installationReadiness);
}

export function renderInstanceRestorePlan(result) {
	byId('instance-restore-result').value = JSON.stringify(result, null, 2);
	setText('instance-restore-name', result.projectName);
	setText('instance-restore-review-source', result.sourceHome);
	setText('instance-restore-review-home', result.destinationHome);
	setText('instance-restore-summary', `${result.copyCount.toLocaleString()} files, folders and links, including conversations, files, permissions and plugins.`);
	const warnings = byId('instance-restore-warnings');
	warnings.replaceChildren();
	for (const warning of result.warnings) {
		const item = document.createElement('li');
		item.textContent = warning;
		warnings.append(item);
	}
	warnings.hidden = result.warnings.length === 0;
}

export function bindInstanceRestoreEvents() {
	byId('begin-instance-import').addEventListener('click', () => {
		if (state.operationInFlight) return;
		invalidateInstanceRestorePreview();
		byId('instance-welcome').hidden = true;
		byId('install-section').hidden = true;
		byId('instance-import-section').hidden = false;
		byId('instance-restore-home').placeholder = `${state.instancesDirectory}/restored-agent`;
		document.body.dataset.phase = 'instance_import';
		setSkipTarget('instance-import-section');
		notice('');
		byId('instance-restore-source').focus();
		if (!state.installationReadiness?.ok) void checkInstallationReadiness();
	});
	byId('instance-restore-back').addEventListener('click', () => {
		if (state.operationInFlight) return;
		invalidateInstanceRestorePreview();
		notice('');
		byId('instance-restore-source').focus();
	});
	byId('choose-instance-restore-source').addEventListener('click', () => void chooseDirectory('restore', 'instance-restore-source'));
	byId('choose-instance-restore-home').addEventListener('click', () => void chooseDirectory('new-instance', 'instance-restore-home'));
	for (const id of ['instance-restore-source', 'instance-restore-home'])
		for (const event of ['input', 'change']) byId(id).addEventListener(event, invalidateInstanceRestorePreview);
	byId('instance-restore-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (state.operationInFlight || byId('instance-import-section').hidden) return;
		invalidateInstanceRestorePreview();
		if (!byId('instance-restore-form').reportValidity()) return;
		const sourceHome = byId('instance-restore-source').value.trim();
		const targetHome = byId('instance-restore-home').value.trim();
		const result = await operation('Previewing entire instance', async () => {
			await state.api.prepareNewInstance({ kind: 'local', homeDir: targetHome });
			return state.api.restoreInstance({ sourceHome });
		}, 'Full-instance preview is ready. Review before importing.');
		if (!result) return;
		if (sourceHome !== byId('instance-restore-source').value.trim() || targetHome !== byId('instance-restore-home').value.trim()) {
			notice('The folder choices changed. Review them again before importing.', 'error', { persist: true });
			return;
		}
		renderInstanceRestorePlan(result);
		state.instanceRestorePreview = { sourceHome, targetHome, digest: result.digest };
		showInstanceImportStep(true);
		notice('');
		byId('instance-restore-review-title').focus();
	});
	byId('apply-instance-restore').addEventListener('click', async () => {
		if (state.operationInFlight || byId('instance-import-review').hidden || byId('instance-import-section').hidden) return;
		const preview = state.instanceRestorePreview;
		const sourceHome = byId('instance-restore-source').value.trim();
		if (!preview || preview.sourceHome !== sourceHome || preview.targetHome !== byId('instance-restore-home').value.trim()) {
			invalidateInstanceRestorePreview();
			notice('Preview this full-instance export again before importing.', 'error', { persist: true });
			return;
		}
		let confirmed = false;
		setBusy(true);
		try {
			confirmed = await state.api.confirmRestart('instance-import');
		} catch (error) {
			notice(message(error), 'error', { persist: true });
		} finally {
			setBusy(false);
		}
		if (!confirmed) return;
		const result = await operation('Importing entire instance', () =>
			state.api.restoreInstance({ sourceHome, apply: true, previewDigest: preview.digest, confirmed: true }),
			'Entire instance imported. Containers remain stopped; review settings before starting.');
		if (!result) return;
		invalidateInstanceRestorePreview();
		await refresh();
		notice('Entire instance imported. Containers remain stopped; review settings before starting.');
		byId('view-title').focus();
	});
}

export function bindBackupEvents() {
	updateBackupScope();
	bindInstanceRestoreEvents();
	byId('backup-scope').addEventListener('change', updateBackupScope);
	byId('choose-backup-destination').addEventListener(
		'click',
		() => void chooseDirectory('backup', 'backup-destination')
	);

	byId('choose-restore-source').addEventListener(
		'click',
		() => void chooseDirectory('restore', 'restore-source')
	);

	byId('backup-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		const destination = byId('backup-destination').value.trim();
		const full = byId('backup-scope').value === 'instance';
		if (full && !(await state.api.confirmRestart('instance-export'))) return;
		const result = await operation(
			full ? 'Exporting entire instance' : 'Exporting portable content',
			() =>
				state.api.backup({
					destination,
					...(full ? { full: true, confirmed: true } : {
					includeProviderAuth: byId('backup-auth').checked,
					includeUserEnv: byId('backup-env').checked,
					includePortalMaps: byId('backup-maps').checked,
					includeOAuth: byId('backup-maps').checked
					})
				}),
			full ? 'Entire instance exported, including conversations. Containers remain stopped.' : 'Export created. Native conversation history is not included.'
		);
		if (!result) return;
		byId('backup-result').value = JSON.stringify(result, null, 2);
		byId('backup-summary').className = 'inline-status success';
		byId('backup-summary').hidden = false;
		byId('backup-summary').replaceChildren();
		const title = document.createElement('strong');
		title.textContent = full ? `${result.files.length} full-instance items exported.` : `${result.files.length} portable file${result.files.length === 1 ? '' : 's'} exported.`;
		const detail = document.createElement('span');
		detail.textContent = full
			? `Saved privately to ${destination}. Conversations, sign-ins, keys and active task settings included. External drives and images need separate protection. Containers remain stopped.${result.warnings.length ? ` ${result.warnings.length} warnings need review.` : ''}`
			: `Saved to ${destination}. Native history, runtime artifacts and external sources are not included.${result.warnings.length ? ` ${result.warnings.length} warnings need review.` : ''}`;
		byId('backup-summary').append(title, detail);
	});

	for (const eventName of ['input', 'change']) {
		byId('restore-form').addEventListener(eventName, (event) => {
			if (event.target.id === 'restore-acknowledge') {
				byId('apply-restore').disabled =
					!state.restorePreviewDigest || !byId('restore-acknowledge').checked;
				return;
			}
			invalidateRestorePreview();
		});
	}

	byId('preview-restore').addEventListener('click', async () => {
		const signature = restoreSignature();
		const result = await operation(
			'Previewing import',
			() => state.api.restoreData(restoreInput(false)),
			'Import preview is ready for review.'
		);
		if (!result) return;
		renderRestorePlan(result, false);
		state.restorePreviewSignature = signature;
		state.restorePreviewDigest = result.conflicts > 0 ? null : result.digest;
		byId('restore-acknowledge').checked = false;
		byId('apply-restore').disabled = result.conflicts > 0 || result.reviewRequired;
	});

	byId('apply-restore').addEventListener('click', async () => {
		if (state.restorePreviewSignature !== restoreSignature() || !state.restorePreviewDigest) {
			notice('Preview these restore choices again before applying them.', 'error', {
				persist: true
			});
			invalidateRestorePreview();
			return;
		}
		if (
			!window.confirm(
				'Copy the reviewed portable files? Native history and other unrestored data will not be copied.'
			)
		)
			return;
		const result = await operation(
			'Applying import',
			() => state.api.restoreData(restoreInput(true)),
			'Import applied. Your imported data is ready for review.'
		);
		if (result) {
			renderRestorePlan(result, true);
			state.providersLoaded = false;
			await loadProviders(false);
			invalidateRestorePreview();
		}
	});
}
