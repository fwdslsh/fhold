import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

export type Logger = ReturnType<typeof createLogger>;

export function createLogger(service: string) {
	const write = (
		level: 'info' | 'warn' | 'error',
		event: string,
		fields?: Record<string, unknown>
	) => {
		const entry = {
			ts: new Date().toISOString(),
			level,
			service,
			event,
			...(fields ? { fields } : {})
		};
		(level === 'info' ? console.log : console.error)(JSON.stringify(entry));
	};
	return {
		info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
		warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
		error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields)
	};
}

export function readSecret(name: string): string {
	const file = process.env[`${name}_FILE`] ?? '';
	if (!file) throw new Error(`${name}_FILE is required`);
	try {
		const value = readFileSync(file, 'utf8').replace(/[\r\n]+$/, '');
		if (!value) throw new Error(`${name}_FILE is empty`);
		return value;
	} catch (error) {
		if (error instanceof Error && error.message === `${name}_FILE is empty`) throw error;
		throw new Error(`${name}_FILE is not readable`);
	}
}

export function parseIds(value: string | undefined): ReadonlySet<string> {
	return new Set(
		(value ?? '')
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean)
	);
}

export type AccessInput = {
	userId: string;
	blockedUsers?: ReadonlySet<string>;
	scopes: ReadonlyArray<{ allowed: ReadonlySet<string>; actual: ReadonlyArray<string> }>;
};

export function isAllowed(input: AccessInput): boolean {
	if (input.blockedUsers?.has(input.userId)) return false;
	if (input.scopes.every(({ allowed }) => allowed.size === 0)) return false;
	return input.scopes.every(
		({ allowed, actual }) =>
			allowed.size === 0 || allowed.has('*') || actual.some((value) => allowed.has(value))
	);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function startHealthServer(_service: string): { ready: (check: () => boolean) => void } {
	let isReady = () => false;
	const port = Number.parseInt(process.env.PORT ?? '8080', 10);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be valid');
	createServer((request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.method !== 'GET' || request.url?.split('?')[0] !== '/health') {
			response.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
			return;
		}
		const ready = isReady();
		response.writeHead(ready ? 200 : 503).end(JSON.stringify({ ok: ready }));
	}).listen(port, '0.0.0.0');
	return {
		ready: (check) => {
			isReady = check;
		}
	};
}

export function splitMessage(text: string, maxLength: number): string[] {
	const chunks: string[] = [];
	let remaining = text || '(no text response)';
	while (remaining.length > maxLength) {
		let splitAt = remaining.lastIndexOf('\n', maxLength);
		if (splitAt < Math.floor(maxLength / 2)) splitAt = maxLength;
		// Keep a UTF-16 surrogate pair together at a hard message boundary.
		if (/^[\uDC00-\uDFFF]$/.test(remaining[splitAt])) splitAt -= 1;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).replace(/^\n/, '');
	}
	chunks.push(remaining);
	return chunks;
}
