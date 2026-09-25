import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMinimalFixture } from '../helpers/pki.mjs';
import { createTestContext, startServer, login } from '../helpers/app.mjs';

test('security headers, error envelope and health endpoints', async (t) => {
  const fixture = await makeMinimalFixture();
  t.after(() => fixture.cleanup());

  const ctx = await createTestContext(fixture, { env: { NODE_ENV: 'production' } });
  await ctx.userStore.create({ username: 'admin', password: 'correct-horse-battery', role: 'admin' });
  const server = await startServer(ctx);
  t.after(() => server.close());

  const adminToken = await login(server, 'admin', 'correct-horse-battery');

  await t.test('security headers are present', async () => {
    const res = await server.request('GET', '/api/clients', { token: adminToken });
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.ok(res.headers.get('content-security-policy'));
    assert.ok(res.headers.get('x-content-type-options') === 'nosniff');
    assert.ok(res.headers.get('x-frame-options'));
    assert.ok(res.headers.get('referrer-policy'));
    assert.ok(res.headers.get('strict-transport-security'));
    assert.match(res.headers.get('content-security-policy') || '', /script-src 'self'/);
  });

  await t.test('errors use the {success,error:{code,message}} envelope', async () => {
    const res = await server.request('GET', '/api/clients/nope/config', { token: adminToken });
    assert.equal(res.status, 404);
    assert.deepEqual(Object.keys(res.json).sort(), ['error', 'success']);
    assert.equal(res.json.success, false);
    assert.equal(typeof res.json.error.code, 'string');
    assert.equal(typeof res.json.error.message, 'string');
    assert.equal(res.json.error.stack, undefined, 'no stack traces in production');
    assert.equal(res.text.includes('    at '), false, 'no stack traces leaked');
  });

  await t.test('unknown API routes are 404 with the envelope', async () => {
    const res = await server.request('GET', '/api/definitely-not-a-route', { token: adminToken });
    assert.equal(res.status, 404);
    assert.equal(res.json.success, false);
    assert.equal(res.json.error.code, 'NOT_FOUND');
  });

  await t.test('health endpoint is public and unauthenticated', async () => {
    const health = await server.request('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');
    assert.equal(typeof health.json.version, 'string');
  });

  await t.test('status endpoint reports environment info to admins', async () => {
    const res = await server.request('GET', '/api/status', { token: adminToken });
    assert.equal(res.status, 200);
    const data = res.json.data;
    assert.equal(typeof data.panel.version, 'string');
    assert.equal(typeof data.server, 'object');
    assert.equal(data.server.tlsMode, 'crypt-v2');
    assert.equal(typeof data.openvpn, 'object');
    assert.equal(typeof data.clients, 'object');
    assert.equal(data.server.serverConf, fixture.serverConf);
    assert.equal(res.text.includes('$2b$'), false);
  });

  await t.test('method not allowed returns a controlled error', async () => {
    const res = await server.request('PATCH', '/api/clients', { token: adminToken, body: {} });
    assert.ok(res.status === 404 || res.status === 405, String(res.status));
    assert.equal(res.json.success, false);
  });
});
