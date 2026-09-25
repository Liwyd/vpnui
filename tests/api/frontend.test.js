/**
 * Frontend security contract: no third-party origins, no inline handlers,
 * no inline styles/scripts — everything the strict CSP requires.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMinimalFixture } from '../helpers/pki.mjs';
import { createTestContext, startServer } from '../helpers/app.mjs';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

test('frontend files satisfy the strict CSP', async (t) => {
  const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

  await t.test('no inline event handlers', () => {
    assert.equal(/\son(click|load|submit|change|error|focus|blur)\s*=/i.test(html), false);
  });

  await t.test('no inline <script> or <style> blocks', () => {
    assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false);
    assert.equal(/<style[\s>]/i.test(html), false);
    assert.equal(/\sstyle\s*=\s*"/i.test(html), false, 'inline style attributes are blocked too');
  });

  await t.test('no third-party origins (CDN fonts/scripts/styles)', () => {
    assert.equal(/https?:\/\//i.test(html), false, 'index.html must be fully self-hosted');
    assert.match(html, /\/vendor\/tailwind\.min\.css/);
    assert.match(html, /\/js\/main\.js/);
  });

  await t.test('vendored assets exist and are served', async () => {
    const css = await fsp.stat(path.join(PUBLIC_DIR, 'vendor', 'tailwind.min.css'));
    assert.ok(css.size > 100000, 'vendored tailwind present');
  });

  await t.test('no user data ever flows through innerHTML in main.js', async () => {
    const js = await fsp.readFile(path.join(PUBLIC_DIR, 'js', 'main.js'), 'utf8');
    assert.equal(js.includes('innerHTML'), false, 'use textContent/createElement instead');
    assert.equal(/\bon(click|load|submit)\s*=/.test(js), false);
    assert.equal(js.includes('cdn'), false);
  });
});

test('served frontend carries the strict CSP and assets resolve', async (t) => {
  const fixture = await makeMinimalFixture();
  t.after(() => fixture.cleanup());
  const ctx = await createTestContext(fixture, { env: { NODE_ENV: 'production' } });
  const server = await startServer(ctx);
  t.after(() => server.close());

  const root = await server.request('GET', '/');
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.match(root.headers.get('content-security-policy') || '', /style-src 'self'/);

  const css = await server.request('GET', '/vendor/tailwind.min.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /text\/css/);

  const script = await server.request('GET', '/js/main.js');
  assert.equal(script.status, 200);

  // The SPA fallback must not serve index.html for API paths (401 from the
  // auth middleware, or a JSON 404 — but never the SPA shell).
  const spa = await server.request('GET', '/api/not-a-page');
  assert.ok(spa.status === 401 || spa.status === 404, `got ${spa.status}`);
  assert.match(spa.headers.get('content-type') || '', /json/);
});
