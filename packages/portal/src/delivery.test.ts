import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from './conversations.js';
import { DeliveryAccess, PortalDelivery, UnconfirmedDeliveryError } from './delivery.js';

const roots: string[] = [];
const stores: ConversationStore[] = [];
const credential = { username: 'owner', key: 'private-credential-must-not-be-stored' };
function open(path: string) { const store = new ConversationStore(path); stores.push(store); return store; }
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'fhold-delivery-')); roots.push(root);
	const path = join(root, 'portal.db');
	const store = open(path);
	const delivery = PortalDelivery.create(store, { id: 'C123:1', key: 'credential:owner:thread:C123:1', user: 'U123', bot: 'UBOT', input: 'Original request', destination: { adapter: 'slack', channel: 'C123', ts: '1', thread: '1' } }, credential);
	return { path, store, delivery };
}
function close(store: ConversationStore) { store.close(); stores.splice(stores.indexOf(store), 1); }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('reopens accepted work without its prompt or credential and edits the same message after an ambiguous final edit', async () => {
	const { path, store, delivery } = fixture();
	let posts = 0;
	const live = delivery.liveReply('answer', 1900, async () => { posts++; return { id: 'posted.1' }; }, async () => {});
	await live.update('Working', true);
	delivery.submitting(); delivery.accepted('private.job', 'private.session');
	delivery.complete('Final result', 'private.session');
	close(store);
	const next = open(path);
	const record = next.delivery('slack', 'C123:1')!;
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(record.input).toBeUndefined();
	expect(JSON.stringify(record)).not.toContain(credential.key);
	expect(readFileSync(path).includes(Buffer.from(credential.key))).toBe(false);
	const resumed = new PortalDelivery(record, next);
	const edits: string[] = [];
	await resumed.liveReply('answer', 1900, async () => { posts++; return { id: 'duplicate' }; }, async (id, text) => { edits.push(`${id}:${text}`); }).update(record.result!, true);
	resumed.finish();
	expect(posts).toBe(1);
	expect(edits).toEqual(['posted.1:Final result']);
	expect(next.pendingDeliveries('slack')).toEqual([]);
	expect(next.delivery('slack', record.id)?.state).toBe('done');
});

test('an unacknowledged send survives reopening and is never automatically posted again', async () => {
	const { path, store, delivery } = fixture();
	let posts = 0;
	const live = delivery.liveReply('answer', 1900, async () => { posts++; throw new Error('Connection lost after send'); }, async () => {});
	await expect(live.update('Working', true)).rejects.toBeInstanceOf(UnconfirmedDeliveryError);
	await expect(live.update('Retry', true)).rejects.toBeInstanceOf(UnconfirmedDeliveryError);
	close(store);
	const next = open(path);
	const resumed = new PortalDelivery(next.delivery('slack', 'C123:1')!, next);
	expect(() => resumed.liveReply('answer', 1900, async () => { posts++; return { id: 'duplicate' }; }, async () => {})).toThrow(UnconfirmedDeliveryError);
	expect(posts).toBe(1);
});

test('a second replacement retries interrupted stale-tail edits using persisted message receipts', async () => {
	const { path, store, delivery } = fixture();
	let posts = 0;
	const messages = new Map<string, string>();
	await delivery.liveReply('answer', 70, async (text) => {
		const id = `reply.${++posts}`; messages.set(id, text); return { id };
	}, async (id, text) => { messages.set(id, text); }).update('Old partial answer '.repeat(10), true);
	delivery.submitting(); delivery.accepted('private.job', 'private.session');
	delivery.complete('Final answer'); close(store);
	const next = open(path);
	const restored = new PortalDelivery(next.delivery('slack', 'C123:1')!, next);
	await expect(restored.liveReply('answer', 70, async () => { posts++; return { id: 'duplicate' }; }, async (id, text) => {
		if (id === 'reply.2') throw new Error('Interrupted tail edit');
		messages.set(id, text);
	}).update('Final answer', true)).rejects.toThrow('Interrupted tail edit');
	close(next);
	const reopened = open(path);
	const retried = new PortalDelivery(reopened.delivery('slack', 'C123:1')!, reopened);
	expect(retried.record.state).toBe('complete');
	expect(retried.record.messages.answer[0].text).toBe('Final answer');
	const edits: string[] = [];
	await retried.liveReply('answer', 70, async () => { posts++; return { id: 'duplicate' }; }, async (id, text) => {
		edits.push(id); messages.set(id, text);
	}).update('Final answer', true);
	retried.finish();
	expect(posts).toBe(3);
	expect(edits).toEqual(['reply.2', 'reply.3']);
	expect([...messages.values()]).toEqual(['Final answer', 'Previous response replaced. Use the current response above.', 'Previous response replaced. Use the current response above.']);
	expect(reopened.pendingDeliveries('slack')).toEqual([]);
});

