import { defineCommand } from 'citty';

import {
	connectionDetails as sharedConnectionDetails,
	resolveFholdHome,
	type ConnectionDetails
} from '@fhold/lib';

export function connectionDetails(
	homeDir: string,
	type: ConnectionDetails['type'],
	options: { credential?: string; showKey?: boolean } = {}
): ConnectionDetails {
	return sharedConnectionDetails(homeDir, type, {
		credential: options.credential,
		showCredentialKey: options.showKey
	});
}

export default defineCommand({
	meta: { name: 'connect', description: 'Show exact connection settings for a client' },
	args: {
		client: {
			type: 'positional',
			required: false,
			description: 'opencode, mcp, claude, or remote'
		},
		credential: { type: 'string', description: 'named Guardian credential (default: owner)' },
		showKey: { type: 'boolean', description: 'include the Guardian credential key' },
		json: { type: 'boolean', description: 'print machine-readable JSON' }
	},
	run({ args }) {
		const client = String(args._?.[0] ?? 'mcp');
		if (!['opencode', 'mcp', 'claude', 'remote'].includes(client)) {
			throw new Error('Client must be opencode, mcp, claude, or remote.');
		}
		const details = connectionDetails(resolveFholdHome(), client as ConnectionDetails['type'], {
			credential: args.credential ? String(args.credential) : undefined,
			showKey: args.showKey === true
		});
		if (args.json) console.log(JSON.stringify(details, null, 2));
		else {
			console.log(`${details.type}: ${details.url}`);
			if (details.username) console.log(`Username: ${details.username}`);
			if (details.passwordFile) console.log(`Password file: ${details.passwordFile}`);
			if (details.credential) console.log(`Credential: ${details.credential}`);
			if (details.credentialKeyFile)
				console.log(`Credential key file: ${details.credentialKeyFile}`);
			if (details.credentialKey) console.log(`Credential key: ${details.credentialKey}`);
			if (details.extension) console.log(`Claude Desktop extension: ${details.extension}`);
			console.log(details.note);
		}
	}
});
