import { defineCommand } from 'citty';
import { readFileSync } from 'node:fs';

import {
	generateCredentialKey,
	createCredential,
	credentialKeyFile,
	rotateCredential,
	removeCredential,
	setCredentialPolicy,
	mapPortalUser,
	mapOAuthIdentity,
	portalCredentialUsages,
	oauthCredentialUsages,
	isPortalName,
	normalizeCredentialKey,
	readCredentialKey,
	readOAuthIdentityMap,
	readPortalCredentialMap,
	resolveFholdHome,
	type PortalName
} from '@fhold/lib';

import { current } from './config.js';

function positional(args: { _?: unknown[] }, index: number): string {
	return String(args._?.[index] ?? '');
}

function requirePortal(value: string): PortalName {
	if (!isPortalName(value)) throw new Error('Portal must be discord or slack.');
	return value;
}

function suppliedKey(path: string | undefined): string {
	if (!path) return generateCredentialKey();
	const content = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
	return normalizeCredentialKey(content);
}

const list = defineCommand({
	meta: { name: 'list', description: 'List credential usernames and policies without keys' },
	run() {
		const { homeDir, config } = current();
		for (const [username, credential] of Object.entries(config.credentials).sort(([a], [b]) =>
			a.localeCompare(b)
		)) {
			const usages = [
				...portalCredentialUsages(homeDir, config, username),
				...oauthCredentialUsages(homeDir, username)
			];
			console.log(
				`${username}\t${credential.policy}${usages.length ? `\tassigned=${usages.join(',')}` : ''}`
			);
		}
	}
});

const add = defineCommand({
	meta: { name: 'add', description: 'Create a named Guardian/MCP credential' },
	args: {
		username: { type: 'positional', required: true },
		policy: { type: 'positional', required: true, description: 'chat, read, or full' },
		keyFile: {
			type: 'string',
			description: 'read the key from this file; use - for stdin (generated when omitted)'
		},
		showKey: {
			type: 'boolean',
			description: 'print the key once after creating it',
			default: false
		}
	},
	run({ args }) {
		const key = suppliedKey(args.keyFile ? String(args.keyFile) : undefined);
		const { username, policy, keyFile } = createCredential(resolveFholdHome(), {
			username: positional(args, 0),
			policy: positional(args, 1),
			key
		});
		console.log(`Created ${username} with ${policy} policy.`);
		console.log(`Key file: ${keyFile}`);
		if (args.showKey) console.log(key);
	}
});

const setPolicy = defineCommand({
	meta: { name: 'set-policy', description: 'Change a named credential policy' },
	args: {
		username: { type: 'positional', required: true },
		policy: { type: 'positional', required: true, description: 'chat, read, or full' }
	},
	run({ args }) {
		const username = positional(args, 0);
		const policy = positional(args, 1);
		setCredentialPolicy(resolveFholdHome(), username, policy);
		console.log(`${username}: ${policy}`);
	}
});

const rotate = defineCommand({
	meta: { name: 'rotate', description: 'Replace a named credential key without changing identity' },
	args: {
		username: { type: 'positional', required: true },
		keyFile: {
			type: 'string',
			description: 'read the new key from this file; use - for stdin (generated when omitted)'
		},
		showKey: {
			type: 'boolean',
			description: 'print the new key once',
			default: false
		}
	},
	run({ args }) {
		const username = positional(args, 0);
		const key = suppliedKey(args.keyFile ? String(args.keyFile) : undefined);
		const keyFile = rotateCredential(resolveFholdHome(), username, key);
		console.log(`Rotated ${username}.`);
		console.log(`Key file: ${keyFile}`);
		if (args.showKey) console.log(key);
	}
});

const show = defineCommand({
	meta: { name: 'show', description: 'Show credential metadata and optionally its key' },
	args: {
		username: { type: 'positional', required: true },
		showKey: { type: 'boolean', description: 'include the secret key', default: false }
	},
	run({ args }) {
		const username = positional(args, 0);
		const { homeDir, config } = current();
		const credential = Object.hasOwn(config.credentials, username)
			? config.credentials[username]
			: undefined;
		if (!credential) throw new Error(`Unknown credential: ${username}`);
		console.log(
			JSON.stringify(
				{
					username,
					policy: credential.policy,
					keyFile: credentialKeyFile(homeDir, username),
					...(args.showKey ? { key: readCredentialKey(homeDir, username) } : {})
				},
				null,
				2
			)
		);
	}
});

