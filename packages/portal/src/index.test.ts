import { beforeEach, expect, it, mock } from 'bun:test';

const loaded: string[] = [];
const started: string[] = [];
const ready: Array<() => boolean> = [];
let connected = false;

mock.module('./discord.js', () => {
	loaded.push('discord');
	return {
		DiscordPortal: class {
			isReady() {
				return connected;
			}
			async start() {
				started.push('discord');
			}
		}
	};
});

mock.module('./slack.js', () => {
	loaded.push('slack');
	return {
		SlackPortal: class {
			isReady() {
				return connected;
			}
			async start() {
				started.push('slack');
			}
		}
	};
});

mock.module('./runtime.js', () => ({
	errorMessage: (error: unknown) => String(error),
	startHealthServer: () => ({
		ready: (check: () => boolean) => {
			ready.push(check);
		}
	})
}));

const { startPortal } = await import('./index.js');

beforeEach(() => {
	loaded.length = 0;
	started.length = 0;
	ready.length = 0;
	connected = false;
});

it('loads and starts only the selected adapter', async () => {
	await startPortal('discord');
	expect(loaded).toEqual(['discord']);
	expect(started).toEqual(['discord']);
	expect(ready).toHaveLength(1);

	loaded.length = 0;
	started.length = 0;
	ready.length = 0;

	await startPortal('slack');
	expect(loaded).toEqual(['slack']);
	expect(started).toEqual(['slack']);
	expect(ready).toHaveLength(1);
});

it('rejects an unknown adapter before loading modules or opening health', async () => {
	await expect(startPortal('unknown')).rejects.toThrow('PORTAL_ADAPTER must be discord or slack');
	expect(loaded).toEqual([]);
	expect(started).toEqual([]);
	expect(ready).toEqual([]);
});

it('checks the current adapter connection instead of latching startup as healthy', async () => {
	for (const adapter of ['discord', 'slack']) {
		ready.length = 0;
		await startPortal(adapter);
		const check = ready[0];
		expect(check?.()).toBe(false);
		connected = true;
		expect(check?.()).toBe(true);
		connected = false;
		expect(check?.()).toBe(false);
	}
});
