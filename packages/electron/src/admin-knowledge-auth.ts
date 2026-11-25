/** Used only by the AKM view's private Electron Session, never by renderer code. */
export function knowledgeRequestHeaders(
	url: string,
	origin: string,
	secret: string | undefined,
	headers: Record<string, string>
): Record<string, string> {
	const result = { ...headers };
	if (!secret) return result;
	const authorization = `Bearer ${secret}`;
	// Redirected requests must not retain the credential from the previous hop.
	for (const name of Object.keys(result)) {
		if (name.toLowerCase() === 'authorization' && result[name] === authorization)
			delete result[name];
	}
	try {
		const target = new URL(url);
		if (target.origin === origin && !target.username && !target.password) {
			for (const name of Object.keys(result)) {
				if (name.toLowerCase() === 'authorization') delete result[name];
			}
			result.Authorization = authorization;
		}
	} catch {
		/* Invalid and external destinations never receive our credential. */
	}
	return result;
}
