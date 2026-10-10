import type { NativeWorkerContext } from './native-worker.js';

/** Offline native v2 transfer. v1 archives are converted by OpenCode itself on
 * a private SQLite snapshot; fhold never writes the engine's schema or events. */
export async function nativeHistoryJob({
	snapshot,
	open,
	close,
	api
}: NativeWorkerContext): Promise<void> {
	const fs = await import('node:fs');
	const crypto = await import('node:crypto');
	type Obj = Record<string, unknown>;
	type Transcript = { info: Obj; messages: Obj[] };
	const object = (value: unknown): Obj => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid native history object.');
		return value as Obj;
	};
	const canonical = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(canonical)
			: value && typeof value === 'object'
				? Object.fromEntries(
						Object.entries(value)
							.filter(([, item]) => item !== undefined)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([key, item]) => [key, canonical(item)])
					)
				: value;
	const hash = (value: unknown) =>
		crypto
			.createHash('sha256')
			.update(JSON.stringify(canonical(value)))
			.digest('hex');
	const fileHash = async (path: string) => {
		const digest = crypto.createHash('sha256');
		for await (const chunk of fs.createReadStream(path)) digest.update(chunk);
		return { bytes: fs.statSync(path).size, sha256: digest.digest('hex') };
	};
	const write = (file: string, value: unknown) => {
		const temporary = `${file}.tmp`;
		const fd = fs.openSync(temporary, 'w', 0o600);
		try {
			fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(temporary, file);
	};
	const read = (file: string): unknown => {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ** 2)
			throw new Error('Invalid or oversized history file.');
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	};
	const id = (value: unknown) => {
		if (typeof value !== 'string' || !/^ses_[A-Za-z0-9_-]{1,128}$/.test(value))
			throw new Error('Invalid session ID.');
		return value;
	};
	const pages = async (path: string): Promise<Obj[]> => {
		const rows: Obj[] = [];
		let cursor: string | undefined;
		do {
			const page = object(
				await api(
					// Native cursors carry ordering and must not be combined with order.
					`${path}?limit=200&${cursor ? `cursor=${encodeURIComponent(cursor)}` : 'order=asc'}`
				)
			);
			if (!Array.isArray(page.data)) throw new Error('Native history response is invalid.');
			rows.push(...page.data.map(object));
			if (rows.length > 100_000)
				throw new Error('Native history inventory exceeds 100,000 entries.');
			cursor = page.data.length ? (object(page.cursor).next as string | undefined) : undefined;
		} while (cursor);
		return rows;
	};
	const transcript = async (session: string): Promise<Transcript> => ({
		info: object(object(await api(`/session/${session}`)).data),
		// Native export deliberately omits unfinished messages. Keep them in the
		// archive using the native paginated timeline; require explicit review to
		// terminalize them on import, never quietly discard them or replay tools.
		messages: await pages(`/session/${session}/message`)
	});
	const mode = process.env.FH_HISTORY_MODE;
	const sourceData = '/tmp/history-source';
	const stageData = '/tmp/history-target';
	for (const directory of [sourceData, stageData])
		fs.mkdirSync(`${directory}/opencode`, { recursive: true, mode: 0o700 });
	if (mode === 'export') {
		snapshot('/source/opencode.db', '/recovery/source.sqlite');
		fs.copyFileSync('/recovery/source.sqlite', `${sourceData}/opencode/opencode.db`);
		await open(sourceData);
		const sessions = [];
		for (const session of await pages('/session')) {
			const sessionID = id(session.id);
			const data = await transcript(sessionID);
			const file = `/recovery/${sessionID}.json`;
			write(file, data);
			sessions.push({
				id: sessionID,
				directory: object(data.info.location).directory,
				...(await fileHash(file)),
				messages: data.messages.length,
				parts: data.messages.reduce(
					(sum, message) => sum + (Array.isArray(message.content) ? message.content.length : 0),
					0
				)
			});
		}
		write('/recovery/history.json', {
			product: 'fhold',
			version: 2,
			scope: 'native-history',
			sourceSnapshot: await fileHash('/recovery/source.sqlite'),
			sessions
		});
		return;
	}
	const manifest = object(read('/archive/history.json'));
	if (
		manifest.product !== 'fhold' ||
		![1, 2].includes(Number(manifest.version)) ||
		manifest.scope !== 'native-history' ||
		!Array.isArray(manifest.sessions)
	)
		throw new Error('Invalid native history archive.');
	const entries = manifest.sessions.map(object);
	const interrupted: Array<{ session: string; message: unknown; tool?: unknown }> = [];
	const archiveInterrupted = process.env.FH_HISTORY_ARCHIVE_INTERRUPTED === '1';
	if (entries.length > 10_000) throw new Error('History exceeds 10,000 sessions.');
	const raw = new Map<string, Transcript>();
	for (const entry of entries) {
		const session = id(entry.id);
		if (raw.has(session)) throw new Error('Duplicate archive session ID.');
		const file = `/archive/${session}.json`;
		if ((await fileHash(file)).sha256 !== entry.sha256)
			throw new Error('History archive checksum mismatch.');
		const data = object(read(file));
		if (
			object(data.info).id !== session ||
			!Array.isArray(data.messages) ||
			data.messages.length !== entry.messages
		)
			throw new Error('History inventory does not match its transcript.');
		raw.set(session, { info: object(data.info), messages: data.messages.map(object) });
		if (manifest.version === 1)
			for (const message of data.messages.map(object)) {
				for (const part of Array.isArray(message.parts) ? message.parts.map(object) : []) {
					if (
						part.type !== 'tool' ||
						!['pending', 'running'].includes(String(object(part.state).status))
					)
						continue;
					if (!archiveInterrupted)
						throw new Error(
							'Interrupted tool calls require explicit --archive-interrupted; nothing was replayed or discarded.'
						);
					interrupted.push({ session, message: object(message.info).id, tool: part.id });
				}
			}
	}
	if (manifest.version === 1) {
		if (hash(await fileHash('/archive/source.sqlite')) !== hash(manifest.sourceSnapshot))
			throw new Error('Legacy source snapshot checksum mismatch.');
		fs.copyFileSync('/archive/source.sqlite', `${sourceData}/opencode/opencode.db`);
		await open(sourceData);
		for (const session of raw.keys()) raw.set(session, await transcript(session));
		await close();
	}
	const directories = object(read('/recovery/directories.json'));
	const selected = new Map<string, { data: Transcript; target: string; fingerprint: string }>();
	const messageIDs = new Set<string>();
	let parts = 0;
	for (const entry of entries) {
		const session = id(entry.id);
		const data = raw.get(session)!;
		const target = directories[String(entry.directory)];
		if (
			typeof target !== 'string' ||
			!(target === '/work' || target.startsWith('/work/')) ||
			fs.realpathSync(target) !== target ||
			!fs.statSync(target).isDirectory()
		)
			throw new Error(
				'Every source directory requires an exact existing /work mapping without symlinks.'
			);
		const info: Obj = {};
		for (const key of [
			'id',
			'slug',
			'version',
			'title',
			'time',
			'parentID',
			'cost',
			'tokens',
			'outcome'
		])
			if (data.info[key] !== undefined) info[key] = data.info[key];
		info.location = { directory: target };
		// Required native identity fields are replaced by native import. Never
		// carry credential ownership, permissions, agents or old runtime intent.
		info.projectID = data.info.projectID;
		info.subpath = data.info.subpath;
		for (const message of data.messages) {
			if (typeof message.id !== 'string' || messageIDs.has(message.id))
				throw new Error('Duplicate archive message ID.');
			messageIDs.add(message.id);
			delete message.metadata;
			const time = object(message.time);
			const unfinished =
				(message.type === 'assistant' && time.completed === undefined) ||
				(['shell', 'compaction'].includes(String(message.type)) && message.status === 'running');
			if (unfinished) {
				if (!archiveInterrupted)
					throw new Error(
						'Interrupted history requires explicit --archive-interrupted; nothing was replayed or discarded.'
					);
				interrupted.push({ session, message: message.id });
				const error = {
					type: 'aborted',
					message: 'Interrupted before history recovery; not executed or replayed.'
				};
				if (message.type === 'assistant') {
					time.completed = Math.max(Number(time.created), Number(object(info.time).updated));
					message.error = error;
				} else if (message.type === 'compaction') {
					message.status = 'failed';
					message.error = error;
				} else {
					message.status = 'killed';
					time.completed = Number(time.created);
				}
			}
			for (const rawPart of Array.isArray(message.content) ? message.content : []) {
				parts++;
				const part = object(rawPart);
				if (part.type !== 'tool') continue;
				const state = object(part.state);
				if (!['streaming', 'running'].includes(String(state.status))) continue;
				if (!archiveInterrupted)
					throw new Error('Interrupted tool calls require explicit --archive-interrupted.');
				interrupted.push({ session, message: message.id, tool: part.id });
				part.state = {
					status: 'error',
					input: typeof state.input === 'object' ? state.input : {},
					error: {
						type: 'tool.interrupted',
						message: 'Interrupted before history recovery; not executed or replayed.'
					}
				};
			}
		}
		const clean = { info, messages: data.messages };
		selected.set(session, { data: clean, target, fingerprint: hash(clean) });
	}
	// Parent sessions must precede child imports; do not silently flatten history.
	const ordered: Array<[string, { data: Transcript; target: string; fingerprint: string }]> = [];
	const pending = new Map(selected);
	while (pending.size) {
		let progress = false;
		for (const [session, item] of pending)
			if (!pending.has(String(item.data.info.parentID))) {
				ordered.push([session, item]);
				pending.delete(session);
				progress = true;
			}
		if (!progress) throw new Error('History contains a cycle in parent sessions.');
	}
	if (fs.existsSync('/target/opencode.db')) {
		snapshot('/target/opencode.db', '/recovery/target-before.sqlite');
		fs.copyFileSync('/recovery/target-before.sqlite', `${stageData}/opencode/opencode.db`);
	}
	await open(stageData);
	const before = new Map<string, Transcript>();
	const targetMessageIDs = new Set<string>();
	for (const session of await pages('/session')) {
		const data = await transcript(id(session.id));
		before.set(id(session.id), data);
		for (const message of data.messages) targetMessageIDs.add(String(message.id));
	}
	const journalFile = '/target/fhold-history-journal.json';
	const journal = fs.existsSync(journalFile) ? object(read(journalFile)) : {};
	const completed = new Set<string>();
	const verified = (expected: Transcript, actual: Transcript, target: string) =>
		hash(expected.messages) === hash(actual.messages) &&
		object(actual.info.location).directory === target &&
		expected.info.parentID === actual.info.parentID &&
		expected.info.title === actual.info.title &&
		!actual.info.metadata &&
		(!Array.isArray(actual.info.permissions) || !actual.info.permissions.length);
	for (const [session, item] of ordered) {
		const old = before.get(session);
		if (old) {
			const previous = journal[session] ? object(journal[session]) : {};
			// A completed import may since have new messages, a new title or new
			// settings. Preserve that subsequent work on retry. Only the imported
			// message prefix must still match; never overwrite a colliding session.
			const matches =
				previous.complete === true
					? hash(item.data.messages) === hash(old.messages.slice(0, item.data.messages.length))
					: verified(item.data, old, item.target);
			if (previous.fingerprint !== item.fingerprint || !matches)
				throw new Error('Destination session ID collision; nothing will be overwritten.');
			completed.add(session);
		} else
			for (const message of item.data.messages)
				if (targetMessageIDs.has(String(message.id)))
					throw new Error('Destination message ID collision; nothing will be overwritten.');
	}
	const importOne = async (session: string, item: { data: Transcript; target: string }) => {
		await api('/experimental/session/import', {
			...item.data,
			location: { directory: item.target }
		});
		if (!verified(item.data, await transcript(session), item.target))
			throw new Error('Native round-trip content verification failed; private originals retained.');
	};
	for (const [session, item] of ordered)
		if (!completed.has(session)) await importOne(session, item);
	for (const [session, data] of before)
		if (hash(await transcript(session)) !== hash(data))
			throw new Error('Existing target history changed during preflight; target unchanged.');
	await close();
	if (mode === 'restore') {
		await open('/native-data');
		for (const [session, item] of ordered) {
			if (completed.has(session)) continue;
			journal[session] = { fingerprint: item.fingerprint, complete: false };
			write(journalFile, journal);
			await importOne(session, item);
			journal[session] = { fingerprint: item.fingerprint, complete: true };
			write(journalFile, journal);
		}
		for (const [session, data] of before)
			if (hash(await transcript(session)) !== hash(data))
				throw new Error('Existing target history preservation check failed.');
	}
	write('/recovery/receipt.json', {
		scope: 'native-history',
		sessions: selected.size,
		messages: messageIDs.size,
		parts,
		applied: mode === 'restore',
		interruptedTools: interrupted.length,
		interruptedCalls: interrupted,
		existingSessionsPreserved: before.size,
		directories,
		limitations: [
			'Native transcript transfer excludes credentials, portal handles, old ownership and permission authority.',
			'Native import does not reconstruct fork origin, revert state, worktrees or file snapshots. Use entire-instance export for complete same-instance recovery.'
		]
	});
}
