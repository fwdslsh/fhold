import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire('/opt/fhold/tools/package.json');
const { chromium } = require('playwright');
assert.notEqual(process.getuid(), 0);
for (const command of [
	'chromium',
	'playwright',
	'rg',
	'jq',
	'python3',
	'sqlite3',
	'zip',
	'unzip',
	'pdftotext',
	'pdfinfo',
	'file',
	'less',
	'ps'
]) {
	execFileSync('sh', ['-c', 'command -v "$1"', 'sh', command]);
}
const directory = mkdtempSync(join(tmpdir(), 'fhold-browser-'));
execFileSync(
	'playwright',
	['screenshot', 'data:text/html,<h1>CLI ready</h1>', join(directory, 'cli.png')],
	{ timeout: 15000 }
);
execFileSync(
	'chromium',
	[
		'--headless',
		'--no-sandbox',
		'--disable-dev-shm-usage',
		`--screenshot=${join(directory, 'native.png')}`,
		'data:text/html,<h1>Native ready</h1>'
	],
	{ timeout: 15000 }
);
for (const name of ['cli', 'native'])
	assert.equal(
		readFileSync(join(directory, `${name}.png`))
			.subarray(1, 4)
			.toString(),
		'PNG'
	);
execFileSync('python3', ['-m', 'venv', join(directory, 'venv')], { timeout: 15000 });
assert.match(
	execFileSync(join(directory, 'venv/bin/pip'), ['--version'], { encoding: 'utf8' }),
	/pip /
);
assert.equal(execFileSync('sqlite3', [':memory:', 'select 1;'], { encoding: 'utf8' }).trim(), '1');
const browser = await chromium.launch();
try {
	for (const [name, colorScheme, width] of [
		['light', 'light', 1280],
		['dark', 'dark', 1280],
		['mobile', 'light', 390]
	]) {
		const page = await browser.newPage({ colorScheme, viewport: { width, height: 720 } });
		await page.setContent(`<!doctype html><html><style>
		body { background: white; color: black; font-family: sans-serif; }
		@media(prefers-color-scheme: dark) { body { background: rgb(20,20,20); color: white; } }
		@media(max-width: 500px) { h1 { font-size: 20px; } }
		button span { display: none; } button:hover span { display: block; }
		</style><h1>Browser tools ready</h1><button>Hover<span role="tooltip">Working tooltip</span></button>
		<script>document.querySelector('h1').dataset.ready = 'yes'</script></html>`);
		assert.equal(await page.locator('h1').getAttribute('data-ready'), 'yes');
		assert.equal(await page.evaluate(() => innerWidth), width);
		assert.equal(
			await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
			colorScheme === 'dark' ? 'rgb(20, 20, 20)' : 'rgb(255, 255, 255)'
		);
		if (width === 390)
			assert.equal(
				await page.locator('h1').evaluate((el) => getComputedStyle(el).fontSize),
				'20px'
			);
		await page.locator('button').hover();
		assert.equal(await page.getByRole('tooltip').isVisible(), true);
		const screenshot = join(directory, `${name}.png`);
		await page.screenshot({ path: screenshot });
		assert.equal(readFileSync(screenshot).subarray(1, 4).toString(), 'PNG');
		await page.pdf({ path: join(directory, `${name}.pdf`) });
		assert.match(
			execFileSync('pdftotext', [join(directory, `${name}.pdf`), '-'], { encoding: 'utf8' }),
			/Browser tools ready/
		);
		await page.close();
	}
	console.log(
		`Browser smoke passed: light, dark, mobile, hover, JavaScript, PNG and PDF (${browser.version()})`
	);
} finally {
	await browser.close();
}
