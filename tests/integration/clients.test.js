/**
 * End-to-end client lifecycle against a real Easy-RSA PKI (and a real
 * tls-crypt-v2 server key when openvpn is installed). Skips itself with a
 * clear reason when the toolchain is unavailable instead of failing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { makeRealPkiFixture } from '../helpers/pki.mjs';
import { createTestContext, startServer, login } from '../helpers/app.mjs';

test('client lifecycle with a real PKI', async (t) => {
  const fixture = await makeRealPkiFixture();
  if (!fixture.available) {
    t.skip(`real PKI unavailable: ${fixture.reason}`);
    return;
  }
  t.after(() => fixture.cleanup());

  const ctx = await createTestContext(fixture);
  await ctx.userStore.create({ username: 'admin', password: 'correct-horse-battery', role: 'admin' });
  const server = await startServer(ctx);
  t.after(() => server.close());
  const token = await login(server, 'admin', 'correct-horse-battery');

  let createdName = null;

  await t.test('creates a certificate-based client', async () => {
    const res = await server.request('POST', '/api/clients', {
      token,
      body: { clientName: 'itest-cert' },
    });
    assert.equal(res.status, 201, res.text);
    createdName = res.json.data.clientName;
    assert.equal(createdName, 'itest-cert');
    assert.ok(res.json.data.configFile.endsWith('itest-cert.ovpn'));

    const configOnDisk = await fsp.readFile(res.json.data.configFile, 'utf8');
    assert.match(configOnDisk, /-----BEGIN CERTIFICATE-----/);
    assert.equal(configOnDisk.includes('BEGIN PRIVATE KEY'), true, 'decrypted private key embedded');
    assert.match(configOnDisk, /remote 203\.0\.113\.10 1194/);
    if (fixture.tlsMode === 'crypt-v2') {
      assert.match(configOnDisk, /<tls-crypt-v2>/);
      assert.match(configOnDisk, /-----BEGIN OpenVPN tls-crypt-v2 client key-----/);
    }
  });

  await t.test('appears in the listing as valid and counts update', async () => {
    const res = await server.request('GET', '/api/clients', { token });
    assert.equal(res.status, 200);
    const client = res.json.data.clients.find((c) => c.name === createdName);
    assert.ok(client, 'created client listed');
    assert.ok(['valid', 'unknown'].includes(client.status ?? 'valid'));
    assert.equal(client.revokedAt, null);
    assert.ok(res.json.data.counts.total >= 1);
  });

  await t.test('serves the profile over the API and as a download', async () => {
    const api = await server.request('GET', `/api/clients/${createdName}/config`, { token });
    assert.equal(api.status, 200);
    assert.equal(typeof api.json.data.config, 'string');
    assert.match(api.json.data.config, /-----BEGIN CERTIFICATE-----/);

    const dl = await server.request('GET', `/api/clients/${createdName}/config?download=1`, { token });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-type') || '', /x-openvpn-profile/);
    assert.match(dl.headers.get('content-disposition') || '', /itest-cert\.ovpn/);
    assert.match(dl.text, /-----BEGIN CERTIFICATE-----/);
  });

  await t.test('rejects duplicate names and then revokes the client', async () => {
    const dup = await server.request('POST', '/api/clients', {
      token,
      body: { clientName: createdName },
    });
    assert.ok(dup.status === 409 || dup.status === 400, `duplicate → ${dup.status}: ${dup.text}`);

    const revoke = await server.request('DELETE', `/api/clients/${createdName}`, { token });
    assert.equal(revoke.status, 200, revoke.text);

    const list = await server.request('GET', '/api/clients', { token });
    const client = list.json.data.clients.find((c) => c.name === createdName);
    assert.equal(client.status, 'revoked');
    assert.ok(client.revokedAt, 'revocation timestamp recorded');

    const again = await server.request('DELETE', `/api/clients/${createdName}`, { token });
    assert.ok(again.status === 409 || again.status === 404, `second revoke → ${again.status}`);

    const cfg = await server.request('GET', `/api/clients/${createdName}/config`, { token });
    assert.equal(cfg.status, 403, 'revoked client config is no longer served');
    assert.equal(cfg.json.error.code, 'CLIENT_REVOKED');
  });

  await t.test('revocation lands in the CRL', async () => {
    const crl = await fsp.readFile(path.join(fixture.serverDir, 'crl.pem'), 'utf8');
    assert.match(crl, /-----BEGIN X509 CRL-----/);
    // The regenerated CRL must be a real DER/PEM object, not the fixture text.
    assert.equal(crl.includes('fixture'), false);
    const stats = await fsp.stat(path.join(fixture.serverDir, 'crl.pem'));
    assert.ok(stats.size > 200, 'CRL has real content');
  });

  await t.test('password-protected clients get an encrypted key', async () => {
    const res = await server.request('POST', '/api/clients', {
      token,
      body: { clientName: 'itest-pass', usePassword: true, password: 'a-strong-passphrase' },
    });
    assert.equal(res.status, 201, res.text);
    const config = await fsp.readFile(res.json.data.configFile, 'utf8');
    assert.match(config, /-----BEGIN ENCRYPTED PRIVATE KEY-----|BEGIN PRIVATE KEY BLOCK-----|Proc-Type: 4,ENCRYPTED/);
    // The passphrase itself must never appear in the profile or API responses.
    assert.equal(config.includes('a-strong-passphrase'), false);
    const list = await server.request('GET', '/api/clients', { token });
    assert.equal(list.text.includes('a-strong-passphrase'), false);
  });

  await t.test('short passwords are rejected', async () => {
    const res = await server.request('POST', '/api/clients', {
      token,
      body: { clientName: 'itest-short', usePassword: true, password: 'short' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'VALIDATION_ERROR');
  });

  await t.test('no files are ever created for rejected names', async () => {
    const res = await server.request('POST', '/api/clients', {
      token,
      body: { clientName: 'evil;rm -rf' },
    });
    assert.equal(res.status, 400);
    const entries = await fsp.readdir(fixture.serverDir);
    assert.equal(entries.some((e) => e.includes('evil')), false);
    const privateDir = path.join(fixture.easyRsaDir, 'pki', 'private');
    const privates = await fsp.readdir(privateDir);
    assert.equal(privates.some((e) => e.includes('evil')), false);
  });
});
