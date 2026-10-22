import { applyEdits, modify } from 'jsonc-parser/lib/esm/main.js';

/** A host-owned OpenCode preference document; never an HTTP configuration model. */
export type NativePreferenceDocument = {
	text: string;
	value: Record<string, unknown>;
};
export type NativePreferenceStore = {
	read(): Promise<NativePreferenceDocument>;
	write(text: string): Promise<void>;
};
export type NativeSettingsWriteResult = {
	saved: true;
	effective: 'verified' | 'unconfirmed';
	activation: 'none';
	detail?: string;
};

/**
 * Apply a narrow owned-preference patch while retaining JSONC comments and
 * unrelated keys. Callers must still read the native effective configuration
 * after the watched file is saved; an HTTP route is not a preference writer.
 */
export function editNativePreferenceJsonc(text: string, patch: Record<string, unknown>): string {
	function edit(change: Record<string, unknown>, path: string[] = []): void {
		for (const [key, value] of Object.entries(change)) {
			if (['__proto__', 'constructor', 'prototype'].includes(key))
				throw new Error('Invalid preferences field.');
			const nested =
				value !== null && typeof value === 'object' && !Array.isArray(value)
					? (value as Record<string, unknown>)
					: undefined;
			if (nested) edit(nested, [...path, key]);
			else
				text = applyEdits(
					text,
					modify(text, [...path, key], value === null ? undefined : value, {
						formattingOptions: { insertSpaces: true, tabSize: 2 }
					})
				);
		}
	}
	edit(patch);
	return text;
}

export async function saveNativePreferences(
	store: NativePreferenceStore,
	patch: Record<string, unknown>
): Promise<NativeSettingsWriteResult> {
	const current = await store.read();
	await store.write(editNativePreferenceJsonc(current.text, patch));
	return { saved: true, effective: 'unconfirmed', activation: 'none' };
}
