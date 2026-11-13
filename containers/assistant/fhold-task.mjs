#!/usr/bin/env bun

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';

const KNOWLEDGE = process.env.FH_KNOWLEDGE_DIR || '/stash';
const TASKS = join(KNOWLEDGE, 'tasks');
const IMPORTED = join(KNOWLEDGE, 'imported-tasks');
const DISABLED = join(KNOWLEDGE, 'disabled-tasks');
const INBOX = join(KNOWLEDGE, 'inbox');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TASK_BYTES = 1024 * 1024;

const passwordFile = process.env.OPENCODE_SERVER_PASSWORD_FILE;
if (!process.env.OPENCODE_SERVER_PASSWORD && passwordFile && existsSync(passwordFile)) {
	const password = readFileSync(passwordFile, 'utf8').replace(/[\r\n]+$/, '');
	if (password) process.env.OPENCODE_SERVER_PASSWORD = password;
}
process.env.OPENCODE_SERVER_USERNAME ||= 'opencode';

function fail(message) {
	console.error(`fhold-task: ${message}`);
	process.exit(1);
}

function taskId(value) {
	if (!ID_RE.test(value ?? ''))
		fail('task id must contain only letters, digits, dot, underscore, or dash');
	return value;
}

function taskFile(id) {
	return join(TASKS, `${taskId(id)}.yml`);
}

function run(command, args) {
	const result = Bun.spawnSync({
		cmd: [command, ...args],
		env: process.env,
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit'
	});
	if (result.exitCode !== 0) process.exit(result.exitCode || 1);
}

function runChecked(command, args, stdout = 'inherit') {
	const result = Bun.spawnSync({
		cmd: [command, ...args],
		env: process.env,
		stdin: 'ignore',
		stdout,
		stderr: 'inherit'
	});
	if (result.exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
	return result.stdout?.toString();
}

function option(args, name) {
	const index = args.indexOf(name);
	if (index < 0 || !args[index + 1]) fail(`${name} is required`);
	return args[index + 1];
}

function create(id, args) {
	const schedule = option(args, '--schedule');
	const prompt = option(args, '--prompt');
	const task = {
		version: 4,
		uses: 'akm/command',
		with: { content: prompt },
		description: `fhold scheduled request: ${prompt.slice(0, 160)}`,
		tags: ['fhold', 'scheduled'],
		...(args.includes('--harness') ? { harness: option(args, '--harness') } : {}),
		timeout: 15 * 60 * 1000,
		schedule
	};
	mkdirSync(join(INBOX, id), { recursive: true, mode: 0o700 });
	// AKM's native authoring path: import a task file (validated, no overwrite,
	// published disabled), then enable it. Scheduler sync owns rebinding.
	const staging = mkdtempSync(join(tmpdir(), 'fhold-task-'));
	try {
		const source = join(staging, `${id}.yml`);
		writeFileSync(source, Bun.YAML.stringify(task, null, 2), { mode: 0o600 });
		const imported = JSON.parse(runChecked('akm', ['import', source, '--type', 'task', '--name', id, '--format', 'json', '--quiet'], 'pipe'));
		// Native write and default bundles can differ. Activate the exact ref
		// returned by import, then preserve create's explicit launcher rebinding.
		runChecked('akm', ['task', 'enable', imported.ref]);
		// Enable reports sync failures as data; native sync also fails its exit
		// status, so an unschedulable task must not be reported as created.
		runChecked('akm', ['doctor', 'scheduler', 'sync', '--bundle', imported.ref.split('//')[0], '--rebind']);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

function remove(id) {
	const source = taskFile(id);
	if (!existsSync(source) || !lstatSync(source).isFile()) fail(`task not found: ${id}`);
	mkdirSync(DISABLED, { recursive: true, mode: 0o700 });
	const destination = join(DISABLED, `${id}-${new Date().toISOString().replaceAll(':', '-')}.yml`);
	runChecked('akm', ['task', 'disable', id, '--quiet']);
	renameSync(source, destination);
	try {
		runChecked('akm', ['doctor', 'scheduler', 'sync', '--rebind', '--quiet']);
	} catch (error) {
		renameSync(destination, source);
		throw error;
	}
	console.log(`Task ${id} was unscheduled and preserved at ${destination}.`);
}

function adopt(path) {
	const root = realpathSync(IMPORTED);
	const source = realpathSync(path);
	const rel = relative(root, source);
	if (rel === '..' || rel.startsWith('../') || rel.startsWith('/'))
		fail('adopt only accepts staged imported tasks');
	if (!lstatSync(source).isFile() || statSync(source).size > MAX_TASK_BYTES)
		fail('invalid imported task file');
	const name = basename(source);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ya?ml$/.test(name))
		fail('invalid imported task filename');
	const id = taskId(name.replace(/\.ya?ml$/, ''));
	// AKM validates the complete native grammar, refuses overwrite and publishes
	// new imports disabled under its scheduler lock. Preserve the staged source.
	runChecked('akm', ['import', source, '--type', 'task', '--name', id, '--quiet']);
	console.log(`Adopted ${id} in paused state. Review it, then use fhold task resume with the native task ref shown above.`);
}

const [command, ...args] = process.argv.slice(2);
try {
	switch (command) {
		case 'sync':
			run('akm', ['doctor', 'scheduler', 'sync', '--rebind']);
			break;
		case 'create':
			create(taskId(args[0]), args.slice(1));
			break;
		case 'list':
			run('akm', ['search', '--type', 'task', ...args]);
			break;
		case 'show':
			// Preserve the short-id convenience; AKM owns full ref resolution.
			if (!args[0]) fail('show requires a task id or native ref');
			run('akm', ['show', args[0].includes('/') ? args[0] : `tasks/${args[0]}`, ...args.slice(1)]);
			break;
		case 'history':
			// Native per-task run history. Listing every task's runs has no
			// replacement for the deprecated command yet.
			if (args[0] && !args[0].startsWith('-'))
				run('akm', ['doctor', 'log', '--task', args[0], ...args.slice(1)]);
			else run('akm', ['task', 'history', ...args]);
			break;
		case 'run':
			if (!args[0]) fail('run requires a task id or native ref');
			run('akm', ['run', args[0].includes('/') ? args[0] : `tasks/${args[0]}`, ...args.slice(1)]);
			break;
		case 'pause':
			run('akm', ['task', 'disable', ...args]);
			break;
		case 'resume':
			run('akm', ['task', 'enable', ...args]);
			break;
		case 'remove':
			remove(taskId(args[0]));
			break;
		case 'adopt':
			adopt(args[0]);
			break;
		default:
			fail('usage: fhold-task create|list|show|history|run|pause|resume|remove|adopt');
	}
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
