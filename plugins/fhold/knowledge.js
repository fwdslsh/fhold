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
		const memory = yield* Effect.tryPromise(() => import('/etc/opencode/lib/memory.js'));
		const capture = memory.createMemoryCapture({ report: (status) => degraded('memory',
			status.startsWith('capture failed') ? 'Automatic memory capture failed. Review AKM/provider settings; it will retry on a later turn.' : undefined) });
		const safeSessionHook = (name, hook) => context.session.hook(name, (input) => Effect.gen(function* () {
			const session = yield* context.session.get({ sessionID: input.sessionID });
			const agent = name === 'context' ? input.agent : session.agent;
			if (session.metadata?.fholdGuardian || !memory.trustedMemoryAgent(agent)) return;
			// Only the upstream telemetry copy is redacted, never the native prompt.
			yield* hook(name === 'prompt' ? { ...input, prompt: { ...input.prompt, text: memory.memorySource(input.prompt.text) } } : input);
			degraded('knowledge');
		}).pipe(Effect.catchCause(() => Effect.sync(() => degraded('knowledge',
			'A knowledge hook failed. Other tools remain available; review AKM settings and logs. It will retry on subsequent turns.')))));
		// Use the released plugin and native registration APIs. Its tool write gate
		// is deliberately not caught: rejected knowledge writes must remain rejected.
		yield* upstream.effect({ ...context, session: { ...context.session,
			hook: (name, hook) => name === 'prompt' || name === 'context' ? safeSessionHook(name, hook) : context.session.hook(name, hook)
		} });
		degraded('knowledge');
		yield* Stream.runForEach(context.event.subscribe(), (event) => {
			if (event.location?.directory && event.location.directory !== context.location.directory) return Effect.void;
			if (event.type === 'session.execution.succeeded') void capture(event.data.sessionID);
			return Effect.void;
		}).pipe(Effect.catchCause(() => Effect.sync(() => degraded('memory', 'Memory observation stopped. Reload OpenCode to resume automatic capture.'))), Effect.forkScoped);
	}).pipe(Effect.catchCause(() => Effect.sync(() => degraded('knowledge',
		'Knowledge integration is unavailable. Review AKM configuration and recent logs, then reload OpenCode; other agent tools remain available.'))))
});
