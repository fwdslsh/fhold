import { Plugin } from '@opencode/plugin/effect';
import { Effect, Stream } from 'effect';
import upstream from 'akm-opencode-v2';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function degraded(feature, message) {
	try {
		const path = join(process.env.FH_RUNTIME_DIR || '/tmp/fhold-runtime', `degraded-${feature}`);
		if (message) writeFileSync(path, message, { mode: 0o600 });
		else rmSync(path, { force: true });
	} catch { /* Diagnostics must not reject a user's prompt. */ }
	if (message) console.error(`fhold: degraded: ${message}`);
}

export default Plugin.define({
	id: 'fhold.knowledge',
	effect: (context) => Effect.gen(function* () {
		// Automatic context runs outside native tool permission checks. This is
		// exclusively the Guardian credential boundary, never a local agent policy.
		const allowed = (sessionID) => Effect.gen(function* () {
			const session = yield* context.session.get({ sessionID });
			return !session.metadata?.fholdGuardian || session.metadata.fholdGuardianKnowledge === true;
		});
		const safeSessionHook = (name, hook) => context.session.hook(name, (input) => Effect.gen(function* () {
			if (!(yield* allowed(input.sessionID))) return;
			yield* hook(input);
			degraded('knowledge');
		}).pipe(Effect.catchCause(() => Effect.sync(() => degraded('knowledge',
			'A knowledge hook failed. Other tools remain available; review AKM settings and logs. It will retry on subsequent turns.')))));
		// Use the released plugin and native registration APIs. Its tool write gate
		// is deliberately not caught: rejected knowledge writes must remain rejected.
		yield* upstream.effect({ ...context, event: { ...context.event,
			subscribe: () => context.event.subscribe().pipe(Stream.filterEffect((event) => {
				// Deleted sessions no longer resolve; native cleanup must still run.
				if (event.type === 'session.deleted') return Effect.succeed(true);
				const id = event.data?.sessionID ?? event.data?.session?.id;
				return id ? allowed(id).pipe(Effect.catchCause(() => Effect.succeed(false))) : Effect.succeed(true);
			}))
		}, tool: { ...context.tool,
			hook: (name, hook) => context.tool.hook(name, (input) => Effect.gen(function* () {
				if (yield* allowed(input.sessionID)) yield* hook(input);
			}))
		}, session: { ...context.session,
			hook: (name, hook) => name === 'prompt' || name === 'context' ? safeSessionHook(name, hook) : context.session.hook(name, hook)
		} });
		degraded('knowledge');
	}).pipe(Effect.catchCause(() => Effect.sync(() => degraded('knowledge',
		'Knowledge integration is unavailable. Review AKM configuration and recent logs, then reload OpenCode; other agent tools remain available.'))))
});
