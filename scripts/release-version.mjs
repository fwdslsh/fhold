export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.([1-9]\d{9})(?:-(alpha|beta|rc)(?:\.([1-9]\d*))?)?$/;

export function parseSemver(version) {
	const match = String(version).match(SEMVER_RE);
	if (!match) return null;
	const [yy, month, day, hour, minute] = match[3].match(/\d{2}/g).map(Number);
	const date = new Date(Date.UTC(2000 + yy, month - 1, day, hour, minute));
	if (date.getUTCFullYear() !== 2000 + yy || date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) return null;
	const ma = Number(match[1]), mi = Number(match[2]), pa = Number(match[3]);
	const serial = match[5] ? Number(match[5]) : null;
	if (![ma, mi, pa, ...(serial === null ? [] : [serial])].every(Number.isSafeInteger)) return null;
	return { ma, mi, pa, pre: match[4] ? `${match[4]}${match[5] ? `.${match[5]}` : ''}` : null,
		channel: match[4] ?? null, serial, timestamp: date.toISOString() };
}

export function compareVersions(left, right) {
	const a = parseSemver(left), b = parseSemver(right);
	if (!a || !b) throw new Error('Invalid fhold release version');
	for (const key of ['ma', 'mi', 'pa']) if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
	const rank = { alpha: 0, beta: 1, rc: 2, stable: 3 };
	const channel = rank[a.channel ?? 'stable'] - rank[b.channel ?? 'stable'];
	if (channel) return Math.sign(channel);
	return Math.sign((a.serial ?? 0) - (b.serial ?? 0));
}

/** Establish once; persist this result with the release, and never recalculate on retry. */
export function releaseIntent({ version, revision, contentSha256, previous = null, existing = null }) {
	const parsed = parseSemver(version);
	if (!parsed || !/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{64}$/.test(contentSha256))
		throw new Error('Invalid release intent version, revision or content hash');
	const intent = { product: 'fhold', version, revision, contentSha256 };
	if (existing) {
		if (Object.keys(existing).length !== Object.keys(intent).length ||
			Object.keys(intent).some((key) => existing[key] !== intent[key])) throw new Error('Immutable release collision: retry content differs');
		return existing;
	}
	if (previous) {
		const prior = parseSemver(previous);
		if (!prior) throw new Error('Invalid previous release version');
		if (parsed.pa < prior.pa)
			throw new Error('Release clock regressed');
		if (compareVersions(version, previous) <= 0) throw new Error('Release collision or precedence regression');
	}
	return intent;
}
