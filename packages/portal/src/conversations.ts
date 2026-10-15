import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { parseDelivery, type DeliveryRecord } from './delivery.js';

const MAX_HANDLE_LENGTH = 2_048;
const MAX_KEY_LENGTH = 512;

export class ConversationStore {
	private readonly database: DatabaseSync;

	constructor(path = process.env.PORTAL_STATE_PATH ?? '/var/lib/fhold/portal.db') {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.database = new DatabaseSync(path);
		if (path !== ':memory:') {
			chmodSync(path, 0o600);
			for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
		}
		this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
		this.database.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        adapter TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        handle TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (adapter, conversation_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS deliveries (
        adapter TEXT NOT NULL,
        request_id TEXT NOT NULL,
        state TEXT NOT NULL,
        record TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (adapter, request_id)
      ) STRICT;
    `);
	}

	get(adapter: string, key: string): string | undefined {
		if (!key || key.length > MAX_KEY_LENGTH) return undefined;
		const row = this.database
			.prepare('SELECT handle FROM conversations WHERE adapter = ? AND conversation_key = ?')
			.get(adapter, key) as { handle: string } | null;
		return row && typeof row.handle === 'string' && row.handle.length <= MAX_HANDLE_LENGTH
			? row.handle
			: undefined;
	}

	set(adapter: string, key: string, handle: string): void {
		if (!key || key.length > MAX_KEY_LENGTH) throw new Error('invalid conversation key');
		if (!handle || handle.length > MAX_HANDLE_LENGTH)
			throw new Error('invalid conversation handle');
		this.database
			.prepare(`
      INSERT INTO conversations (adapter, conversation_key, handle, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(adapter, conversation_key) DO UPDATE SET
        handle = excluded.handle,
        updated_at = excluded.updated_at
    `)
			.run(adapter, key, handle, Date.now());
	}

	clear(adapter: string, key: string): void {
		this.database
			.prepare('DELETE FROM conversations WHERE adapter = ? AND conversation_key = ?')
			.run(adapter, key);
	}

	saveDelivery(record: DeliveryRecord): void {
		parseDelivery(record);
		const body = JSON.stringify(record);
		if (Buffer.byteLength(body) > 2_097_152) throw new Error('Portal delivery exceeds its private record limit.');
		this.database.prepare(`INSERT INTO deliveries VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(adapter, request_id) DO UPDATE SET state=excluded.state, record=excluded.record, updated_at=excluded.updated_at`)
			.run(record.destination.adapter, record.id, record.state, body, Date.now());
		if (record.state === 'done' || record.state === 'blocked')
			this.database.prepare("DELETE FROM deliveries WHERE state IN ('done','blocked') AND updated_at < ?").run(Date.now() - 7 * 86_400_000);
	}

	delivery(adapter: string, id: string): DeliveryRecord | undefined {
		const row = this.database.prepare('SELECT record FROM deliveries WHERE adapter=? AND request_id=?').get(adapter, id) as {record: string} | undefined;
		return row ? parseDelivery(JSON.parse(row.record)) : undefined;
	}

	pendingDeliveries(adapter: string): DeliveryRecord[] {
		return (this.database.prepare("SELECT record FROM deliveries WHERE adapter=? AND state NOT IN ('done','blocked') ORDER BY rowid").all(adapter) as Array<{record: string}>)
			.map((row) => parseDelivery(JSON.parse(row.record)));
	}

	close(): void {
		this.database.close();
	}
}
