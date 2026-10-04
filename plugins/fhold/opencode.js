import { activity, coverage, report } from './scripts/activity.mjs';

export const FholdPlugin = async () => {
	const mark = (session, token, busy) => report(() => activity('opencode', session, token, busy));
	// Native plugin loading precedes work in each workspace. Calling back into
	// the server here would deadlock that workspace's own initialization.
	report(() => coverage('opencode', true));
	return {
		'chat.message': async ({ sessionID }) => mark(sessionID, 'turn', true),
		'tool.execute.before': async ({ sessionID, callID }) => mark(sessionID, `tool:${callID}`, true),
		'tool.execute.after': async ({ sessionID, callID }) => mark(sessionID, `tool:${callID}`, false),
		event: async ({ event }) =>
			report(() => {
				const p = event.properties;
				if (event.type === 'session.status') mark(p.sessionID, 'turn', p.status.type !== 'idle');
				if (event.type === 'session.idle') mark(p.sessionID, 'turn', false);
			})
	};
};
