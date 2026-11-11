import { bindUiEvents } from './ui.js';
import { bindRuntimeEvents } from './runtime.js';
import { bindAccessEvents } from './access.js';
import { bindKeyEvents } from './keys.js';
import { bindConnectionsEvents } from './connections.js';
import { bindProvidersEvents } from './providers.js';
import { bindBackupEvents } from './backup.js';
import { bindConfigurationEvents } from './configuration.js';
import { bindRemoteEvents } from './remote.js';
import { bindInstanceEvents, initializeAdmin } from './instances.js';
import { bindRestartEvents } from './restart.js';
import { bindRecoveryEvents } from './recovery.js';
import { state } from './state.js';
import { bindSnapshotEvents } from './snapshot.js';
import { bindHostingEvents } from './hosting.js';
import { bindAdminSettingsEvents } from './settings.js';

state.api = window.fholdAdmin;
bindUiEvents();
bindRuntimeEvents();
bindAccessEvents();
bindKeyEvents();
bindConnectionsEvents();
bindProvidersEvents();
bindBackupEvents();
bindRecoveryEvents();
bindConfigurationEvents();
bindRemoteEvents();
bindInstanceEvents();
bindRestartEvents();
bindSnapshotEvents();
bindHostingEvents();
bindAdminSettingsEvents();
// The native browser view sits over this placeholder, outside the Admin DOM.
// Only request a fresh measurement; its URL, cookie and bounds remain in main.
let knowledgeLayoutPending = false;
const syncKnowledge = () => {
	if (knowledgeLayoutPending) return;
	knowledgeLayoutPending = true;
	requestAnimationFrame(() => {
		knowledgeLayoutPending = false;
		void state.api.syncKnowledge().catch(() => {});
	});
};
new ResizeObserver(syncKnowledge).observe(document.getElementById('knowledge-viewport'));
new MutationObserver(syncKnowledge).observe(document.body, {
	attributes: true,
	subtree: true,
	attributeFilter: ['hidden', 'open', 'data-phase', 'data-busy']
});
window.addEventListener('resize', syncKnowledge);
document.addEventListener('scroll', syncKnowledge, true);
void initializeAdmin();
