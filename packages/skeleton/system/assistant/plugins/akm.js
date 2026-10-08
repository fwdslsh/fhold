// Image-baked dependency: this local wrapper prevents OpenCode from installing
// the plugin from npm during container startup.
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const AkmPlugin = async (context) => {
	const degraded = (feature, message) => {
		try {
			const path = join(process.env.FH_RUNTIME_DIR || '/tmp/fhold-runtime', `degraded-${feature}`);
			if (message) writeFileSync(path, message, { mode: 0o600 });
			else rmSync(path, { force: true });
		} catch {
			/* Diagnostic failure must not reject a user's prompt. */
		}
		if (message) console.error(`fhold: degraded: ${message}`);
	};
	let hooks, memory;
	try {
		const { AkmPlugin: upstreamPlugin } = await import(
			'/opt/fhold/tools/node_modules/akm-opencode/dist/index.js'
		);
		memory = await import('../lib/memory.js');
		hooks = await upstreamPlugin(context);
		degraded('knowledge');
	} catch {
		degraded(
			'knowledge',
			'Knowledge integration is unavailable. Review AKM configuration and recent logs, then reload OpenCode; other agent tools remain available.'
		);
		return {};
	}
	const { createMemoryCapture, memorySource, trustedMemoryAgent } = memory;
	const capture = createMemoryCapture({
		report: (status) => {
			degraded(
				'memory',
				status.startsWith('capture failed')
					? 'Automatic memory capture failed. Review AKM/provider settings and recent logs; it will retry on a later turn.'
					: undefined
			);
		}
	});
	const failed = new Set();
	const protectedHooks = Object.fromEntries(
		Object.entries(hooks).map(([name, hook]) => [
			name,
			typeof hook !== 'function'
				? hook
				: async (...args) => {
						try {
							const result = await hook(...args);
							failed.delete(name);
							if (!failed.size) degraded('knowledge');
							return result;
						} catch {
							if (!failed.has(name))
								degraded(
									'knowledge',
									'A knowledge hook failed. Other agent tools remain available; review AKM settings and logs. The hook will retry on subsequent events.'
								);
							failed.add(name);
						}
					}
		])
	);
	return {
		...protectedHooks,
		'chat.message': async (input, output) => {
			// Do not send credential-bearing user text to the plugin's telemetry.
			if (!trustedMemoryAgent(input.agent)) return;
			await protectedHooks['chat.message']?.(input, {
				...output,
				parts: (output.parts ?? []).map((part) =>
					part.type === 'text' ? { ...part, text: memorySource(part.text) } : part
				)
			});
		},
		event: async (input) => {
			await protectedHooks.event?.(input);
			if (input.event?.type === 'session.idle') {
				void capture(input.event.properties?.sessionID);
			}
		}
	};
};
