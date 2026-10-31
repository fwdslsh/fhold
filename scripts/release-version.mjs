export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.([1-9]\d{2,})(?:-(alpha|beta|rc)(?:\.([1-9]\d*))?)?$/;

export function parseSemver(version) {
	const match = String(version).match(SEMVER_RE);
	if (!match) return null;
	const ma = Number(match[1]), mi = Number(match[2]), pa = Number(match[3]);
	const serial = match[5] ? Number(match[5]) : null;
	if (![ma, mi, pa, ...(serial === null ? [] : [serial])].every(Number.isSafeInteger)) return null;
	if (ma > 0 || mi >= 4) {
		// A numeric SemVer patch has no leading zero: January 01 is 101.
		if (!/^[1-9]\d{2,3}$/.test(match[3]) || serial !== null) return null;
		const month = Number(match[3].slice(0, -2)), build = Number(match[3].slice(-2));
		if (month < 1 || month > 12 || build < 1) return null;
		return { ma, mi, pa, pre: match[4] ?? null, channel: match[4] ?? null,
			serial: null, timestamp: null, date: null, month, format: 'month-counter', build };
	}
	const legacy = ma === 0 && mi < 2;
	const monthly = mi === 3;
	if (monthly ? match[3].length !== 6 || Boolean(match[5]) :
		legacy ? match[3].length !== 10 : !/^[1-9]\d*$/.test(match[3].slice(6))) return null;
	const [yy, month] = match[3].slice(0, 4).match(/\d{2}/g).map(Number);
	const day = monthly ? 1 : Number(match[3].slice(4, 6));
	const hour = legacy ? Number(match[3].slice(6, 8)) : 0;
	const minute = legacy ? Number(match[3].slice(8, 10)) : 0;
	const date = new Date(Date.UTC(2000 + yy, month - 1, day, hour, minute));
	if (date.getUTCFullYear() !== 2000 + yy || date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) return null;
	return { ma, mi, pa, pre: match[4] ? `${match[4]}${match[5] ? `.${match[5]}` : ''}` : null,
		channel: match[4] ?? null, serial, timestamp: date.toISOString(),
		date: date.toISOString().slice(0, 10), format: monthly ? 'monthly' : legacy ? 'timestamp' : 'daily',
		build: legacy ? null : Number(match[3].slice(monthly ? 4 : 6)) };
}

export function compareVersions(left, right) {
	const a = parseSemver(left), b = parseSemver(right);
	if (!a || !b) throw new Error('Invalid fhold release version');
	for (const key of ['ma', 'mi']) if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
	if (a.format === 'month-counter' && a.pa !== b.pa) return Math.sign(a.pa - b.pa);
	if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
	if (a.build !== b.build) return Math.sign(a.build - b.build);
	const rank = { alpha: 0, beta: 1, rc: 2, stable: 3 };
	const channel = rank[a.channel ?? 'stable'] - rank[b.channel ?? 'stable'];
	if (channel) return Math.sign(channel);
	return Math.sign((a.serial ?? 0) - (b.serial ?? 0));
}

/** Compare clocks at their shared precision when crossing historical formats. */
export function assertReleaseAdvance(version, previous) {
	const parsed = parseSemver(version), prior = parseSemver(previous);
	if (!parsed || !prior) throw new Error('Invalid release version');
	const precision = parsed.format === 'monthly' || prior.format === 'monthly' ? 7 :
		parsed.format === 'timestamp' && prior.format === 'timestamp' ? 24 : 10;
	// MMNN carries no year. Cross-minor transitions use SemVer precedence;
	// historical formats retain their actual UTC clock checks.
	if (parsed.timestamp !== null && prior.timestamp !== null &&
		parsed.timestamp.slice(0, precision) < prior.timestamp.slice(0, precision))
		throw new Error('Release clock regressed');
	if (parsed.format === 'month-counter' && prior.format === 'month-counter' &&
		parsed.ma === prior.ma && parsed.mi === prior.mi && parsed.month < prior.month)
		throw new Error('Release month regressed; start a new minor line at year rollover');
	if (compareVersions(version, previous) <= 0) throw new Error('Release collision or precedence regression');
	// Compare against the prior public release: promotions share its counter space.
	if (['monthly', 'month-counter'].includes(parsed.format) &&
		['monthly', 'month-counter'].includes(prior.format) &&
		parsed.ma === prior.ma && parsed.mi === prior.mi && parsed.pa === prior.pa)
		throw new Error('Monthly release counter must advance across channels');
}

/** Final publication identity. `existing` is public immutable intent, never a local candidate reservation. */
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
		assertReleaseAdvance(version, previous);
	}
	return intent;
}
