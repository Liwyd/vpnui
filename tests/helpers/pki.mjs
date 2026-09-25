/**
 * Test fixtures.
 *
 * All PKI material is created inside throwaway temporary directories —
 * tests never touch a host OpenVPN installation.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findEasyRsaSource, stageEasyRsa, openvpnAvailable } from './easyrsa.mjs';

const execFileAsync = promisify(execFile);

const SAMPLE_INDEX = [
  'V\t290101120000Z\t\t01\tunknown\t/CN=alice',
  'R\t290101120000Z\t250101120000Z\t02\tunknown\t/CN=bob',
  'V\t240101120000Z\t\t03\tunknown\t/CN=carol',
  'V\t290101120000Z\t\t04\tunknown\t/O=Example/CN=dave=extra',
  '',
].join('\n');

const CLIENT_TEMPLATE = [
  'client',
  'proto udp',
  'remote 203.0.113.10 1194',
  'dev tun',
  'resolv-retry infinite',
  'nobind',
  'persist-key',
  'persist-tun',
  'remote-cert-tls server',
  'verb 3',
  '',
].join('\n');

function serverConf({ tlsMode, serverName = 'server_test' }) {
  const lines = [
    'port 1194',
    'proto udp',
    'dev tun',
    'topology subnet',
    'server 10.8.0.0 255.255.255.0',
    'ifconfig-pool-persist ipp.txt',
  ];
  if (tlsMode === 'crypt-v2') lines.push('tls-crypt-v2 tls-crypt-v2.key');
  else if (tlsMode === 'crypt') lines.push('tls-crypt tls-crypt.key');
  else if (tlsMode === 'auth') lines.push('tls-auth tls-auth.key 0');
  lines.push(
    'crl-verify crl.pem',
    'ca ca.crt',
    `cert ${serverName}.crt`,
    `key ${serverName}.key`,
    'status status.log',
    'management /nonexistent/openvpn.sock unix',
    'verb 3',
    ''
  );
  return lines.join('\n');
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal hand-built fixture: server layout + index.txt, no binaries needed.
 * Suitable for auth, user management, client listing and validation tests.
 */
export async function makeMinimalFixture({ tlsMode = 'crypt-v2' } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vpnui-fixture-'));
  const serverDir = path.join(root, 'server');
  const easyRsaDir = path.join(serverDir, 'easy-rsa');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(path.join(easyRsaDir, 'pki', 'issued'), { recursive: true });
  await fsp.mkdir(path.join(easyRsaDir, 'pki', 'private'), { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });

  await fsp.writeFile(path.join(serverDir, 'server.conf'), serverConf({ tlsMode }));
  await fsp.writeFile(path.join(serverDir, 'client-template.txt'), CLIENT_TEMPLATE);
  await fsp.writeFile(path.join(serverDir, 'crl.pem'), '-----BEGIN X509 CRL-----\nfixture\n-----END X509 CRL-----\n');
  await fsp.writeFile(path.join(serverDir, 'ipp.txt'), 'alice,10.8.0.2\nbob,10.8.0.3\n');
  if (tlsMode === 'crypt-v2') {
    await fsp.writeFile(path.join(serverDir, 'tls-crypt-v2.key'), 'fixture-server-key\n');
  }
  if (tlsMode === 'crypt') {
    await fsp.writeFile(path.join(serverDir, 'tls-crypt.key'), 'fixture-tls-crypt-key\n');
  }
  await fsp.writeFile(path.join(easyRsaDir, 'pki', 'index.txt'), SAMPLE_INDEX);

  return {
    root,
    serverDir,
    easyRsaDir,
    dataDir,
    indexFile: path.join(easyRsaDir, 'pki', 'index.txt'),
    clientTemplate: path.join(serverDir, 'client-template.txt'),
    serverConf: path.join(serverDir, 'server.conf'),
    tlsMode,
    realPki: false,
    openvpn: false,
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

/**
 * Real PKI fixture: runs easyrsa to create a CA, server certificate and CRL
 * inside the temp directory. Requires an easy-rsa installation; returns
 * `available:false` (with a reason) instead of failing when missing.
 *
 * When `tlsMode: 'crypt-v2'` and openvpn is installed, a genuine server
 * tls-crypt-v2 key is generated too.
 */
export async function makeRealPkiFixture({ tlsMode = 'crypt-v2' } = {}) {
  const fixture = await makeMinimalFixture({ tlsMode });
  const source = await findEasyRsaSource();
  if (!source) {
    await fixture.cleanup();
    return { available: false, reason: 'easy-rsa not found (install easy-rsa or set EASYRSA_TEST_BIN)' };
  }

  await stageEasyRsa(source, fixture.easyRsaDir);
  const easy = (args, extraEnv = {}) =>
    execFileAsync(path.join(fixture.easyRsaDir, 'easyrsa'), args, {
      cwd: fixture.easyRsaDir,
      env: { ...process.env, EASYRSA_BATCH: '1', ...extraEnv },
      timeout: 120_000,
    });

  try {
    await easy(['--batch', 'init-pki']);
    await easy(['--batch', 'build-ca', 'nopass'], { EASYRSA_REQ_CN: 'VPNUI Test CA' });
    await easy(['--batch', 'build-server-full', 'server_test', 'nopass']);
    await easy(['--batch', 'gen-crl']);
  } catch (error) {
    fixture.available = false;
    const reason = `easyrsa fixture setup failed: ${error.stderr || error.message}`;
    await fixture.cleanup();
    return { available: false, reason };
  }

  // Reset index.txt to the sample state (server cert entries + our cases).
  await fsp.writeFile(fixture.indexFile, SAMPLE_INDEX);
  // ...but keep the real CA/server material and refresh the CRL install.
  const ca = await fsp.readFile(path.join(fixture.easyRsaDir, 'pki', 'ca.crt'), 'utf8');
  await fsp.writeFile(path.join(fixture.serverDir, 'ca.crt'), ca);
  await fsp.copyFile(path.join(fixture.easyRsaDir, 'pki', 'issued', 'server_test.crt'), path.join(fixture.serverDir, 'server_test.crt'));
  await fsp.copyFile(path.join(fixture.easyRsaDir, 'pki', 'private', 'server_test.key'), path.join(fixture.serverDir, 'server_test.key'));
  await fsp.copyFile(path.join(fixture.easyRsaDir, 'pki', 'crl.pem'), path.join(fixture.serverDir, 'crl.pem'));

  const openvpn = openvpnAvailable();
  if (tlsMode === 'crypt-v2') {
    if (openvpn) {
      await execFileAsync('openvpn', ['--genkey', 'tls-crypt-v2-server', path.join(fixture.serverDir, 'tls-crypt-v2.key')], {
        timeout: 30_000,
      });
    } else {
      fixture.available = false;
      await fixture.cleanup();
      return { available: false, reason: 'openvpn not found (needed for tls-crypt-v2 fixture)' };
    }
  } else if (tlsMode === 'crypt') {
    await fsp.writeFile(path.join(fixture.serverDir, 'tls-crypt.key'), 'fixture-tls-crypt-key\n');
  }

  fixture.available = true;
  fixture.openvpn = openvpn;
  fixture.realPki = true;
  return fixture;
}

export { exists, serverConf as renderServerConf, CLIENT_TEMPLATE };
