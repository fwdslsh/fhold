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
	status?: 'pass' | 'warn' | 'not-checked' | 'off';
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
const names = ['Assistant native API', 'OpenCode providers', 'AKM configuration', 'AKM harnesses', 'AKM migrations', 'AKM tasks', 'AKM proposal persistence'];
export function unavailableNativeDiagnostics(detail: string): DiagnosticCheck[] {
	return names.map((name) => check(name, 'not-checked', detail));
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
	async function akm(command: string[]): Promise<Record<string, unknown>> {
		// The in-container timeout also stops AKM if the Docker client disconnects.
		const result = await runDocker([...args, 'exec', '-T', 'assistant', 'timeout', '--kill-after=2s', '10s', 'akm', ...command, '--format', 'json', '--quiet'], {
			env, timeoutMs: 15_000, maxOutputBytes: 256 * 1024
		});
		// migrate status uses exit 1 for a valid blocked plan; other failures are unknown.
		if (result.code !== 0 && !(command[0] === 'migrate' && result.code === 1)) return {};
		try { return record(JSON.parse(result.stdout)); } catch { return {}; }
	}
	const [providers, info, migration, tasks] = await Promise.all([
		listProviders(home, { timeoutMs: 10_000, signal: AbortSignal.timeout(10_000), maxResponseBytes: 256 * 1024 }).catch(() => undefined),
		akm(['info']), akm(['migrate', 'status']), akm(['task', 'doctor'])
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
	const validInfo = info.schemaVersion === 1 && typeof info.version === 'string' && Array.isArray(info.connectionsAndHarnesses);
	const configBad = Boolean(info.configError || info.error);
	checks.push(check('AKM configuration', configBad ? 'warn' : validInfo ? 'pass' : 'not-checked',
		configBad ? 'Native AKM rejected the effective configuration. Inspect akm info and akm migrate status inside Assistant.'
			: validInfo ? 'Native AKM loaded the effective configuration; this does not verify agent execution or proposal writes.'
				: 'Native AKM info is unavailable or returned an unsupported response.'));
	if (validInfo && !configBad) {
		const targets = rows(info.connectionsAndHarnesses);
		const harnesses = targets.filter((row) => row.type === 'harness');
		const missing = harnesses.filter((row) => row.installed === false).length;
		const unresolved = targets.filter((row) => row.type === 'process' && row.problem).length;
		checks.push(check('AKM harnesses', missing || unresolved ? 'warn' : harnesses.length ? 'pass' : 'not-checked',
			`${harnesses.length} native harness(es); ${missing} missing executable(s); ${unresolved} unresolved work target(s). Inspect akm info for target details; no agent was run.`));
		if (info.bundleDirError || info.dataDirError || record(info.indexStats).unavailable) {
			checks.push(check('AKM catalog', 'warn', 'Native AKM reports an unavailable bundle, data directory or index. Inspect akm info inside Assistant.'));
		}
		if (record(info.semanticSearch).status === 'disabled') checks.push(check('AKM semantic search', 'off', 'Disabled in native AKM configuration.'));
	} else checks.push(check('AKM harnesses', 'not-checked', 'Effective native configuration could not be inspected.'));
	const migrationStatus = migration.schemaVersion === 1 ? migration.status : undefined;
	checks.push(check('AKM migrations', migrationStatus === 'current' ? 'pass' : migrationStatus === 'ready' || migrationStatus === 'blocked' ? 'warn' : 'not-checked',
		migrationStatus === 'current' ? 'Native migration status is current.'
			: migrationStatus === 'ready' || migrationStatus === 'blocked' ? `Native migrations are ${migrationStatus}; inspect akm migrate status before explicitly applying repairs.`
				: 'Native migration status is unavailable or returned an unsupported response.'));
	const validTasks = typeof tasks.backend === 'string' && Array.isArray(tasks.bindings) && Array.isArray(tasks.warnings);
	const taskWarnings = validTasks && ((tasks.warnings as unknown[]).length > 0 || tasks.remediation || rows(tasks.bindings).some((binding) => !Array.isArray(binding.status) || !binding.status.includes('ok')));
	checks.push(check('AKM tasks', !validTasks ? 'not-checked' : taskWarnings ? 'warn' : 'pass',
		!validTasks ? 'Native task diagnostics are unavailable.' : taskWarnings ? 'Native scheduler diagnostics report warnings. Inspect akm task doctor; no tasks were changed or run.'
			: 'Native scheduler bindings inspected; task execution and historical outcomes are not checked.'));
	if (validTasks && record(tasks.improveAutonomy).enabled === false) checks.push(check('AKM improve autonomy', 'off', 'Disabled by native AKM policy; preserved.'));
	checks.push(check('AKM proposal persistence', 'not-checked', 'AKM does not yet expose read-only proposal write-target readiness or reliable aggregate extraction outcomes (itlackey/akm#1289, #1290). No learning or proposal-write success is inferred.'));
	if (options.readiness) {
		const readiness = await testAssistantReadiness(home, { timeoutMs: 120_000 });
		checks.push({ name: 'live provider readiness', ok: readiness.ok, detail: readiness.ok ? 'Native model responded.' : 'Native model request failed. Use fhold provider test for diagnostics.' });
	}
	return checks;
}
