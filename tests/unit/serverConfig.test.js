import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadServerConfig, parseClientTemplate } from '../../backend/services/openvpn/serverConfig.js';

async function writeConf(text) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vpnui-conf-'));
  const file = path.join(dir, 'server.conf');
  await fsp.writeFile(file, text);
  return { dir, file, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('tls-crypt-v2 is detected and never confused with tls-crypt', async () => {
  const conf = await writeConf('port 1194\ntls-crypt-v2 tls-crypt-v2.key\nca ca.crt\n');
  try {
    const parsed = await loadServerConfig(conf.file);
    assert.equal(parsed.tlsMode, 'crypt-v2');
    assert.equal(parsed.tlsKeyPath, path.join(conf.dir, 'tls-crypt-v2.key'));
    assert.equal(parsed.authMode, 'pki');
  } finally {
    await conf.cleanup();
  }
});

test('tls-crypt (v1) still works', async () => {
  const conf = await writeConf('port 1194\ntls-crypt tls-crypt.key\nca ca.crt\n');
  try {
    const parsed = await loadServerConfig(conf.file);
    assert.equal(parsed.tlsMode, 'crypt');
    assert.equal(parsed.tlsKeyPath, path.join(conf.dir, 'tls-crypt.key'));
  } finally {
    await conf.cleanup();
  }
});

test('tls-auth key direction is preserved', async () => {
  const conf = await writeConf('port 443\ntls-auth tls-auth.key 0\nca ca.crt\n');
  try {
    const parsed = await loadServerConfig(conf.file);
    assert.equal(parsed.tlsMode, 'auth');
    assert.equal(parsed.tlsKeyDirection, '0');
  } finally {
    await conf.cleanup();
  }
});

test('resolves relative paths against the server directory', async () => {
  const conf = await writeConf(
    ['port 1194', 'ca ca.crt', 'cert server_ab.crt', 'key server_ab.key', 'crl-verify crl.pem', 'ifconfig-pool-persist ipp.txt', 'status /var/log/openvpn/status.log', 'server 10.9.0.0 255.255.255.0', 'duplicate-cn'].join('\n')
  );
  try {
    const parsed = await loadServerConfig(conf.file);
    assert.equal(parsed.crlPath, path.join(conf.dir, 'crl.pem'));
    assert.equal(parsed.ippPath, path.join(conf.dir, 'ipp.txt'));
    assert.equal(parsed.statusPath, '/var/log/openvpn/status.log');
    assert.equal(parsed.certPath, path.join(conf.dir, 'server_ab.crt'));
    assert.equal(parsed.vpnSubnet, '10.9.0.0');
    assert.equal(parsed.duplicateCn, true);
    assert.equal(parsed.port, 1194);
  } finally {
    await conf.cleanup();
  }
});

test('fingerprint auth mode is detected from the peer-fingerprint block', async () => {
  const conf = await writeConf(
    'port 1194\ncert server_ab.crt\nkey server_ab.key\n<peer-fingerprint>\n# phone\nABC123\n</peer-fingerprint>\n'
  );
  try {
    const parsed = await loadServerConfig(conf.file);
    assert.equal(parsed.authMode, 'fingerprint');
    assert.deepEqual(parsed.peerFingerprints, ['ABC123']);
    assert.equal(parsed.crlPath, path.join(conf.dir, 'crl.pem'));
  } finally {
    await conf.cleanup();
  }
});

test('AUTH_MODE_GENERATED marker wins when present', async () => {
  const conf = await writeConf('port 1194\nca ca.crt\n');
  const easyRsa = await fsp.mkdtemp(path.join(os.tmpdir(), 'vpnui-easy-'));
  try {
    await fsp.writeFile(path.join(easyRsa, 'AUTH_MODE_GENERATED'), 'fingerprint\n');
    const parsed = await loadServerConfig(conf.file, { easyRsaDir: easyRsa });
    assert.equal(parsed.authMode, 'fingerprint');
  } finally {
    await conf.cleanup();
    await fsp.rm(easyRsa, { recursive: true, force: true });
  }
});

test('management socket and comments are parsed safely', async () => {
  const conf = await writeConf(
    'port 1194  # with comment\nmanagement /var/run/openvpn-server/server.sock unix\n# tls-crypt-v2 fake-comment\n'
  );
  try {
    const parsed = await loadServerConfig(conf.file);
    assert.equal(parsed.mgmtSocket, '/var/run/openvpn-server/server.sock');
    assert.equal(parsed.tlsMode, 'none');
    assert.equal(parsed.port, 1194);
  } finally {
    await conf.cleanup();
  }
});

test('client template remote endpoint parsing', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vpnui-tpl-'));
  try {
    const file = path.join(dir, 'client-template.txt');
    await fsp.writeFile(file, 'client\nproto udp\nremote vpn.example.com 1194\ndev tun\n');
    const info = await parseClientTemplate(file);
    assert.equal(info.endpoint, 'vpn.example.com');
    assert.equal(info.port, '1194');
    assert.equal(info.proto, 'udp');
    const missing = await parseClientTemplate(path.join(dir, 'nope.txt'));
    assert.equal(missing.endpoint, null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
