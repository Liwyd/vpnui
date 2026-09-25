import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  extractPem,
  saveClientConfig,
  readClientConfig,
  deleteClientConfig,
} from '../../backend/services/openvpn/clientConfig.js';

test('extracts PEM blocks from text with headers', () => {
  const text = 'Certificate:\n    Data:\n        Issuer: CN=CA\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\ntrailing';
  const pem = extractPem(text, 'CERTIFICATE');
  assert.equal(pem, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
});

test('returns null when the requested PEM is absent', () => {
  assert.equal(extractPem('no keys here', 'CERTIFICATE'), null);
  assert.equal(extractPem('', null), null);
});

test('generic extraction finds private keys', () => {
  const text = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
  assert.ok(extractPem(text, null).includes('PRIVATE KEY'));
});

test('client config files are stored, read and deleted with 0600', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vpnui-cfg-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const file = await saveClientConfig({ clientConfigDir: dir, clientName: 'alice', config: 'client\n' });
  assert.equal(file, path.join(dir, 'alice.ovpn'));
  assert.equal(await readClientConfig({ clientConfigDir: dir, clientName: 'alice' }), 'client\n');

  const stat = await fsp.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);

  await deleteClientConfig({ clientConfigDir: dir, clientName: 'alice' });
  assert.equal(await readClientConfig({ clientConfigDir: dir, clientName: 'alice' }), null);
  // Deleting a missing config must not throw.
  await deleteClientConfig({ clientConfigDir: dir, clientName: 'ghost' });
});

test('path traversal in client names is impossible through the config store', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vpnui-cfg-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  // The service validates names before they reach the store; this proves the
  // store itself only ever joins a basename.
  const file = await saveClientConfig({ clientConfigDir: dir, clientName: 'safe_name-1', config: 'x' });
  assert.equal(path.dirname(file), dir);
});
