/**
 * .ovpn client configuration assembly.
 *
 * server.conf is the source of truth: TLS mode (tls-crypt-v2 / tls-crypt /
 * tls-auth / peer-fingerprint), CA vs fingerprint auth mode, and the client
 * template provide everything except the per-client material.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ApiError, ErrorCodes } from '../../lib/errors.js';
import { generateTlsCryptV2ClientKey } from './tlsCryptV2.js';

const PEM_RE = /-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/;

/** Extract the first PEM block from text that may carry a human-readable header. */
export function extractPem(text, beginMarker) {
  const match = beginMarker
    ? new RegExp(`-----BEGIN ${beginMarker}-----[\\s\\S]+?-----END ${beginMarker}-----`).exec(text)
    : PEM_RE.exec(text);
  if (!match) return null;
  return `${match[0]}\n`;
}

async function readPemFile(filePath, beginMarker, label) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new ApiError(
      500,
      ErrorCodes.CONFIG_GENERATION_FAILED,
      `Could not read ${label} at ${filePath} (${error.code ?? error.message}).\n\nRun: vpnui doctor`
    );
  }
  const pem = extractPem(text, beginMarker);
  if (!pem) {
    throw new ApiError(
      500,
      ErrorCodes.CONFIG_GENERATION_FAILED,
      `${label} at ${filePath} does not contain a PEM block; the PKI looks damaged. Run: vpnui doctor`
    );
  }
  return pem;
}

async function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

/**
 * Generate the full .ovpn document for a client.
 *
 * @returns {Promise<{config: string, tlsMode: string}>}
 */
export async function buildClientConfig({
  clientName,
  templatePath,
  easyRsaDir,
  serverConfig,
  commandTimeoutMs,
}) {
  let template;
  try {
    template = await fs.readFile(templatePath, 'utf8');
  } catch (error) {
    throw new ApiError(
      500,
      ErrorCodes.CONFIG_GENERATION_FAILED,
      `Client template ${templatePath} is missing (${error.code ?? error.message}). Run: vpnui doctor`
    );
  }

  const parts = [template.replace(/\s*$/, '')];

  const pkiDir = path.join(easyRsaDir, 'pki');
  const certPath = path.join(pkiDir, 'issued', `${clientName}.crt`);
  const keyPath = path.join(pkiDir, 'private', `${clientName}.key`);
  const caPath = path.join(pkiDir, 'ca.crt');

  if (serverConfig.authMode === 'fingerprint') {
    if (!serverConfig.serverFingerprint) {
      throw new ApiError(
        500,
        ErrorCodes.CONFIG_GENERATION_FAILED,
        'Server uses fingerprint auth mode but server-fingerprint is missing from the server directory. Run: vpnui doctor'
      );
    }
    parts.push(`peer-fingerprint ${serverConfig.serverFingerprint}`);
  } else {
    const ca = await readPemFile(serverConfig.caPath ?? caPath, 'CERTIFICATE', 'CA certificate');
    parts.push(`<ca>\n${ca.trimEnd()}\n</ca>`);
  }

  const cert = await readPemFile(certPath, 'CERTIFICATE', `client certificate for "${clientName}"`);
  const key = await readPemFile(keyPath, null, `client private key for "${clientName}"`);
  parts.push(`<cert>\n${cert.trimEnd()}\n</cert>`);
  parts.push(`<key>\n${key.trimEnd()}\n</key>`);

  switch (serverConfig.tlsMode) {
    case 'crypt-v2': {
      const clientKey = await generateTlsCryptV2ClientKey(serverConfig.tlsKeyPath, {
        workDir: serverConfig.serverDir,
        timeoutMs: commandTimeoutMs,
      });
      parts.push(`<tls-crypt-v2>\n${clientKey.trimEnd()}\n</tls-crypt-v2>`);
      break;
    }
    case 'crypt': {
      const pem = await readPemFile(serverConfig.tlsKeyPath, null, 'tls-crypt key');
      parts.push(`<tls-crypt>\n${pem.trimEnd()}\n</tls-crypt>`);
      break;
    }
    case 'auth': {
      const pem = await readPemFile(serverConfig.tlsKeyPath, null, 'tls-auth key');
      parts.push(`key-direction ${serverConfig.tlsKeyDirection ?? '1'}`);
      parts.push(`<tls-auth>\n${pem.trimEnd()}\n</tls-auth>`);
      break;
    }
    case 'none':
      break;
    default:
      throw new ApiError(
        500,
        ErrorCodes.CONFIG_GENERATION_FAILED,
        `Unsupported tls mode "${serverConfig.tlsMode}".`
      );
  }

  const config = `${parts.join('\n\n').replace(/\n{3,}/g, '\n\n')}\n`;
  return { config, tlsMode: serverConfig.tlsMode };
}

/** Persist a generated config with 0600 permissions (private key material). */
export async function saveClientConfig({ clientConfigDir, clientName, config }) {
  const filePath = path.join(clientConfigDir, `${clientName}.ovpn`);
  await atomicWrite(filePath, config);
  return filePath;
}

export async function readClientConfig({ clientConfigDir, clientName }) {
  const filePath = path.join(clientConfigDir, `${clientName}.ovpn`);
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function deleteClientConfig({ clientConfigDir, clientName }) {
  const filePath = path.join(clientConfigDir, `${clientName}.ovpn`);
  await fs.unlink(filePath).catch(() => {});
}
