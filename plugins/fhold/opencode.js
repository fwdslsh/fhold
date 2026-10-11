import { Plugin } from '@opencode/plugin';
import { activity, coverage, endSession, report } from './scripts/activity.mjs';

export function observeOpenCode(event) {
	const data = event.data ?? {};
	const session = data.sessionID;
	const mark = (token, busy) => activity('opencode', session, token, busy);
	const shell = data.shell;
	const shellID = typeof shell?.id === 'string' ? shell.id : undefined;
	report(() => {
		if (event.type === 'session.execution.started') mark('turn', true);
		if (event.type === 'session.shell.started' && shellID) mark(`shell:${shellID}`, true);
		if (
			shellID &&
			[
				'session.shell.ended',
				'session.shell.failed',
				'session.shell.interrupted',
				'session.shell.cancelled',
				'session.shell.killed',
				'session.shell.timed-out'
			].includes(event.type)
		)
			mark(`shell:${shellID}`, false);
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
		void (async () => {
			try {
				for await (const event of context.event.subscribe({ signal: abort.signal })) {
					if (event.location?.directory && event.location.directory !== context.location.directory)
						continue;
					observeOpenCode(event);
				}
			} catch {
				if (!abort.signal.aborted) report(() => coverage('opencode', false));
			}
		})();
		return () => {
			abort.abort();
			report(() => coverage('opencode', false));
		};
	}
});
