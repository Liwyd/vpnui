import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMinimalFixture } from '../helpers/pki.mjs';
import { createTestContext, startServer, login } from '../helpers/app.mjs';

test('client API validation and authorization', async (t) => {
  const fixture = await makeMinimalFixture();
  t.after(() => fixture.cleanup());

  const ctx = await createTestContext(fixture);
  await ctx.userStore.create({ username: 'admin', password: 'correct-horse-battery', role: 'admin' });
  await ctx.userStore.create({ username: 'viewer', password: 'correct-horse-battery', role: 'readonly' });
  await ctx.userStore.create({ username: 'operator', password: 'correct-horse-battery', role: 'operator' });
  const server = await startServer(ctx);
  t.after(() => server.close());

  const adminToken = await login(server, 'admin', 'correct-horse-battery');
  const viewerToken = await login(server, 'viewer', 'correct-horse-battery');
  const operatorToken = await login(server, 'operator', 'correct-horse-battery');

  await t.test('listing exposes fixture clients in the documented envelope', async () => {
    const res = await server.request('GET', '/api/clients', { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json), ['success', 'data']);
    assert.deepEqual(Object.keys(res.json.data), ['clients', 'counts']);
    const names = res.json.data.clients.map((c) => c.name);
    assert.ok(names.includes('alice'), 'fixture client alice present');
    const alice = res.json.data.clients.find((c) => c.name === 'alice');
    assert.equal(typeof alice.expiresAt, 'string');
    assert.equal(alice.revokedAt, null);
  });

  const injectionNames = [
    '../../etc/passwd',
    'a;id',
    'a$(id)',
    'a`id`',
    'a&&b',
    'a|b',
    'a b',
    '.hidden',
    'a\nb',
    "a'b",
    'a"b',
  ];

  await t.test('command-injection style names are rejected with 400', async () => {
    for (const name of injectionNames) {
      const res = await server.request('POST', '/api/clients', {
        token: adminToken,
        body: { clientName: name },
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(name)}`);
      assert.equal(res.json.error.code, 'VALIDATION_ERROR');
    }
    // And the same for the revoke path (C1 fix).
    for (const name of injectionNames) {
      const res = await server.request('DELETE', `/api/clients/${encodeURIComponent(name)}`, {
        token: adminToken,
      });
      assert.ok(res.status === 400 || res.status === 404, `expected 400/404 for ${JSON.stringify(name)}`);
      assert.notEqual(res.status, 500);
    }
  });

  await t.test('unknown client lookup is a clean 404', async () => {
    const res = await server.request('GET', '/api/clients/ghost-client/config', { token: adminToken });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'CLIENT_NOT_FOUND');
  });

  await t.test('readonly users may list but not mutate', async () => {
    assert.equal((await server.request('GET', '/api/clients', { token: viewerToken })).status, 200);

    const create = await server.request('POST', '/api/clients', {
      token: viewerToken,
      body: { clientName: 'viewer-created' },
    });
    assert.equal(create.status, 403);

    const revoke = await server.request('DELETE', '/api/clients/someone', { token: viewerToken });
    assert.equal(revoke.status, 403);
  });

  await t.test('operators are allowed to mutate', async () => {
    const res = await server.request('POST', '/api/clients', {
      token: operatorToken,
      body: { clientName: 'operator-created' },
    });
    // Missing PKI binaries in the minimal fixture => controlled 500/503, never a crash.
    assert.ok(res.status === 500 || res.status === 503, `unexpected ${res.status}: ${res.text}`);
    assert.equal(res.json.success, false);
    assert.ok(res.json.error.code, 'error code present');
  });

  await t.test('body validation rejects missing/malformed names', async () => {
    for (const body of [{}, { clientName: 42 }, { clientName: '' }, { password: 'x' }]) {
      const res = await server.request('POST', '/api/clients', { token: adminToken, body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json.error.code, 'VALIDATION_ERROR');
    }
  });
});
