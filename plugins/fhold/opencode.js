import { Plugin } from '@opencode/plugin';
import { activity, coverage, endSession, report } from './scripts/activity.mjs';

export function observeOpenCode(event) {
	const data = event.data ?? {};
	const session = data.sessionID;
	const mark = (token, busy) => activity('opencode', session, token, busy);
	report(() => {
		if (event.type === 'session.execution.started') mark('turn', true);
		if (event.type === 'session.shell.started') mark(`shell:${data.shell.id}`, true);
		if (event.type === 'session.shell.ended') mark(`shell:${data.shell.id}`, false);
		if (
			[
				'session.execution.succeeded',
				'session.execution.failed',
				'session.execution.interrupted',
				'session.idle',
				'session.deleted'
			].includes(event.type)
		)
			endSession('opencode', session);
		if (event.type === 'session.tool.called') mark(`tool:${data.id}`, true);
		if (event.type === 'session.tool.success' || event.type === 'session.tool.failed')
			mark(`tool:${data.id}`, false);
	});
}

export default Plugin.define({
	id: 'fhold.activity',
	setup(context) {
		// Loading occurs before workspace initialization completes. No HTTP callback.
		report(() => coverage('opencode', true));
		const abort = new AbortController();
		let locationClosed = false;
		void (async () => {
			try {
				for await (const event of context.event.subscribe({ signal: abort.signal })) {
					if (event.location?.directory && event.location.directory !== context.location.directory)
						continue;
					if (
						event.type === 'location.shutdown' &&
						event.location?.directory === context.location.directory &&
						event.location.workspaceID === context.location.workspaceID
					)
						locationClosed = true;
					observeOpenCode(event);
				}
			} catch {
				// A failed subscription must not prevent native work.
			} finally {
				// An unexpected clean end also loses observation.
				if (!abort.signal.aborted) report(() => coverage('opencode', false));
			}
		})();
		return () => {
			// Native location shutdown precedes plugin cleanup. Preserve the last
			// observation only for that lifecycle; plugin removal/replacement also
			// calls cleanup, but leaves the location able to accept unobserved work.
			// A replacement observer establishes its own coverage during setup.
			if (!locationClosed) report(() => coverage('opencode', false));
			abort.abort();
		};
	}
});
