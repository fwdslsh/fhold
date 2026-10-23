import { state } from './state.js';
import { byId, message } from './ui.js';

/** Host paths use a remote directory picker; exports and source archives stay on this computer. */
export async function chooseManagedDirectory(purpose) {
	const connectionId =
		state.installConnection?.id || state.currentSnapshot?.identity?.ref?.connectionId;
	if (!connectionId || purpose === 'backup' || purpose === 'restore')
		return state.api.chooseDirectory({ purpose });
	const dialog = byId('remote-directory-dialog');
	const path = byId('remote-directory-path');
	const status = byId('remote-directory-status');
	let epoch = 0,
		parent = '';
	async function load(requested) {
		const current = ++epoch;
		status.textContent = 'Loading folders…';
		try {
			const listing = await state.api.hostingDirectory({ connectionId, path: requested });
			if (current !== epoch) return;
			path.value = listing.path;
			parent = listing.parent;
			status.textContent = '';
			const list = byId('remote-directory-list');
			list.replaceChildren();
			for (const directory of listing.directories) {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'directory-choice';
				button.textContent = directory.name;
				button.addEventListener('click', () => void load(directory.path));
				list.append(button);
			}
			if (!listing.directories.length) status.textContent = 'No folders here.';
		} catch (error) {
			if (current === epoch) status.textContent = message(error);
		}
	}
	const title = state.installConnection?.label || 'Remote computer';
	byId('remote-directory-title').textContent = `Choose a folder on ${title}`;
	path.value = '';
	byId('remote-directory-list').replaceChildren();
	dialog.returnValue = '';
	dialog.showModal();
	for (const button of dialog.querySelectorAll('button')) button.disabled = false;
	byId('remote-directory-select').disabled = true;
	const updateSelection = () => {
		byId('remote-directory-select').disabled = !path.value.trim().startsWith('/');
	};
	path.addEventListener('input', updateSelection);
	const up = () => void load(parent);
	const go = () => void load(path.value.trim());
	const select = () => dialog.close('select');
	const cancel = () => dialog.close('cancel');
	const key = (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			go();
		}
	};
	byId('remote-directory-up').addEventListener('click', up);
	byId('remote-directory-go').addEventListener('click', go);
	byId('remote-directory-select').addEventListener('click', select);
	byId('remote-directory-cancel').addEventListener('click', cancel);
	path.addEventListener('keydown', key);
	void load().then(updateSelection);
	try {
		return await new Promise((resolve) =>
			dialog.addEventListener(
				'close',
				() => resolve(dialog.returnValue === 'select' ? path.value.trim() : undefined),
				{ once: true }
			)
		);
	} finally {
		epoch++;
		byId('remote-directory-up').removeEventListener('click', up);
		byId('remote-directory-go').removeEventListener('click', go);
		byId('remote-directory-select').removeEventListener('click', select);
		byId('remote-directory-cancel').removeEventListener('click', cancel);
		path.removeEventListener('keydown', key);
		path.removeEventListener('input', updateSelection);
	}
}
