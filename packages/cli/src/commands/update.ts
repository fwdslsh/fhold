import { defineCommand } from 'citty';
import { updateHome, createFholdState } from '@fhold/lib';

import { seedSkeletonFromEmbedded } from '../lib/embedded-assets.js';
export async function updateStack(options: { start: boolean; pull?: boolean }): Promise<void> {
	const state = createFholdState();
	const result = await seedSkeletonFromEmbedded(async (homeDir) => updateHome({ homeDir, ...options }), state.homeDir);
	void result;
	console.log(
		options.start
			? 'fhold managed assets refreshed and containers recreated successfully.'
			: 'fhold managed assets refreshed. Running containers were not upgraded; run `fhold restart` to apply them.'
	);
}

export default defineCommand({
	meta: {
		name: 'update',
		description: 'Refresh an existing fhold stack without deleting user data'
	},
	args: {
		pull: {
			type: 'boolean',
			description:
				'Pull explicitly configured registry images (default there); local fhold images never pull. Use --no-pull for registry-local builds.'
		},
		start: {
			type: 'boolean',
			description: 'Apply the refreshed stack after writing it (use --no-start to skip)',
			default: true
		}
	},
	async run({ args }) {
		await updateStack({ start: args.start !== false, pull: args.pull });
	}
});
