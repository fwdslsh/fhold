import { describe, expect, it, mock } from 'bun:test';

import { LiveReply, toolEmoji } from './live-reply.js';
import { splitMessage } from './runtime.js';

describe('live portal replies', () => {
	it('edits snapshots, throttles intermediate updates and always flushes final text', async () => {
		let now = 0;
		const edit = mock(async (_text: string) => {});
		const post = mock(async (_text: string) => ({ edit }));
		const live = new LiveReply(post, 20, () => now);
		await live.update('Beginning');
		await live.update('Beginning to work');
		expect(edit).not.toHaveBeenCalled();
		now = 1_200;
		await live.update('Beginning to work');
		await live.update('Done', true);
		expect(post).toHaveBeenCalledTimes(1);
		expect(edit.mock.calls.map(([text]) => text)).toEqual(['Beginning to work', 'Done']);
	});

	it('retries failed edits, splits long output and does not duplicate an unchanged final result', async () => {
		const edits: string[] = [];
		const edit = mock(async (text: string) => {
			edits.push(text);
		});
		const post = mock(async (_text: string) => ({ edit }));
		const live = new LiveReply(post, 10);
		await live.update('Starting');
		edit.mockRejectedValueOnce(new Error('temporary platform failure'));
		await expect(live.update('Finished with more text', true)).rejects.toThrow('temporary');
		await live.update('Finished with more text', true);
		await live.update('Finished with more text', true);
		expect(post.mock.calls.map(([text]) => text)).toEqual(['Starting', 'ith more t', 'ext']);
		expect(edits).toEqual(['Finished w']);
	});

	it('keeps emoji surrogate pairs intact at message limits', () => {
		const text = `${'x'.repeat(9)}🧠${'y'.repeat(10)}`;
		const chunks = splitMessage(text, 10);
		expect(chunks.join('')).toBe(text);
		expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
		expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
	});

	it('uses matching Discord and Slack reactions for knowledge, files and commands', () => {
		expect(toolEmoji('akm_search')).toEqual({ discord: '🔎', slack: 'mag' });
		expect(toolEmoji('akm_remember').discord).toBe('🧠');
		expect(toolEmoji('bash').discord).toBe('🐚');
		expect(toolEmoji('apply_patch').discord).toBe('✏️');
		expect(toolEmoji('read').discord).toBe('📄');
		expect(toolEmoji('webfetch').discord).toBe('🌐');
		expect(toolEmoji('unknown').discord).toBe('🔧');
	});
});
