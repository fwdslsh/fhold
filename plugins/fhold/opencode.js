import { activity, coverage, endSession, report } from './scripts/activity.mjs';

export const FholdPlugin = async () => {
	const mark = (session, token, busy) => report(() => activity('opencode', session, token, busy));
	// Native plugin loading precedes work in each workspace. Calling back into
	// the server here would deadlock that workspace's own initialization.
	report(() => coverage('opencode', true));
	return {
		event: async ({ event }) =>
			report(() => {
				const p = event.properties;
				// Native lifecycle events cover API shells and failed/cancelled tools,
				// and do not mistake noReply message inserts for running turns.
				if (event.type === 'session.status') mark(p.sessionID, 'turn', p.status.type !== 'idle');
				if (event.type === 'session.idle') mark(p.sessionID, 'turn', false);
				if (event.type === 'session.deleted') endSession('opencode', p.info.id);
				if (event.type === 'message.part.updated' && p.part.type === 'tool') {
					const part = p.part;
					mark(
						part.sessionID,
						`tool:${part.id}`,
						!['completed', 'error'].includes(part.state.status)
					);
				}
			})
	};
};