const remove = defineCommand({
	meta: { name: 'remove', description: 'Revoke and remove a named credential' },
	args: { username: { type: 'positional', required: true } },
	run({ args }) {
		const username = positional(args, 0);
		removeCredential(resolveFholdHome(), username);
		console.log(`Removed ${username}.`);
	}
});

const map = defineCommand({
	meta: { name: 'map', description: 'Map a portal or OAuth identity to a named credential' },
	args: {
		target: { type: 'positional', required: true, description: 'discord, slack, or oauth' },
		identity: { type: 'positional', required: true, description: 'platform user ID or issuer' },
		value: { type: 'positional', required: true, description: 'credential username or subject' },
		username: {
			type: 'positional',
			required: false,
			description: 'credential username for OAuth'
		}
	},
	run({ args }) {
		const target = positional(args, 0);
		const username = positional(args, target === 'oauth' ? 3 : 2);
		const { homeDir, config } = current();
		if (target === 'oauth') {
			const issuer = positional(args, 1);
			const subject = positional(args, 2);
			mapOAuthIdentity(homeDir, { issuer, subject, username });
			console.log(
				`oauth ${issuer} subject ${subject}: ${username} (${config.credentials[username]?.policy})`
			);
			return;
		}
		const portal = target;
		const userId = positional(args, 1);
		mapPortalUser(homeDir, { portal, userId, username });
		console.log(`${portal} user ${userId}: ${username} (${config.credentials[username]?.policy})`);
	}
});

const unmap = defineCommand({
	meta: { name: 'unmap', description: 'Remove a portal or OAuth credential mapping' },
	args: {
		target: { type: 'positional', required: true, description: 'discord, slack, or oauth' },
		identity: { type: 'positional', required: true, description: 'platform user ID or issuer' },
		subject: { type: 'positional', required: false, description: 'OAuth subject' }
	},
	run({ args }) {
		const target = positional(args, 0);
		if (target === 'oauth') {
			const issuer = positional(args, 1);
			const subject = positional(args, 2);
			const { homeDir } = current();
			mapOAuthIdentity(homeDir, { issuer, subject });
			console.log(`Removed OAuth mapping for ${issuer} subject ${subject}.`);
			return;
		}
		const portal = requirePortal(target);
		const userId = positional(args, 1);
		const { homeDir } = current();
		const mapping = readPortalCredentialMap(homeDir, portal);
		if (!Object.hasOwn(mapping.users, userId)) {
			throw new Error(`${portal} user ${userId} has no credential mapping.`);
		}
		mapPortalUser(homeDir, { portal, userId });
		console.log(`${portal} user ${userId} now uses the portal default credential.`);
	}
});

const mappings = defineCommand({
	meta: { name: 'mappings', description: 'List portal or OAuth credential mappings' },
	args: {
		target: { type: 'positional', required: true, description: 'discord, slack, or oauth' }
	},
	run({ args }) {
		const target = positional(args, 0);
		if (target === 'oauth') {
			const { homeDir, config } = current();
			for (const identity of readOAuthIdentityMap(homeDir).identities) {
				console.log(
					`${identity.issuer}\t${identity.subject}\t${identity.username}\t${config.credentials[identity.username]?.policy}`
				);
			}
			return;
		}
		const portal = requirePortal(target);
		const { homeDir, config } = current();
		const mapping = readPortalCredentialMap(homeDir, portal);
		const defaultUsername = config.portals[portal].credential;
		console.log(`default\t${defaultUsername}\t${config.credentials[defaultUsername]?.policy}`);
		for (const [userId, username] of Object.entries(mapping.users)) {
			console.log(`${userId}\t${username}\t${config.credentials[username]?.policy}`);
		}
	}
});

export default defineCommand({
	meta: { name: 'credential', description: 'Manage reusable Guardian/MCP credentials' },
	subCommands: { list, add, show, 'set-policy': setPolicy, rotate, remove, map, unmap, mappings }
});
