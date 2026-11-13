import type { ComposeOptions } from './compose.js';
import {
	buildComposeArgs, composeProcessEnvironment, parseComposePsRows, runDocker
} from './docker.js';
import { listProviders, testAssistantReadiness } from './opencode.js';

export type DiagnosticCheck = {
	name: string;
	ok: boolean;
	detail: string;
	advisory?: boolean;
	status?: 'pass' | 'warn' | 'fail' | 'not-checked' | 'off';
};

function check(name: string, status: NonNullable<DiagnosticCheck['status']>, detail: string): DiagnosticCheck {
	return { name, status, ok: status === 'pass' || status === 'off', advisory: true, detail };
}
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}
function rows(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(record) : [];
}
const names = ['Assistant native API', 'OpenCode providers', 'AKM health', 'AKM migrations', 'AKM tasks'];
export function unavailableNativeDiagnostics(detail: string): DiagnosticCheck[] {
	return names.map((name) => check(name, 'not-checked', detail));
}

function healthChecks(health: Record<string, unknown>): DiagnosticCheck[] {
	const statuses = ['pass', 'warn', 'fail', 'unknown'];
	const native = [...rows(health.hardChecks), ...rows(health.advisories)];
	const valid = health.schemaVersion === 3 && ['pass', 'warn', 'fail'].includes(String(health.status))
		&& Array.isArray(health.hardChecks) && health.hardChecks.length > 0 && Array.isArray(health.advisories)
		&& native.every((row) => typeof row.name === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(row.name) && statuses.includes(String(row.status)));
	if (!valid) return [check('AKM health', 'not-checked', 'Native read-only AKM health is unavailable or returned an unsupported response. Open Knowledge → Health or inspect Assistant diagnostics; no health success is inferred.'), taskCheck(undefined)];
	return [
		check('AKM health', health.status as 'pass' | 'warn' | 'fail', `Native AKM reported ${health.status}. Read-only inspection; network and harness probes disabled. Open Knowledge → Health for full diagnostics.`),
		...native.map((row) => check(`AKM ${row.name}`, row.status === 'unknown' ? 'not-checked' : row.status as 'pass' | 'warn' | 'fail',
			`Native AKM reported ${row.status}. Open Knowledge → Health for details; network and harness probes were disabled.`)),
		taskCheck(health.scheduler)
	];
}

// The same read-only native report carries scheduler bindings; report only
// their status, never binding paths or native warning text.
function taskCheck(value: unknown): DiagnosticCheck {
	const scheduler = record(value);
	if (!Array.isArray(scheduler.bindings) || !Array.isArray(scheduler.warnings))
		return check('AKM tasks', 'not-checked', 'Native read-only scheduler inspection is unavailable or returned an unsupported response.');
	const bindings = rows(scheduler.bindings);
	const ok = scheduler.warnings.length === 0
		&& bindings.every((binding) => Array.isArray(binding.status) && binding.status.length === 1 && binding.status[0] === 'ok');
	return check('AKM tasks', ok ? 'pass' : 'warn', ok
		? `Native AKM reported ${bindings.length} current scheduler binding group(s).`
		: 'Native AKM reported scheduler bindings that need attention. Inspect akm doctor, then run akm doctor scheduler sync --rebind.');
}

/** Explicit doctor inspection only. Never starts a container, model, task or migration. */
export async function diagnoseNativeRuntime(
	home: string,
	compose: ComposeOptions,
	options: { readiness?: boolean } = {}
): Promise<DiagnosticCheck[]> {
	const args = ['compose', ...buildComposeArgs(compose)];
	const env = composeProcessEnvironment(compose.envFiles);
	const ps = await runDocker([...args, 'ps', '-a', '--format', 'json'], { env, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
	if (!ps.ok || !parseComposePsRows(ps.stdout).some((row) => row.service === 'assistant' && row.state === 'running')) {
		const result = unavailableNativeDiagnostics('Assistant is stopped or unavailable; no native checks were run.');
		if (options.readiness) result.push({ name: 'live provider readiness', ok: false, status: 'not-checked', detail: 'Assistant is stopped or unavailable; no model request was sent.' });
		return result;
	}
	async function nativeReport(command: string[], acceptedCodes: readonly number[] = [0]): Promise<Record<string, unknown>> {
		// The in-container timeout also stops AKM if the Docker client disconnects.
		const result = await runDocker([...args, 'exec', '-T', 'assistant', 'timeout', '--kill-after=2s', '10s', ...command], {
			env, timeoutMs: 15_000, maxOutputBytes: 256 * 1024
		});
		// Health and migration status use nonzero exits for valid diagnostic reports.
		// Timeouts, launch failures and unrecognized responses remain unavailable.
		if (!acceptedCodes.includes(result.code)) return {};
		try { return record(JSON.parse(result.stdout)); } catch { return {}; }
	}
	const [providers, health, migration] = await Promise.all([
		listProviders(home, { timeoutMs: 10_000, signal: AbortSignal.timeout(10_000), maxResponseBytes: 256 * 1024 }).catch(() => undefined),
		nativeReport(['akm', 'doctor', '--read-only', '--no-probe', '--format', 'json', '--quiet'], [0, 4, 1]),
		// The native standalone migrator does not start CLI usage capture.
		nativeReport(['akm-migrate', 'status'], [0, 1])
	]);
	const checks: DiagnosticCheck[] = [check('Assistant native API', providers === undefined ? 'not-checked' : 'pass',
		providers === undefined ? 'Native API observation failed; core agent availability is unknown.' : 'Native provider API responded; model execution is checked only with --readiness.')];
	if (providers === undefined) {
		checks.push(check('OpenCode providers', 'not-checked', 'Native OpenCode provider inspection is unavailable. Check Assistant connectivity; legacy auth.json is not consulted.'));
	} else {
		const connected = providers.filter((provider) => provider.connected && !provider.disabled);
		checks.push(check('OpenCode providers', connected.length ? 'pass' : 'warn',
			`${connected.length} connected native provider(s), ${connected.filter((provider) => provider.authenticated).length} with native credentials. Model response is not checked; use fhold doctor --readiness.`));
	}
	// Native checks own plugin versions, state integrity, proposal/extraction and
	// harness diagnostics. Never echo their arbitrary messages/evidence (private
	// paths, endpoints, model outputs or credentials) into fhold's status envelope.
	checks.push(...healthChecks(health));
	const migrationStatus = migration.schemaVersion === 1 ? migration.status : undefined;
	checks.push(check('AKM migrations', migrationStatus === 'current' ? 'pass' : migrationStatus === 'ready' || migrationStatus === 'blocked' ? 'warn' : 'not-checked',
		migrationStatus === 'current' ? 'Native migration status is current.'
			: migrationStatus === 'ready' || migrationStatus === 'blocked' ? `Native migrations are ${migrationStatus}; inspect akm migrate status before explicitly applying repairs.`
				: 'Native migration status is unavailable or returned an unsupported response.'));
	if (options.readiness) {
		const readiness = await testAssistantReadiness(home, { timeoutMs: 120_000 });
		checks.push({ name: 'live provider readiness', ok: readiness.ok, detail: readiness.ok ? 'Native model responded.' : 'Native model request failed. Use fhold provider test for diagnostics.' });
	}
	return checks;
}
