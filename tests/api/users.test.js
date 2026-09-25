import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMinimalFixture } from '../helpers/pki.mjs';
import { createTestContext, startServer, login } from '../helpers/app.mjs';

test('user management API', async (t) => {
  const fixture = await makeMinimalFixture();
  t.after(() => fixture.cleanup());

  const ctx = await createTestContext(fixture);
  await ctx.userStore.create({ username: 'admin', password: 'correct-horse-battery', role: 'admin' });
  await ctx.userStore.create({ username: 'viewer', password: 'correct-horse-battery', role: 'readonly' });
  const server = await startServer(ctx);
  t.after(() => server.close());

  const adminToken = await login(server, 'admin', 'correct-horse-battery');
  const viewerToken = await login(server, 'viewer', 'correct-horse-battery');

  await t.test('admin can list users without password hashes', async () => {
    const res = await server.request('GET', '/api/users', { token: adminToken });
    assert.equal(res.status, 200);
    const names = res.json.data.users.map((u) => u.username).sort();
    assert.deepEqual(names, ['admin', 'viewer']);
    assert.equal(res.text.includes('$2b$'), false, 'password hashes must never be exposed');
    assert.equal(res.text.includes('correct-horse-battery'), false);
  });

  await t.test('non-admin cannot manage users', async () => {
    const res = await server.request('GET', '/api/users', { token: viewerToken });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'FORBIDDEN');
  });

  await t.test('admin creates users with validation', async () => {
    const ok = await server.request('POST', '/api/users', {
      token: adminToken,
      body: { username: 'operator1', password: 'another-strong-pass', role: 'operator' },
    });
    assert.equal(ok.status, 201);

    const dup = await server.request('POST', '/api/users', {
      token: adminToken,
      body: { username: 'operator1', password: 'another-strong-pass', role: 'operator' },
    });
    assert.equal(dup.status, 409);

    const badRole = await server.request('POST', '/api/users', {
      token: adminToken,
      body: { username: 'operator2', password: 'another-strong-pass', role: 'god' },
    });
    assert.equal(badRole.status, 400);

    const badName = await server.request('POST', '/api/users', {
      token: adminToken,
      body: { username: '<script>', password: 'another-strong-pass', role: 'operator' },
    });
    assert.equal(badName.status, 400);

    const weak = await server.request('POST', '/api/users', {
      token: adminToken,
      body: { username: 'operator3', password: 'short', role: 'operator' },
    });
    assert.equal(weak.status, 400);
  });

  await t.test('role updates and password resets work', async () => {
    const role = await server.request('PUT', '/api/users/operator1', {
      token: adminToken,
      body: { role: 'readonly' },
    });
    assert.equal(role.status, 200);

    const reset = await server.request('POST', '/api/users/operator1/reset-password', {
      token: adminToken,
      body: { password: 'brand-new-password-1' },
    });
    assert.equal(reset.status, 200);

    const token = await login(server, 'operator1', 'brand-new-password-1');
    const me = await server.request('GET', '/api/users/me', { token });
    assert.equal(me.json.data.role, 'readonly');
  });

  await t.test('admins cannot delete themselves or the last admin', async () => {
    const self = await server.request('DELETE', '/api/users/admin', { token: adminToken });
    assert.equal(self.status, 400);
  });

  await t.test('unknown user returns 404', async () => {
    const res = await server.request('DELETE', '/api/users/ghost', { token: adminToken });
    assert.equal(res.status, 404);
  });

  await t.test('validation requires at least one field on update', async () => {
    const res = await server.request('PUT', '/api/users/operator1', { token: adminToken, body: {} });
    assert.equal(res.status, 400);
  });
});
