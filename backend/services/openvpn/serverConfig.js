/**
 * server.conf parser — the single source of truth for how the panel talks
 * to a given OpenVPN installation (TLS mode, CRL target, status file,
 * management socket, endpoint hints, server certificate name).
 *
 * Handles both the modern layout (/etc/openvpn/server/server.conf) and the
 * legacy layout, and the pki / fingerprint auth modes produced by current
 * OpenVPN installers.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../../lib/errors.js';

function parseDirectives(text) {
  const directives = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const withoutComment = line.replace(/\s+#.*$/, '').trim();
    if (!withoutComment) continue;
    const [key, ...rest] = withoutComment.split(/\s+/);
    directives.push({ key, value: rest.join(' '), tokens: [key, ...rest], line: i + 1 });
  }
  return directives;
}

function first(directives, key) {
  return directives.find((d) => d.key === key) ?? null;
}

function resolvePath(baseDir, value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

/** Extract `remote <endpoint> <port>` from the client template, if present. */
export async function parseClientTemplate(templatePath) {
  let text;
  try {
    text = await fs.readFile(templatePath, 'utf8');
  } catch {
    return { endpoint: null, port: null, proto: null };
  }
  const remote = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^remote\s+\S+/.test(l) && !l.startsWith('#'));
  let endpoint = null;
  let port = null;
  if (remote) {
    const parts = remote.split(/\s+/);
    endpoint = parts[1] ?? null;
    port = parts[2] ?? null;
  }
  const protoLine = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith('proto '));
  return { endpoint, port, proto: protoLine ? protoLine.split(/\s+/)[1] : null };
}

/**
 * Parse a server configuration.
 *
 * @param {string} serverConfPath absolute path to server.conf
 * @param {object} opts
 * @param {string} [opts.easyRsaDir] used to read AUTH_MODE_GENERATED
 * @returns {Promise<object>} parsed configuration
 */
export async function loadServerConfig(serverConfPath, { easyRsaDir } = {}) {
  let text;
  try {
    text = await fs.readFile(serverConfPath, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read OpenVPN server configuration ${serverConfPath}: ${error.message}`);
  }
  const serverDir = path.dirname(serverConfPath);
  const directives = parseDirectives(text);

  // TLS control-channel mode. Match exact directive names (never substrings:
  // "tls-crypt" must not match "tls-crypt-v2").
  let tlsMode = 'none';
  let tlsKeyPath = null;
  let tlsKeyDirection = null;
  const cryptV2 = first(directives, 'tls-crypt-v2');
  const crypt = first(directives, 'tls-crypt');
  const auth = first(directives, 'tls-auth');
  if (cryptV2) {
    tlsMode = 'crypt-v2';
    tlsKeyPath = resolvePath(serverDir, cryptV2.tokens[1]);
  } else if (crypt) {
    tlsMode = 'crypt';
    tlsKeyPath = resolvePath(serverDir, crypt.tokens[1]);
  } else if (auth) {
    tlsMode = 'auth';
    tlsKeyPath = resolvePath(serverDir, auth.tokens[1]);
    tlsKeyDirection = auth.tokens[2] ?? '1';
  }

  const crl = first(directives, 'crl-verify');
  const status = first(directives, 'status');
  const management = first(directives, 'management');
  const ipp = first(directives, 'ifconfig-pool-persist');
  const serverSubnet = first(directives, 'server');
  const cert = first(directives, 'cert');
  const key = first(directives, 'key');
  const ca = first(directives, 'ca');
  const port = first(directives, 'port');
  const proto = first(directives, 'proto');

  // Auth mode: prefer the marker file written by the installer, fall back to
  // the presence of a CA directive vs a peer-fingerprint block.
  let authMode = null;
  if (easyRsaDir) {
    try {
      const marker = await fs.readFile(path.join(easyRsaDir, 'AUTH_MODE_GENERATED'), 'utf8');
      const value = marker.trim();
      if (value === 'pki' || value === 'fingerprint') authMode = value;
    } catch {
      /* marker is optional */
    }
  }
  if (!authMode) {
    if (ca) authMode = 'pki';
    else authMode = text.includes('<peer-fingerprint>') ? 'fingerprint' : 'pki';
  }

  const fingerprints = [];
  const blockMatch = text.match(/<peer-fingerprint>([\s\S]*?)<\/peer-fingerprint>/);
  if (blockMatch) {
    for (const line of blockMatch[1].split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) fingerprints.push(trimmed);
    }
  }

  const serverFingerprint = await readServerFingerprint(serverDir, easyRsaDir);

  return Object.freeze({
    path: serverConfPath,
    serverDir,
    port: port ? Number(port.tokens[1]) : null,
    proto: proto ? proto.tokens[1] : null,
    tlsMode,
    tlsKeyPath,
    tlsKeyDirection,
    tlsModeRaw: cryptV2 ?? crypt ?? auth,
    crlPath: crl ? resolvePath(serverDir, crl.tokens[1]) : path.join(serverDir, 'crl.pem'),
    caPath: ca ? resolvePath(serverDir, ca.tokens[1]) : null,
    certPath: cert ? resolvePath(serverDir, cert.tokens[1]) : null,
    keyPath: key ? resolvePath(serverDir, key.tokens[1]) : null,
    statusPath: status ? resolvePath(serverDir, status.tokens[1]) : null,
    mgmtSocket: management
      ? (path.isAbsolute(management.tokens[1])
          ? management.tokens[1]
          : path.resolve('/var/run', management.tokens[1]))
      : null,
    ippPath: ipp ? resolvePath(serverDir, ipp.tokens[1]) : null,
    vpnSubnet: serverSubnet ? serverSubnet.tokens[1] : null,
    duplicateCn: Boolean(first(directives, 'duplicate-cn')),
    authMode,
    serverFingerprint,
    peerFingerprints: Object.freeze(fingerprints),
  });
}

async function readServerFingerprint(serverDir, easyRsaDir) {
  for (const candidate of [
    path.join(serverDir, 'server-fingerprint'),
    easyRsaDir ? path.join(easyRsaDir, 'server-fingerprint') : null,
  ]) {
    if (!candidate) continue;
    try {
      const value = (await fs.readFile(candidate, 'utf8')).trim();
      if (value) return value;
    } catch {
      /* optional */
    }
  }
  return null;
}
