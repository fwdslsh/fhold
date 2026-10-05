import { state } from './state.js';
import { byId } from './ui.js';
import { saveConfigAndOfferRestart } from './configuration.js';

export function renderPreferences(snapshot) {
	byId('agent-timezone').value = snapshot.config.assistant.timezone;
	byId('automatic-memory').checked = snapshot.config.assistant.automaticMemory;
}

export function bindPreferencesEvents() {
	byId('preferences-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (!state.currentConfig) return;
		const config = structuredClone(state.currentConfig);
		config.assistant.timezone = byId('agent-timezone').value.trim();
		config.assistant.automaticMemory = byId('automatic-memory').checked;
		await saveConfigAndOfferRestart(
			config,
			'preferences-form',
			'Saving agent preferences',
			'Agent preferences saved.'
		);
	});
}
