import { createHash } from 'node:crypto';

import type { ConversationStore } from './conversations.js';
import type { PortalCredential } from './credential-registry.js';
import { PortalAccessError } from './credential-registry.js';
import { LiveReply, type EditableReply } from './live-reply.js';

export type DeliveryDestination =
	| { adapter: 'discord'; sourceChannel: string; sourceMessage: string; channel: string; guild: string | null }
	| { adapter: 'slack'; channel: string; ts: string; thread: string; channelType?: string };
type MessageReceipt = { id?: string; text: string };
export type DeliveryRecord = {
	version: 1;
	id: string;
	key: string;
	user: string;
	username: string;
	credentialDigest: string;
	bot: string;
	destination: DeliveryDestination;
	state: 'queued' | 'submitted' | 'tracking' | 'complete' | 'done' | 'blocked';
	input?: string;
	job?: string;
	conversation?: string;
	result?: string;
	messages: Record<string, MessageReceipt[]>;
	prompt?: { message: string; questionIndex: number };
	reason?: string;
};

export class UnconfirmedDeliveryError extends Error {
	constructor() {
		super('A platform send was interrupted before its message ID was saved. Check the conversation in OpenCode; it was not sent again.');
	}
}

const digest = (credential: PortalCredential) => createHash('sha256').update(credential.key).digest('hex');

export function parseDelivery(value: unknown): DeliveryRecord {
	const record = value as DeliveryRecord;
	if (!record || record.version !== 1 ||
		!['discord', 'slack'].includes(record.destination?.adapter) ||
		!['queued', 'submitted', 'tracking', 'complete', 'done', 'blocked'].includes(record.state) ||
		!['id', 'key', 'user', 'username', 'credentialDigest', 'bot'].every((key) =>
			typeof record[key as keyof DeliveryRecord] === 'string' && String(record[key as keyof DeliveryRecord]).length <= 1024) ||
		!record.id || !record.key || !record.user || !record.messages || Array.isArray(record.messages) ||
		Object.values(record.messages).some((messages) => !Array.isArray(messages) || messages.length > 64 ||
			messages.some((message) => typeof message.text !== 'string' || message.text.length > 4000 ||
				(message.id !== undefined && (typeof message.id !== 'string' || message.id.length > 128)))))
		throw new Error('Invalid private Portal delivery record.');
	const destination = record.destination;
	const fields = destination.adapter === 'slack' ? [destination.channel, destination.ts, destination.thread] : [destination.sourceChannel, destination.sourceMessage, destination.channel];
	if (fields.some((field) => typeof field !== 'string' || !field || field.length > 128) ||
		!record.bot || !/^[a-f0-9]{64}$/.test(record.credentialDigest) ||
		!record.key.startsWith(`credential:${record.username}:`) ||
		[record.input, record.result].some((text) => text !== undefined && (typeof text !== 'string' || text.length > 100_000)) ||
		[record.job, record.conversation].some((handle) => handle !== undefined && (typeof handle !== 'string' || !handle || handle.length > 2048)))
		throw new Error('Invalid private Portal delivery metadata.');
	return record;
}

/** One accepted platform request. No credentials or approval decisions are saved.
 * Persist before submission/posting; only inspection and edits of known messages
 * can be repeated after a crash. Unknown submissions/sends require explicit review.
 */
export class PortalDelivery {
	constructor(readonly record: DeliveryRecord, private readonly store: ConversationStore) {}

	static create(store: ConversationStore, input: Omit<DeliveryRecord, 'version' | 'state' | 'messages' | 'credentialDigest' | 'username'>, credential: PortalCredential): PortalDelivery {
		const delivery = new PortalDelivery({ ...input, version: 1, state: 'queued', messages: {}, username: credential.username, credentialDigest: digest(credential) }, store);
		delivery.save();
		return delivery;
	}

	private save(): void { this.store.saveDelivery(this.record); }

	assertCredential(credential: PortalCredential): void {
		if (credential.username !== this.record.username || digest(credential) !== this.record.credentialDigest)
			throw new Error('The access mapping or connection key changed; pending work was not replayed.');
	}

	submitting(): void {
		if (this.record.state !== 'queued' || !this.record.input) throw new Error('Unknown submission must not be repeated.');
		this.record.state = 'submitted';
		this.save();
	}

	accepted(job: string, conversation: string): void {
		this.record.job = job;
		this.record.conversation = conversation;
		this.record.state = 'tracking';
		delete this.record.input;
		this.save();
	}

	complete(text: string, conversation?: string): void {
		this.record.result = text.slice(0, 100_000);
		if (conversation) this.record.conversation = conversation;
		this.record.state = 'complete';
		delete this.record.input;
		this.save();
	}

	blocked(reason: string): void {
		this.record.state = 'blocked';
		this.record.reason = reason.slice(0, 500);
		delete this.record.input;
		this.save();
	}

	finish(): void {
		this.record.state = 'done';
		this.record.messages = {};
		delete this.record.input;
		delete this.record.result;
		delete this.record.job;
		delete this.record.prompt;
		this.save();
	}

	prompt(message: string, questionIndex: number): void {
		this.record.prompt = { message, questionIndex };
		this.save();
	}

	refreshPrompt(): void {
		for (const receipt of this.record.messages.prompt ?? []) receipt.text = '';
		this.save();
	}

	/** A saved post intent without an acknowledged ID must never be posted twice. */
	liveReply(stream: string, maxLength: number,
		post: (text: string) => Promise<{ id: string }>,
		edit: (id: string, text: string) => Promise<unknown>): LiveReply {
		const receipts = this.record.messages[stream] ??= [];
		if (receipts.some((receipt) => !receipt.id)) throw new UnconfirmedDeliveryError();
		const editable = (index: number): EditableReply => ({
			edit: async (text) => {
				await edit(receipts[index].id!, text);
				receipts[index].text = text;
				this.save();
			}
		});
		return new LiveReply(async (text, index) => {
			if (index >= 64) throw new Error('Portal reply exceeds its message limit.');
			if (receipts[index]) throw new UnconfirmedDeliveryError();
			const receipt: MessageReceipt = { text };
			receipts.push(receipt);
			this.save();
			let posted;
			try { posted = await post(text); }
			catch { throw new UnconfirmedDeliveryError(); }
			if (!posted.id || posted.id.length > 128) throw new Error('Platform did not acknowledge the message ID.');
			receipt.id = posted.id;
			this.save();
			return editable(index);
		}, maxLength, Date.now, receipts.map((receipt, index) => ({ reply: editable(index), text: receipt.text })));
	}
}

/** Authorization is independent of best-effort progress rendering. Once a
 * credential lookup fails or changes, this delivery cannot resume publishing.
 */
export class DeliveryAccess {
	private rejected = false;
	get revoked(): boolean { return this.rejected; }

	constructor(private readonly delivery: PortalDelivery, private readonly resolve: () => PortalCredential) {}

	credential(): PortalCredential {
		if (this.rejected) throw new PortalAccessError('Access to this pending delivery was revoked.');
		try {
			const credential = this.resolve();
			this.delivery.assertCredential(credential);
			return credential;
		} catch {
			this.rejected = true;
			const reason = 'The access mapping or connection key is no longer valid; pending delivery was blocked. Check the original session in OpenCode.';
			this.delivery.blocked(reason);
			throw new PortalAccessError(reason);
		}
	}

	async write<T>(action: () => Promise<T>): Promise<T> {
		this.credential();
		return action();
	}
}
