/** Build a JSON Response with the given status and body. */
export function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/** Narrow an unknown value to a plain object record, or null if it is not one. */
export function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/** True when a record has exactly the expected keys, in any order. */
export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

/** Parse a positive integer setting, capped at maximum, or use the fallback. */
export function boundedInt(value: string | undefined, fallback: number, maximum: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

/** Read a response without allowing an upstream to exhaust Guardian memory. */
export async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
	const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
	if (Number.isFinite(declared) && declared > maxBytes)
		throw new Error('upstream response too large');
	if (!response.body) return '';

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw new Error('upstream response too large');
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	}

	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
