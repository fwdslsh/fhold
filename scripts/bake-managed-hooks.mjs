#!/usr/bin/env bun
// Build-time registration of the pinned plugins' existing handlers. No vendor
// files or user approvals are rewritten; native managed policy owns execution.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const plugins = [
	{ id: 'akm@akm-plugins', root: '/akm-marketplace/claude' },
	{ id: 'fhold@fhold-plugins', root: '/fhold-plugins/fhold' }
];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function managedHooks(harness, manifests) {
	const hooks = {};
	const inventory = {};
	for (const { id, root, definition } of manifests) {
		inventory[id] = [];
		for (const [event, groups] of Object.entries(definition.hooks ?? definition)) {
			if (!Array.isArray(groups)) throw Error(`Invalid ${id} ${event} hook groups`);
			for (const group of groups) {
				const handlers = group.hooks.map((handler) => {
					if (handler.type !== 'command' || typeof handler.command !== 'string')
						throw Error(`Unsupported ${id} hook handler`);
					const state =
						harness === 'codex'
							? `\${CODEX_HOME:-\${HOME}/.codex}/plugins/data/${id.replace('@', '-')}`
							: `\${HOME}/.local/state/akm-claude`;
					const bind = (value) =>
						value
							.replaceAll('${PLUGIN_ROOT}', root)
							.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
							.replaceAll('${PLUGIN_DATA}', state)
							.replaceAll('${CLAUDE_PLUGIN_DATA}', state);
					const { args, commandWindows: _windows, ...result } = handler;
					result.command = bind(handler.command);
					if (args !== undefined) {
						if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
							throw Error(`Unsupported ${id} hook arguments`);
						result.command += ` ${args.map((arg) => quote(bind(arg))).join(' ')}`;
					}
					inventory[id].push({
						event: event[0].toLowerCase() + event.slice(1),
						command: result.command
					});
					return result;
				});
				hooks[event] ??= [];
				hooks[event].push({ ...group, hooks: handlers });
			}
		}
	}
	return { hooks, inventory };
}

export function bakeManagedHooks(output = '/') {
	const write = (path, data) => {
		const target = join(output, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
	};
	for (const harness of ['codex', 'claude']) {
		const manifests = plugins.map(({ id, root }) => {
			const manifest = read(join(root, `.${harness}-plugin/plugin.json`));
			const definition =
				typeof manifest.hooks === 'string' ? read(join(root, manifest.hooks)) : manifest.hooks;
			if (!definition) throw Error(`Missing ${id} ${harness} hooks`);
			return { id, root, definition };
		});
		const { hooks, inventory } = managedHooks(harness, manifests);
		if (harness === 'codex') {
			write('etc/codex/hooks.json', { hooks });
			write('opt/fhold/codex-managed-hooks.json', inventory);
		} else {
			write('etc/claude-code/managed-settings.d/10-fhold.json', { hooks });
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	bakeManagedHooks(process.argv[2] ?? '/');
