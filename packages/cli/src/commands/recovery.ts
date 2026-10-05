import { defineCommand } from 'citty';
import { lstatSync, readFileSync } from 'node:fs';
import {
	directoryRecoveryDestination,
	recoverySnapshot,
	recoveryStatus,
	resolveFholdHome,
	runRecoveryOperation,
	saveRecoveryCredential,
	saveRecoverySettings
} from '@fhold/lib';

function inputFile(path: string, limit: number): string {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
		throw new Error('Choose a regular, non-linked input file within the supported size.');
	return readFileSync(path, 'utf8');
}

const configure = defineCommand({
	meta: {
		name: 'configure',
		description: 'Save runtime recovery settings without restarting containers'
	},
	args: {
		directory: {
			type: 'string',
			description: 'absolute local or mounted backup directory, outside the instance home'
		},
		to: { type: 'string', description: 'credential-free file: or azblob: recovery URL' },
		instanceId: { type: 'string', description: 'stable recovery instance ID' },
		interval: { type: 'string', description: 'checkpoint cadence in seconds' },
		maxUnsaved: { type: 'string', description: 'maximum unsaved age in seconds' },
		timeout: { type: 'string', description: 'operation timeout in seconds' },
		selectionFile: {
			type: 'string',
			description: 'reviewed recovery include/mount policy JSON file'
		},
		managedIdentity: {
			type: 'boolean',
			description: 'use the deployment managed identity, not a host account'
		},
		connectionString: {
			type: 'boolean',
			description: 'use the private connection-string credential file'
		},
		clientId: { type: 'string', description: 'optional managed identity UUID' }
	},
	run({ args }) {
		if (args.directory && args.to) throw new Error('Use --directory or --to, not both.');
		if (args.managedIdentity && args.connectionString)
			throw new Error('Choose one storage authentication source.');
		const home = resolveFholdHome();
		const current = recoverySnapshot(home);
		const settings = { ...current.settings };
		if (args.directory || args.to) {
			settings.destination = args.directory
				? directoryRecoveryDestination(String(args.directory))
				: String(args.to);
			settings.enabled = true;
		}
		if (args.instanceId) settings.instanceId = String(args.instanceId);
		for (const [flag, key] of [
			['interval', 'intervalSeconds'],
			['maxUnsaved', 'maxUnsavedSeconds'],
			['timeout', 'operationTimeoutSeconds']
		] as const)
			if (args[flag] !== undefined) settings[key] = Number(args[flag]);
		if (args.managedIdentity) settings.authentication = 'managed-identity';
		if (args.connectionString) settings.authentication = 'connection-string';
		if (args.clientId !== undefined) settings.clientId = String(args.clientId);
		const selection = args.selectionFile
			? (JSON.parse(inputFile(String(args.selectionFile), 4 * 1024 * 1024)) as unknown)
			: current.selection;
		const saved = saveRecoverySettings(home, {
			settings,
			selection,
			baselineDigest: current.digest
		});
		console.log(JSON.stringify(saved, null, 2));
		console.log(
			'Saved only. Stop the instance and explicitly initialize a new namespace once, or restart to resume an existing namespace.'
		);
	}
});

const disable = defineCommand({
	meta: {
		name: 'disable',
		description: 'Disable recovery on the next restart; preserve all checkpoints and credentials'
	},
	run() {
		const home = resolveFholdHome();
		const current = recoverySnapshot(home);
		saveRecoverySettings(home, {
			settings: { ...current.settings, enabled: false },
			selection: current.selection,
			baselineDigest: current.digest
		});
		console.log(
			'Recovery disabled in saved settings. Restart to apply; checkpoints and local data were kept.'
		);
	}
});

const credential = defineCommand({
	meta: {
		name: 'credential',
		description: 'Store a private standard Blob connection-string file without displaying it'
	},
	args: {
		from: { type: 'string', required: true, description: 'private regular connection-string file' }
	},
	run({ args }) {
		const path = String(args.from);
		if ((lstatSync(path).mode & 0o077) !== 0)
			throw new Error('The storage credential input must be private (mode 600 or 400).');
		saveRecoveryCredential(resolveFholdHome(), inputFile(path, 16_384));
		console.log('Private recovery credential saved. Restart to apply; the value was not printed.');
	}
});

const inspect = defineCommand({
	meta: {
		name: 'inspect',
		description: 'Read-only private inspection of saved container coverage'
	},
	async run() {
		console.log(await runRecoveryOperation(resolveFholdHome(), 'inspect'));
	}
});
const status = defineCommand({
	meta: { name: 'status', description: 'Read-only current Assistant checkpoint status' },
	async run() {
		console.log(JSON.stringify(await recoveryStatus(resolveFholdHome()), null, 2));
	}
});
const show = defineCommand({
	meta: {
		name: 'show',
		description: 'Show recovery settings, selection and credential presence, never its value'
	},
	run() {
		console.log(JSON.stringify(recoverySnapshot(resolveFholdHome()), null, 2));
	}
});
const init = defineCommand({
	meta: {
		name: 'init',
		description: 'Initialize a genuinely unused recovery namespace while the instance is stopped'
	},
	args: {
		confirmNewInstance: {
			type: 'boolean',
			description: 'explicitly confirm a new destination/identity namespace'
		}
	},
	async run({ args }) {
		console.log(
			await runRecoveryOperation(resolveFholdHome(), 'init', args.confirmNewInstance === true)
		);
	}
});
const restore = defineCommand({
	meta: {
		name: 'restore',
		description:
			'Validate/restore the same instance offline without starting writers or overwriting local data'
	},
	args: {
		confirmStopped: {
			type: 'boolean',
			description: 'explicitly confirm the old writers are stopped'
		}
	},
	async run({ args }) {
		console.log(
			await runRecoveryOperation(resolveFholdHome(), 'restore', args.confirmStopped === true)
		);
	}
});

export default defineCommand({
	meta: {
		name: 'recovery',
		description: 'Configure same-instance Assistant recovery; not portable content backup'
	},
	subCommands: { configure, disable, credential, show, inspect, status, init, restore }
});
