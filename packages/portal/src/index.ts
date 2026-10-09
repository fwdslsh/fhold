#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { errorMessage, startHealthServer } from './runtime.js';

export async function startPortal(adapter = process.env.PORTAL_ADAPTER ?? ''): Promise<void> {
	if (adapter !== 'discord' && adapter !== 'slack') {
		throw new Error('PORTAL_ADAPTER must be discord or slack');
	}
	const health = startHealthServer(`portal:${adapter}`);
	if (adapter === 'discord') {
		const { DiscordPortal } = await import('./discord.js');
		const portal = new DiscordPortal();
		await portal.start();
		health.ready(() => portal.isReady());
	} else {
		const { SlackPortal } = await import('./slack.js');
		const portal = new SlackPortal();
		await portal.start();
		health.ready(() => portal.isReady());
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	startPortal().catch((error) => {
		console.error(
			JSON.stringify({
				ts: new Date().toISOString(),
				level: 'error',
				service: 'portal',
				event: 'startup_failed',
				fields: { error: errorMessage(error) }
			})
		);
		process.exit(1);
	});
}
