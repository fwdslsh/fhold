import { defineCommand } from 'citty';

import {
	createBackup,
	exportInstance,
	INSTANCE_BACKUP_NOTICE,
	requireInstall,
	resolveFholdHome
} from '@fhold/lib';

export default defineCommand({
	meta: {
		name: 'backup',
		description:
			'Export reviewed portable content or a stopped whole instance; Assistant checkpoints use recovery export'
	},
	args: {
		to: { type: 'string', required: true, description: 'new or empty destination directory' },
		portable: {
			type: 'boolean',
			description: 'export reviewed transferable files (the default without --full)'
		},
		full: {
			type: 'boolean',
			description: 'export the entire stopped instance, including sessions and credentials'
		},
		'confirm-stopped': {
			type: 'boolean',
			description:
				'confirm downtime and inclusion of private runtime authority; Docker also verifies stopped containers'
		},
		includeProviderAuth: { type: 'boolean', description: 'include OpenCode provider credentials' },
		includeUserEnv: { type: 'boolean', description: 'include knowledge/env/user.env' },
		includePortalMaps: { type: 'boolean', description: 'include Discord and Slack user mappings' },
		includeOAuth: { type: 'boolean', description: 'include Guardian OAuth configuration and maps' },
		json: { type: 'boolean', description: 'print the backup manifest as JSON' }
	},
	async run({ args }) {
		const homeDir = resolveFholdHome();
		requireInstall(homeDir);
		if (args.full && args.portable) throw new Error('Choose --full or --portable.');
		if (args.full) {
			if (
				[
					args.includeProviderAuth,
					args.includeUserEnv,
					args.includePortalMaps,
					args.includeOAuth
				].some(Boolean)
			)
				throw new Error(
					'--full already includes all credentials and settings; do not combine portable include flags.'
				);
			if (!args.json) console.log(INSTANCE_BACKUP_NOTICE);
			const manifest = await exportInstance({
				sourceHome: homeDir,
				destination: String(args.to),
				confirmedStopped: args['confirm-stopped'] === true
			});
			if (args.json) console.log(JSON.stringify(manifest, null, 2));
			else {
				console.log(
					`Full instance exported to ${args.to}: ${manifest.files.length} entries, ${manifest.totalBytes} bytes.`
				);
				for (const warning of manifest.warnings) console.warn(`warning: ${warning}`);
				console.log(
					'Containers remain stopped. Import into an empty folder with `fhold --name <folder> restore --full --from <export> --dry-run`.'
				);
			}
			return;
		}
		if (args['confirm-stopped']) throw new Error('--confirm-stopped applies only to --full.');
		const manifest = await createBackup({
			sourceHome: homeDir,
			destination: String(args.to),
			includeProviderAuth: args.includeProviderAuth === true,
			includeUserEnv: args.includeUserEnv === true,
			includePortalMaps: args.includePortalMaps === true,
			includeOAuth: args.includeOAuth === true
		});
		if (args.json) console.log(JSON.stringify(manifest, null, 2));
		else {
			console.log(`Portable backup created at ${args.to}`);
			console.log(`${manifest.files.length} file(s), ${manifest.totalBytes} byte(s).`);
			console.log('Scope: portable files only. NOT a full runtime or rollback backup.');
			for (const category of manifest.excludedCategories) console.log(`Not included: ${category}`);
			for (const warning of manifest.warnings) console.warn(`warning: ${warning}`);
			console.log('Restore into a fresh install with `fhold restore --from <backup>` options.');
		}
	}
});
