import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

// Explicit focused renderer qualification, independent of Docker qualification.
it('keeps credential entry transient and requires a review before granting task access', async () => {
	const admin = join(import.meta.dir, '../admin');
	const html = readFileSync(join(admin, 'index.html'), 'utf8').replace(
		'src="admin.js"',
		'src="custody-qa.js"'
	);
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
			if (path === '/custody-qa.js')
				return new Response(
					`
import {state} from './state.js';
import {bindCustodyEvents,resetCustody} from './custody.js';
window.qa={calls:[],reset:resetCustody,approved:false,failed:false};
state.currentSnapshot={identity:{ref:{kind:'local-docker',homeDir:'/test'},name:'Test',location:'/test'},operations:{'agent.custody':{support:'supported',availability:{state:'ready'}}}};
state.api={operation:async(name,input,context)=>{
 if(input.action==='set-secret') {
  window.qa.secretWasCleared=document.getElementById('custody-secret-value').value==='';
  window.qa.calls.push({action:input.action,name:input.name,confirmed:context.confirmed});
  if(window.qa.failed)throw Error('Credential custody operation failed.');
  return {enabled:true,saved:true};
 }
 window.qa.calls.push({...input,confirmed:context.confirmed});
 if(input.action==='inspect')return {enabled:true,tasks:['probe'],grants:window.qa.approved?['probe']:[]};
 if(input.action==='review'&&window.qa.corrupt)throw Error('Credential custody operation failed.');
 if(input.action==='approve')window.qa.approved=true;
 if(input.action==='revoke'){window.qa.approved=false;return {enabled:true,saved:true};}
 return {enabled:true,review:{name:'probe',task:'version: 5-beta.1',script:'#!/bin/sh\\n# <img src=x onerror=alert(1)>',digest:'a'.repeat(64),command:'sudo -n -H -u fhold-credentials /usr/local/bin/akm run tasks/admin-probe',approved:window.qa.approved}};
}};
for(const id of ['loading-state','instance-welcome','install-section','instance-import-section'])document.getElementById(id).hidden=true;
document.body.dataset.phase='ready';
document.getElementById('view-title').textContent='System';
document.getElementById('primary-nav').hidden=false;
document.getElementById('mobile-navigation').hidden=false;
document.getElementById('app-shell').hidden=false;
document.getElementById('view-system').hidden=false;
document.getElementById('custody-panel').open=true;
bindCustodyEvents();window.qa.ready=true;
`,
					{ headers: { 'content-type': 'text/javascript' } }
				);
			if (!/^\/[a-z0-9.-]+\.(js|css|svg|ttf)$/.test(path)) return new Response('', { status: 404 });
			return new Response(Bun.file(join(admin, path.slice(1))));
		}
	});
	const browser = await chromium.launch({
		executablePath: process.env.FH_ADMIN_PROVIDER_CHROME || '/usr/bin/google-chrome',
		headless: true,
		args: ['--no-sandbox']
	});
	try {
		const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		page.on('dialog', (dialog) => dialog.accept());
		await page.goto(`http://127.0.0.1:${server.port}`);
		await page.waitForFunction(() => (window as any).qa?.ready);
		await page.locator('#custody-load').click();
		await page.locator('#custody-secret-name').fill('service');
		await page.locator('#custody-secret-value').fill('synthetic-renderer-canary');
		await page.locator('#custody-secret-form button').click();
		await page.waitForFunction(() => (window as any).qa.secretWasCleared);
		expect(await page.locator('#custody-secret-value').inputValue()).toBe('');
		expect(await page.locator('body').innerText()).not.toContain('synthetic-renderer-canary');
		expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
			'synthetic-renderer-canary'
		);
		await page.getByRole('button', { name: 'Review probe' }).click();
		expect(await page.locator('#custody-approve').isDisabled()).toBe(true);
		expect(
			await page.evaluate(
				() => (window as any).qa.calls.filter((r: any) => r.action === 'approve').length
			)
		).toBe(0);
		expect(await page.locator('#custody-review img').count()).toBe(0);
		await page.locator('#custody-reviewed').check();
		await page.locator('#custody-approve').click();
		await page.waitForFunction(() => (window as any).qa.approved);
		await page.locator('#custody-revoke').click();
		await page.waitForFunction(() => !(window as any).qa.approved);
		await page.evaluate(() => {
			(window as any).qa.approved = true;
			(window as any).qa.corrupt = true;
		});
		await page.locator('#custody-load').click();
		await page.getByRole('button', { name: 'Review probe' }).click();
		await page.getByRole('button', { name: 'Revoke probe', exact: true }).click();
		await page.waitForFunction(() => !(window as any).qa.approved);
		if (process.env.FH_ADMIN_CUSTODY_SCREENSHOT)
			await page.screenshot({ path: process.env.FH_ADMIN_CUSTODY_SCREENSHOT, fullPage: true });
		await page.evaluate(() => {
			(window as any).qa.failed = true;
		});
		await page.locator('#custody-secret-value').fill('synthetic-failure-canary');
		await page.locator('#custody-secret-form button').click();
		await page.waitForFunction(() =>
			document.getElementById('notice-message')?.textContent?.includes('operation failed')
		);
		expect(await page.locator('#custody-secret-value').inputValue()).toBe('');
		expect(await page.locator('body').innerText()).not.toContain('synthetic-failure-canary');
		await page.locator('#custody-secret-value').fill('unsaved-secret');
		await page.evaluate(() => (window as any).qa.reset());
		expect(await page.locator('#custody-secret-value').inputValue()).toBe('');
		expect(await page.locator('#custody-review').innerText()).toBe('');
		expect(errors).toEqual([]);
	} finally {
		await browser.close();
		server.stop(true);
	}
}, 45_000);
