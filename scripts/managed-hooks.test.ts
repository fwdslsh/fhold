import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { managedHooks } from './bake-managed-hooks.mjs';

test('managed registration preserves native matchers, timeouts and literal command arguments', () => {
	const definition = {
		SessionStart: [
			{
				matcher: 'startup',
				hooks: [
					{
						type: 'command',
						command: 'printf "%s\\n"',
						args: ['${CLAUDE_PLUGIN_ROOT}/hooks/recall.ts', "quote's", '$HOME; echo not-a-command'],
						timeout: 15,
						statusMessage: 'Loading knowledge'
					}
				]
			}
		]
	};
	const { hooks, inventory } = managedHooks('claude', [
		{ id: 'test@market', root: '/immutable/plugin', definition }
	]);
	const handler = hooks.SessionStart[0].hooks[0];
	expect(hooks.SessionStart[0].matcher).toBe('startup');
	expect(handler.timeout).toBe(15);
	expect(handler.statusMessage).toBe('Loading knowledge');
	expect(handler.args).toBeUndefined();
	const result = spawnSync('/bin/sh', ['-c', handler.command], { encoding: 'utf8' });
	expect(result.status).toBe(0);
	expect(result.stdout).toBe(
		"/immutable/plugin/hooks/recall.ts\nquote's\n$HOME; echo not-a-command\n"
	);
	expect(inventory['test@market']).toEqual([{ event: 'sessionStart', command: handler.command }]);
	expect(definition.SessionStart[0].hooks[0].command).toBe('printf "%s\\n"');
});

test('Codex registration preserves native plugin data and binds handlers to the image, not user caches', () => {
	const { hooks } = managedHooks('codex', [
		{
			id: 'akm@akm-plugins',
			root: '/akm-marketplace/claude',
			definition: {
				hooks: {
					UserPromptSubmit: [
						{
							hooks: [
								{
									type: 'command',
									command: 'printf "%s\\n" "${PLUGIN_ROOT}/hooks/recall.sh" "${PLUGIN_DATA}"',
									commandWindows: 'unused Windows handler'
								}
							]
						}
					]
				}
			}
		}
	]);
	const handler = hooks.UserPromptSubmit[0].hooks[0];
	expect(handler.commandWindows).toBeUndefined();
	const result = spawnSync('/bin/sh', ['-c', handler.command], {
		encoding: 'utf8',
		env: { HOME: '/account', CODEX_HOME: '/custom native home' }
	});
	expect(result.status).toBe(0);
	expect(result.stdout).toBe(
		'/akm-marketplace/claude/hooks/recall.sh\n/custom native home/plugins/data/akm-akm-plugins\n'
	);
});

test('unsupported upstream handler formats stop the build rather than silently losing hooks', () => {
	const registration = (handler: unknown) =>
		managedHooks('codex', [
			{
				id: 'test@market',
				root: '/plugin',
				definition: {
					hooks: { SessionStart: [{ hooks: [handler] }] }
				}
			}
		]);
	expect(() => registration({ type: 'prompt', prompt: 'new upstream feature' })).toThrow(
		'Unsupported'
	);
	expect(() => registration({ type: 'command', command: 'printf', args: [1] })).toThrow(
		'Unsupported'
	);
});
