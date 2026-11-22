import { state } from './state.js';
import { byId, operation } from './ui.js';
import { instanceCapability } from './instance-presentation.js';

let review;
export function resetCustody() {
	review = undefined;
	for (const id of ['custody-secret-name', 'custody-secret-value', 'custody-task-name', 'custody-task-credential', 'custody-task-script']) byId(id).value = '';
	byId('custody-task-list').replaceChildren();
	byId('custody-review').textContent = '';
	byId('custody-reviewed').checked = false;
	byId('custody-approve').disabled = true;
	byId('custody-status').textContent = 'Load private task access to inspect this instance.';
	byId('custody-forms').hidden = true;
	byId('custody-review-panel').hidden = true;
}
function renderReview(value) {
	review = value;
	byId('custody-reviewed').checked = false;
	byId('custody-approve').disabled = true;
	byId('custody-review-panel').hidden = !value;
	if (!value) return;
	byId('custody-review').textContent = `Task definition\n${value.task}\nScript\n${value.script}\nCommand\n${value.command}`;
	byId('custody-grant-status').textContent = value.approved ? 'Approved for repeated use.' : 'Not approved.';
	byId('custody-revoke').hidden = !value.approved;
	byId('custody-approve').hidden = value.approved;
}
async function invoke(input, confirmed = false) {
	const progress = ['inspect', 'review'].includes(input.action) ? 'Reading private task access' : 'Updating private task access';
	const result = await operation(progress, () => state.api.operation('agent.custody', input, { confirmed }));
	if (result?.review) renderReview(result.review);
	return result;
}
async function load() {
	const capability = instanceCapability('agent.custody');
	if (!capability.supported) { byId('custody-status').textContent = capability.reason; return; }
	const result = await invoke({ action: 'inspect' });
	if (!result) return;
	byId('custody-status').textContent = result.reason || 'Private task access is enabled. Credential values are never returned to Admin.';
	byId('custody-forms').hidden = !result.enabled;
	if (!result.enabled) renderReview(undefined);
	byId('custody-task-list').replaceChildren();
	for (const name of result.tasks || []) {
		const button = document.createElement('button');
		button.type = 'button'; button.className = 'secondary'; button.textContent = `Review ${name}`;
		button.addEventListener('click', () => invoke({ action: 'review', name }));
		byId('custody-task-list').append(button);
		if (result.grants?.includes(name)) {
			const revoke = document.createElement('button');
			revoke.type = 'button'; revoke.className = 'secondary'; revoke.textContent = `Revoke ${name}`;
			revoke.addEventListener('click', async () => {
				if (state.operationInFlight || !window.confirm(`Revoke future invocations of ${name}? Already-running tasks are not stopped.`)) return;
				if (await invoke({ action: 'revoke', name }, true)) { renderReview(undefined); await load(); }
			});
			byId('custody-task-list').append(revoke);
		}
	}
}
export function bindCustodyEvents() {
	byId('custody-approve').disabled = true;
	byId('custody-reviewed').addEventListener('change', () => { byId('custody-approve').disabled = !byId('custody-reviewed').checked; });
	byId('custody-load').addEventListener('click', load);
	byId('custody-secret-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (state.operationInFlight) return;
		const input = { action: 'set-secret', name: byId('custody-secret-name').value, value: byId('custody-secret-value').value };
		byId('custody-secret-value').value = '';
		try { await invoke(input, true); } finally { input.value = ''; }
	});
	byId('custody-task-form').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (state.operationInFlight) return;
		const result = await invoke({ action: 'save-task', name: byId('custody-task-name').value, credential: byId('custody-task-credential').value, script: byId('custody-task-script').value }, true);
		if (result) await load();
	});
	byId('custody-approve').addEventListener('click', async () => {
		if (!review || !byId('custody-reviewed').checked || state.operationInFlight) return;
		if (!window.confirm(`Allow repeated execution of ${review.name} using its private credential? Only approve code and destinations you trust.`)) return;
		if (await invoke({ action: 'approve', name: review.name, digest: review.digest }, true)) await load();
	});
	byId('custody-revoke').addEventListener('click', async () => {
		if (!review || state.operationInFlight || !window.confirm('Revoke future invocations? Already-running tasks are not stopped.')) return;
		const name = review.name;
		if (await invoke({ action: 'revoke', name }, true)) { renderReview(undefined); await load(); }
	});
	window.addEventListener('pagehide', resetCustody);
}
