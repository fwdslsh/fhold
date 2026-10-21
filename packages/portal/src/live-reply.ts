import { splitMessage } from './runtime.js';

export type EditableReply = { edit: (text: string) => Promise<unknown> };

/** Render full MCP text snapshots as throttled edits, not a message per token.
 * Flush final text even when the last progress update fell inside the throttle.
 */
export class LiveReply {
	private nextUpdate = 0;

	constructor(
		private readonly post: (text: string, index: number) => Promise<EditableReply>,
		private readonly maxLength: number,
		private readonly now: () => number = Date.now,
		private readonly messages: Array<{ reply: EditableReply; text: string }> = []
	) {}

	async update(text: string, final = false): Promise<void> {
		if (!text || (!final && this.now() < this.nextUpdate)) return;
		const chunks = splitMessage(text, this.maxLength);
		for (const [index, chunk] of chunks.entries()) {
			const previous = this.messages[index];
			if (previous?.text === chunk) continue;
			if (previous) {
				await previous.reply.edit(chunk);
				previous.text = chunk;
			} else {
				this.messages.push({ reply: await this.post(chunk, index), text: chunk });
			}
		}
		// A recovered or final snapshot may be shorter than streamed progress.
		// Retire only our acknowledged messages; never leave obsolete answer text.
		if (final) {
			const retired = 'Previous response replaced. Use the current response above.'.slice(0, this.maxLength);
			for (const previous of this.messages.slice(chunks.length)) {
				if (previous.text === retired) continue;
				await previous.reply.edit(retired);
				previous.text = retired;
			}
		}
		this.nextUpdate = final ? 0 : this.now() + 1_200;
	}
}

export function toolEmoji(name: string): { discord: string; slack: string } {
	if (name.includes('akm')) {
		if (/search|curate/.test(name)) return { discord: '🔎', slack: 'mag' };
		if (/memory|remember/.test(name)) return { discord: '🧠', slack: 'brain' };
		return { discord: '📚', slack: 'books' };
	}
	if (/bash|shell/.test(name)) return { discord: '🐚', slack: 'shell' };
	if (/read|glob|grep|list/.test(name)) return { discord: '📄', slack: 'page_facing_up' };
	if (/write|edit|patch/.test(name)) return { discord: '✏️', slack: 'pencil2' };
	if (/webfetch|websearch/.test(name)) return { discord: '🌐', slack: 'globe_with_meridians' };
	if (/task|agent/.test(name)) return { discord: '🤖', slack: 'robot_face' };
	return { discord: '🔧', slack: 'wrench' };
}
