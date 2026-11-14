export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.([1-9]\d{2,3})(?:-(alpha|beta|rc))?$/;

export function parseSemver(version) {
	const match = String(version).match(SEMVER_RE);
	if (!match) return null;
	const ma = Number(match[1]), mi = Number(match[2]), pa = Number(match[3]);
	if (![ma, mi].every(Number.isSafeInteger) || (ma === 0 && mi < 4)) return null;
	// A numeric SemVer patch has no leading zero: January 01 is 101.
	const month = Number(match[3].slice(0, -2)), build = Number(match[3].slice(-2));
	if (month < 1 || month > 12 || build < 1) return null;
	return { ma, mi, pa, pre: match[4] ?? null, month, build };
}

export function compareVersions(left, right) {
	const a = parseSemver(left), b = parseSemver(right);
	if (!a || !b) throw new Error('Invalid fhold release version');
	for (const key of ['ma', 'mi', 'pa']) if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
	const rank = { alpha: 0, beta: 1, rc: 2, stable: 3 };
	return Math.sign(rank[a.pre ?? 'stable'] - rank[b.pre ?? 'stable']);
}

export function assertReleaseAdvance(version, previous) {
	const parsed = parseSemver(version), prior = parseSemver(previous);
	if (!parsed || !prior) throw new Error('Invalid release version');
	// MMNN carries no year. Cross-minor transitions use SemVer precedence.
	const sameLine = parsed.ma === prior.ma && parsed.mi === prior.mi;
	if (sameLine && parsed.month < prior.month)
		throw new Error('Release month regressed; start a new minor line at year rollover');
	if (compareVersions(version, previous) <= 0) throw new Error('Release collision or precedence regression');
	// Compare against the prior public release: promotions share its counter space.
	if (sameLine && parsed.pa === prior.pa)
		throw new Error('Monthly release counter must advance across channels');
}
