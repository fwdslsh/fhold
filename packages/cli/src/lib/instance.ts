import { dirname, isAbsolute, join } from 'node:path';
import { defaultFholdHome, resolveFholdHome } from '@fhold/lib';
import type { ArgsDef, CommandDef, Resolvable, SubCommandsDef } from 'citty';

export function resolveInstanceHome(instance?: string): string {
	if (instance === undefined)
		return resolveFholdHome(process.env.FH_HOME?.trim() || process.cwd());
	if (!instance || instance.trim() !== instance || instance.includes('\0') || /[\r\n]/.test(instance))
		throw new Error('Provide an instance directory name or an absolute path with --instance.');
	if (isAbsolute(instance)) return resolveFholdHome(instance);
	if (instance === '.' || instance === '..' || /[\\/]/.test(instance))
		throw new Error('Use a single directory name under ~/fhold/instances, or an absolute path.');
	return resolveFholdHome(join(dirname(defaultFholdHome()), instance));
}

async function value<T>(input: Resolvable<T> | undefined): Promise<T | undefined> {
	return typeof input === 'function' ? await (input as () => T | Promise<T>)() : await input;
}

function takesValue(flag: string, definitions: ArgsDef): boolean {
	const key = flag.replace(/^-+/, '').replaceAll('-', '').toLowerCase();
	return Object.entries(definitions).some(([name, definition]) => {
		if (definition.type !== 'string' && definition.type !== 'enum') return false;
		const aliases = typeof definition.alias === 'string' ? [definition.alias] : definition.alias ?? [];
		return [name, ...aliases].some(name => name.replaceAll('-', '').toLowerCase() === key);
	});
}

/** Read one global selector without consuming another command's string value. */
export async function instanceArguments(
	argv: string[],
	command: CommandDef
): Promise<{ argv: string[]; instance?: string }> {
	const remaining: string[] = [];
	let instance: string | undefined;
	let definitions = (await value(command.args)) ?? {};
	let commands: SubCommandsDef = (await value(command.subCommands)) ?? {};
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (token === undefined) continue;
		if (token === '--') {
			remaining.push(...argv.slice(index));
			break;
		}
		if (
			token === '--instance' || token === '-i' ||
			token.startsWith('--instance=') || token.startsWith('-i=')
		) {
			if (instance !== undefined) throw new Error('Provide --instance only once.');
			const separator = token.indexOf('=');
			const supplied = separator >= 0 ? token.slice(separator + 1) : argv[++index];
			if (!supplied || (separator < 0 && supplied.startsWith('-')))
				throw new Error('Provide an instance directory name or an absolute path with --instance.');
			instance = supplied;
			continue;
		}
		remaining.push(token);
		if (token.startsWith('-') && !token.includes('=') && takesValue(token, definitions)) {
			const argument = argv[index + 1];
			if (argument !== undefined) {
				remaining.push(argument);
				index++;
			}
		} else if (Object.hasOwn(commands, token)) {
			const child = await value(commands[token]);
			if (child) {
				definitions = (await value(child.args)) ?? {};
				commands = (await value(child.subCommands)) ?? {};
			}
		}
	}
	return { argv: remaining, ...(instance === undefined ? {} : { instance }) };
}
