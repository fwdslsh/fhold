import { defineCommand } from 'citty';
import { mutateStack, resolveFholdHome, writeStackConfig } from '@fhold/lib';
import { guardianConfig } from './config.js';
import { runRestartAction } from './lifecycle.js';

function toggle(enabled: boolean) {
	return defineCommand({
		meta: { name: enabled ? 'enable' : 'disable', description: 'Configure Guardian MCP availability' },
		args: { apply: { type: 'boolean', default: true } },
		async run({ args }) {
			const homeDir = resolveFholdHome();
			mutateStack(homeDir, (config) => {
				if (!enabled && (config.portals.discord.enabled || config.portals.slack.enabled)) throw new Error('Disable portals before disabling Guardian.');
				config.gateway.enabled = enabled;
				writeStackConfig(homeDir, config);
			});
			if (args.apply !== false) await runRestartAction();
		}
	});
}
export default defineCommand({ meta: { name: 'guardian', description: 'Configure the Guardian MCP connection' }, subCommands: { enable: toggle(true), disable: toggle(false), configure: guardianConfig } });
