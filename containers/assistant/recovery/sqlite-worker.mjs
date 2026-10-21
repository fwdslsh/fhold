import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';

// This process never initializes a missing source or marks a live WAL database
// immutable. VACUUM INTO is a SQLite-native standalone transaction snapshot.
const [operation, source, destination, maxBytesText] = process.argv.slice(2);
const maxBytes = Number(maxBytesText);
if (
	!['capture', 'verify', 'describe'].includes(operation) ||
	!source ||
	!Number.isSafeInteger(maxBytes) ||
	maxBytes < 1
)
	throw new Error('invalid SQLite worker arguments');
const sourceStat = fs.lstatSync(source);
if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > maxBytes)
	throw new Error('SQLite source rejected');
const database = new Database(source, { readonly: true, strict: true });
try {
	database.exec('PRAGMA busy_timeout = 1000');
	if (operation === 'describe') {
		const schema = Number(
			database.query("SELECT value FROM index_meta WHERE key='version'").get()?.value
		);
		const entries = database.query('SELECT count(*) AS count FROM entries').get().count;
		const builtAt = database.query("SELECT value FROM index_meta WHERE key='builtAt'").get()?.value;
		const stashDir = database
			.query("SELECT value FROM index_meta WHERE key='stashDir'")
			.get()?.value;
		if (!Number.isSafeInteger(schema) || schema < 1) throw new Error('unsupported index metadata');
		console.log(JSON.stringify({ schema, entries, builtAt, stashDir }));
	}
	if (operation === 'capture') {
		if (!destination || fs.existsSync(destination)) throw new Error('SQLite output must be new');
		database.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
	}
	const check = operation === 'capture' ? new Database(destination, { readonly: true }) : database;
	try {
		if (
			check
				.query('PRAGMA integrity_check')
				.all()
				.some((row) => Object.values(row)[0] !== 'ok')
		)
			throw new Error('SQLite integrity failed');
		if (fs.statSync(operation === 'capture' ? destination : source).size > maxBytes)
			throw new Error('SQLite output exceeds limit');
	} finally {
		if (check !== database) check.close();
	}
} finally {
	database.close();
}