test('an ambiguous submission cannot be submitted twice, and changed credentials cannot recover work', () => {
	const { path, store, delivery } = fixture();
	delivery.submitting(); close(store);
	const next = open(path);
	const resumed = new PortalDelivery(next.delivery('slack', 'C123:1')!, next);
	expect(() => resumed.submitting()).toThrow('Unknown submission');
	expect(() => resumed.assertCredential({ ...credential, key: 'rotated' })).toThrow('connection key changed');
	expect(() => resumed.assertCredential({ ...credential, username: 'other' })).toThrow('mapping');
	resumed.assertCredential(credential);
});

test('recovery preserves request arrival order even when older work publishes newer progress', () => {
	const { store, delivery } = fixture();
	PortalDelivery.create(store, { ...delivery.record, id: 'C123:2', input: 'Second request' }, credential);
	delivery.accepted('first.job', 'first.session');
	expect(store.pendingDeliveries('slack').map((record) => record.id)).toEqual(['C123:1', 'C123:2']);
});

test('a failed credential lookup blocks publishing permanently for that delivery, even if credentials reappear', async () => {
	const { store, delivery } = fixture();
	let available = false;
	let writes = 0;
	const access = new DeliveryAccess(delivery, () => {
		if (!available) throw new Error('Credential bundle unavailable');
		return credential;
	});
	await expect(access.write(async () => { writes++; })).rejects.toThrow('connection key is no longer valid');
	available = true;
	await expect(access.write(async () => { writes++; })).rejects.toThrow('revoked');
	expect(access.revoked).toBe(true);
	expect(store.delivery('slack', delivery.record.id)?.state).toBe('blocked');
	expect(writes).toBe(0);
});

test('new permission controls reuse their known message without persisting decisions or posting duplicates', async () => {
	const { path, store, delivery } = fixture();
	let posts = 0;
	await delivery.liveReply('prompt', 1900, async () => { posts++; return { id: 'permission.1' }; }, async () => {}).update('Approve this command?', true);
	delivery.prompt('permission.1', 0); delivery.accepted('job', 'session'); close(store);
	const next = open(path);
	const resumed = new PortalDelivery(next.delivery('slack', 'C123:1')!, next);
	resumed.refreshPrompt();
	let edited = '';
	await resumed.liveReply('prompt', 1900, async () => { posts++; return { id: 'duplicate' }; }, async (id) => { edited = id; }).update('Approve this command?', true);
	expect(posts).toBe(1); expect(edited).toBe('permission.1');
	expect(JSON.stringify(resumed.record)).not.toContain('decision');
});

test('a SIGKILL after native Node SQLite commit retains accepted work and the acknowledged platform message', async () => {
	const root = mkdtempSync(join(tmpdir(), 'fhold-node-delivery-')); roots.push(root);
	const path = join(root, 'portal.db');
	const source = join(root, 'writer.ts');
	writeFileSync(source, `import {ConversationStore} from ${JSON.stringify(join(import.meta.dir, 'conversations.ts'))};
import {PortalDelivery} from ${JSON.stringify(join(import.meta.dir, 'delivery.ts'))};
if(process.versions.bun) throw new Error('This crash test requires native Node');
const store=new ConversationStore(process.argv[2]);
const delivery=PortalDelivery.create(store,{id:'crash',key:'credential:owner:thread:C123:1',user:'U123',bot:'UBOT',input:'original',destination:{adapter:'slack',channel:'C123',ts:'1',thread:'1'}},{username:'owner',key:'private-fixture-key'});
await delivery.liveReply('answer',1900,async()=>({id:'platform.1'}),async()=>{}).update('Working',true);
delivery.submitting();delivery.accepted('accepted.job','accepted.session');
console.log('committed');setInterval(()=>{},1000);`);
	const built = await Bun.build({ entrypoints: [source], outdir: root, naming: 'writer.mjs', target: 'node' });
	expect(built.success).toBe(true);
	const child = Bun.spawn(['node', join(root, 'writer.mjs'), path], { stdout: 'pipe', stderr: 'pipe' });
	try {
		const reader = child.stdout.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain('committed');
		child.kill('SIGKILL'); await child.exited;
		const reopened = open(path);
		const record = reopened.delivery('slack', 'crash')!;
		expect(record.job).toBe('accepted.job');
		expect(record.messages.answer[0].id).toBe('platform.1');
		expect(record.input).toBeUndefined();
	} finally { child.kill('SIGKILL'); await child.exited; }
});
