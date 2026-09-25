import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { makeMinimalFixture } from '../helpers/pki.mjs';
import { createTestContext, startServer, TEST_JWT_SECRET } from '../helpers/app.mjs';

test('authentication flow', async (t) => {
  const fixture = await makeMinimalFixture();
  t.after(() => fixture.cleanup());

  const ctx = await createTestContext(fixture);
  await ctx.userStore.create({ username: 'admin', password: 'correct-horse-battery', role: 'admin' });
  const server = await startServer(ctx);
  t.after(() => server.close());

  await t.test('login returns a token and user', async () => {
    const res = await server.request('POST', '/api/login', {
      body: { username: 'admin', password: 'correct-horse-battery' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.data.token);
    assert.equal(res.json.data.user.role, 'admin');
  });

  await t.test('wrong password is rejected without leaking which part failed', async () => {
    const res = await server.request('POST', '/api/login', {
      body: { username: 'admin', password: 'wrong-password-here' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'INVALID_CREDENTIALS');

    const unknown = await server.request('POST', '/api/login', {
      body: { username: 'nobody', password: 'wrong-password-here' },
    });
    assert.equal(unknown.status, 403);
    assert.equal(unknown.json.error.code, 'INVALID_CREDENTIALS');
  });

  await t.test('missing credentials', async () => {
    const res = await server.request('POST', '/api/login', { body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'VALIDATION_ERROR');
  });

  await t.test('protected routes require a token', async () => {
    const routes = [
      ['GET', '/api/clients'],
      ['GET', '/api/users/me'],
      ['GET', '/api/status'],
      ['POST', '/api/clients'],
    ];
    for (const [method, path] of routes) {
      const res = await server.request(method, path, { body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.json.error.code, 'UNAUTHORIZED');
    }
  });

  await t.test('garbage and forged tokens are rejected', async () => {
    for (const token of ['garbage', 'a.b.c']) {
      const res = await server.request('GET', '/api/users/me', { token });
      assert.equal(res.status, 401);
    }
    const hs512 = jwt.sign({ sub: 'admin', role: 'admin' }, TEST_JWT_SECRET, { algorithm: 'HS512' });
    assert.equal((await server.request('GET', '/api/users/me', { token: hs512 })).status, 401);

    const foreign = jwt.sign(
      { sub: 'admin', role: 'admin' },
      'attacker-secret-attacker-secret-1234',
      { algorithm: 'HS256' }
    );
    assert.equal((await server.request('GET', '/api/users/me', { token: foreign })).status, 401);

    const unsigned = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'admin', role: 'admin' })).toString('base64url');
    assert.equal(
      (await server.request('GET', '/api/users/me', { token: `${unsigned}.${body}.` })).status,
      401
    );
  });

  await t.test('expired tokens are rejected with a clear message', async () => {
    const expired = jwt.sign({ sub: 'admin', role: 'admin' }, TEST_JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '-1s',
    });
    const res = await server.request('GET', '/api/users/me', { token: expired });
    assert.equal(res.status, 401);
    assert.match(res.json.error.message, /expired/i);
  });

  await t.test('/api/users/me reflects the token identity', async () => {
    const login = await server.request('POST', '/api/login', {
      body: { username: 'admin', password: 'correct-horse-battery' },
    });
    const res = await server.request('GET', '/api/users/me', { token: login.json.data.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { username: 'admin', role: 'admin' });
  });

  await t.test('login attempts are rate limited', async () => {
    const limitedCtx = await createTestContext(fixture, { env: { RATE_LIMIT_LOGIN_MAX: '3' } });
    const limited = await startServer(limitedCtx);
    try {
      let sawLimit = false;
      for (let i = 0; i < 8; i += 1) {
        const res = await limited.request('POST', '/api/login', {
          body: { username: 'admin', password: 'nope-nope-nope' },
        });
        if (res.status === 429) {
          assert.equal(res.json.error.code, 'RATE_LIMITED');
          sawLimit = true;
          break;
        }
      }
      assert.ok(sawLimit, 'expected a 429 within 8 attempts');
    } finally {
      await limited.close();
    }
  });
});
