import { copyAccessKey, credentialOptions } from './access.js';
import { offerRestart } from './restart.js';
import { state } from './state.js';
import { byId, operation, setOptions } from './ui.js';

// Only a public identity is retained; private values are fetched on explicit copy.
let rotatedUsername;

export function renderConnectionKeys(snapshot) {
	const select = byId('key-rotation-credential');
	setOptions(
		select,
		[{ value: '', label: 'Choose a connection…' }, ...credentialOptions(snapshot)],
		select.value
	);
	byId('rotated-key-details').hidden = !rotatedUsername || select.value !== rotatedUsername;
}

export function bindKeyEvents() {
	byId('key-rotation-credential').addEventListener('change', () => {
		rotatedUsername = undefined;
		byId('rotated-key-details').hidden = true;
	});
	byId('key-rotation-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (state.operationInFlight) return;
		const select = byId('key-rotation-credential');
		const username = select.value;
		if (!state.currentConfig?.credentials[username]) return;
		if (
			!window.confirm(
				`Rotate the key for “${username}”? The old key will stop working. Update every external app using it. Permissions and conversations stay unchanged.`
			)
		)
			return;
		select.disabled = true;
		let saved;
		try {
			saved = await operation(
				'Rotating connection key',
				() => state.api.credential({ action: 'rotate', username }),
				'Connection key rotated. Update external apps using this connection.'
			);
		} finally {
			select.disabled = false;
		}
		if (!saved) return;
		rotatedUsername = username;
		select.value = username;
		byId('rotated-key-details').hidden = false;
		await offerRestart(saved);
	});
	byId('copy-rotated-key').addEventListener('click', () => {
		if (rotatedUsername && byId('key-rotation-credential').value === rotatedUsername)
			void copyAccessKey(rotatedUsername);
	});
}
