// The normal CLI is also the remote executable. Only this outer distribution
// entrypoint carries other architectures, so helpers never recursively embed.
import x64 from '../embedded/fhold-linux-x64.gz' with { type: 'file' };
import arm64 from '../embedded/fhold-linux-arm64.gz' with { type: 'file' };
import { gunzipSync } from 'node:zlib';
import { configureSshHelperResources } from '@fhold/lib';
import { main } from './main.js';

configureSshHelperResources(async (arch) =>
	gunzipSync(await Bun.file(arch === 'x64' ? x64 : arm64).arrayBuffer())
);
main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
