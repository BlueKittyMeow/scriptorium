// Disposable local fixture only: this script never connects to the live instance.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const fixture = await mkdtemp(path.join(tmpdir(), 'scriptorium-recovery-'));
const port = 5189;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  env: { ...process.env, DATA_ROOT: fixture }, stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', chunk => { log = (log + chunk).slice(-12000); });
server.stderr.on('data', chunk => { log = (log + chunk).slice(-12000); });
let browser;
const checks = [];
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Fixture server stopped: ${log}`);
    try { const response = await fetch(origin); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, `Fixture server did not start: ${log}`);
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  async function api(route, method = 'GET', data) {
    const response = await context.request.fetch(origin + route, { method, data, headers: { Origin: origin } });
    assert(response.ok(), `${method} ${route}: ${response.status()}`);
    return response.json();
  }
  const credentials = { username: 'recovery-fixture', password: 'local-fixture-only-password' };
  await api('/api/auth/setup', 'POST', credentials);
  await api('/api/auth/login', 'POST', credentials);
  const novel = await api('/api/novels', 'POST', { title: 'Disposable recovery checks' });
  const first = await api(`/api/novels/${novel.id}/tree/nodes`, 'POST', { title: 'First chapter', type: 'document', sort_order: 1 });
  const second = await api(`/api/novels/${novel.id}/tree/nodes`, 'POST', { title: 'Second chapter', type: 'document', sort_order: 2 });
  await api(`/api/documents/${first.id}`, 'PUT', { content: '<p>The original first chapter.</p>' });
  await api(`/api/documents/${second.id}`, 'PUT', { content: '<p>The original second chapter.</p>' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/novels/${novel.id}`);
  await page.getByText('First chapter', { exact: true }).click();
  await page.locator('.ProseMirror').waitFor();
  assert.match(await page.locator('.ProseMirror').innerText(), /original first/);
  check('normal chapter load');

  const secondUrl = `**/api/documents/${second.id}`;
  await page.route(secondUrl, route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"Authentication required"}' }));
  await page.getByText('Second chapter', { exact: true }).click();
  await page.getByRole('link', { name: 'Sign in in a new tab' }).waitFor();
  assert.match(await page.locator('.ProseMirror').innerText(), /original first/);
  assert.equal(await page.locator('.editor-header .doc-title').innerText(), 'First chapter');
  await page.screenshot({ path: path.join(fixture, 'authentication-recovery.png') });
  check('expired sign-in keeps the previous chapter and offers a new-tab sign-in');
  await page.unroute(secondUrl);
  await page.getByRole('button', { name: 'Retry loading chapter', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.editor-header .doc-title')?.textContent === 'Second chapter');
  assert.match(await page.locator('.ProseMirror').innerText(), /original second/);
  check('chapter retry restores content');

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const docUrl = `**/api/documents/${second.id}`;
  await page.route(docUrl, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Unavailable"}' }) : route.continue());
  await page.locator('.ProseMirror').fill('New writing which must survive a failed save.');
  await page.getByText(/The server is temporarily unavailable/).first().waitFor();
  await page.getByText('First chapter', { exact: true }).click();
  assert.equal(await page.locator('.editor-header .doc-title').innerText(), 'Second chapter');
  assert.match(await page.locator('.ProseMirror').innerText(), /must survive/);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download a copy', exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(path.join(fixture, 'unsaved-copy.html'));
  assert.equal(await download.failure(), null);
  check('failed saves block switching and allow a local download');

  await page.getByRole('link', { name: '← Library', exact: true }).click();
  await page.getByText(/Your latest writing has not been confirmed saved/).waitFor();
  assert.match(page.url(), /\/novels\//);
  check('navigation does not discard unsaved writing');

  await page.unroute(docUrl);
  await page.getByRole('button', { name: 'Dismiss error message' }).click();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.save-status')?.textContent.trim() === 'Saved');
  assert.match((await api(`/api/documents/${second.id}`)).content, /must survive/);
  await page.getByText('First chapter', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.editor-header .doc-title')?.textContent === 'First chapter');
  check('successful retry saves the correct document and permits switching');

  const treeUrl = `**/api/novels/${novel.id}/tree`;
  await page.route(treeUrl, route => route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>Proxy unavailable</h1>' }));
  await page.reload();
  await page.getByRole('button', { name: 'Retry loading chapters' }).waitFor();
  assert.equal(await page.locator('.ProseMirror').count(), 0);
  await page.screenshot({ path: path.join(fixture, 'chapter-list-recovery.png') });
  await page.unroute(treeUrl);
  await page.getByRole('button', { name: 'Retry loading chapters' }).click();
  await page.getByText('First chapter', { exact: true }).waitFor();
  check('failed initial chapter list has an explicit retry and recovers');

  // Responsive error affordances must remain usable on a phone-sized viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(secondUrl, route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.getByText('Second chapter', { exact: true }).click();
  const signIn = page.getByRole('link', { name: 'Sign in in a new tab' });
  await signIn.waitFor();
  const box = await signIn.boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= 390);
  await page.screenshot({ path: path.join(fixture, 'mobile-authentication-recovery.png') });
  check('phone-sized sign-in recovery remains visible');
  assert.deepEqual(errors, []);
  check('no uncaught browser errors');
  await writeFile(path.join(fixture, 'result.json'), JSON.stringify({ checks, passed: true }, null, 2));
  console.log(`Recovery artifacts: ${fixture}`);
} catch (error) {
  await writeFile(path.join(fixture, 'server.log'), log);
  console.error(`Recovery test failed; artifacts: ${fixture}`);
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
