/**
 * tls-crypt-v2 support.
 *
 * The server holds a `tls-crypt-v2` server key (see server.conf). Every
 * client receives a unique client key derived from it:
 *
 *   openvpn --tls-crypt-v2 <server.key> --genkey tls-crypt-v2-client <file>
 *
 * The temporary key file is created inside the OpenVPN server directory,
 * because Ubuntu 25.04+ AppArmor profiles reject openvpn writing to /tmp.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, CommandError } from '../../lib/exec.js';
import { ApiError, ErrorCodes } from '../../lib/errors.js';

let versionCache = null;

/** Detect the installed OpenVPN version (cached per process). */
export async function getOpenVPNVersion({ timeoutMs = 15_000 } = {}) {
  if (versionCache) return versionCache;
  try {
    const { stdout } = await run('openvpn', ['--version'], { timeoutMs });
    const m = /OpenVPN (\d+)\.(\d+)(?:\.(\d+))?/.exec(stdout);
    if (!m) throw new Error('unparseable version output');
    versionCache = {
      raw: stdout.split('\n')[0].trim(),
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3] ?? 0),
    };
  } catch (error) {
    if (error instanceof CommandError && (error.code === null || error.timedOut)) {
      throw new ApiError(
        503,
        ErrorCodes.OPENVPN_UNAVAILABLE,
        'The openvpn binary is not available or did not respond.\n\nInstall OpenVPN (apt install openvpn) and run: vpnui doctor'
      );
    }
    throw new ApiError(
      503,
      ErrorCodes.OPENVPN_UNAVAILABLE,
      `Could not execute openvpn --version: ${error.message}`
    );
  }
  return versionCache;
}

export function supportsTlsCryptV2(version) {
  if (version.major > 2) return true;
  return version.major === 2 && version.minor >= 4;
}

/** Reset the cached version (tests only). */
export function _resetVersionCache() {
  versionCache = null;
}

/**
 * Generate a unique tls-crypt-v2 client key and return its PEM text.
 *
 * @param {string} serverKeyPath path to the server's tls-crypt-v2 key
 * @param {object} opts
 * @param {string} [opts.workDir] directory for the temp file (defaults to the key's directory)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>} PEM-encoded client key
 */
export async function generateTlsCryptV2ClientKey(serverKeyPath, { workDir, timeoutMs = 30_000 } = {}) {
  const version = await getOpenVPNVersion({ timeoutMs: Math.min(timeoutMs, 15_000) });
  if (!supportsTlsCryptV2(version)) {
    throw new ApiError(
      500,
      ErrorCodes.TLS_CRYPT_V2_UNAVAILABLE,
      `The server is configured with tls-crypt-v2 but the installed OpenVPN (${version.raw}) does not support it (2.4+ required). Upgrade OpenVPN or reconfigure with tls-crypt.`
    );
  }

  let serverKey;
  try {
    serverKey = await fs.readFile(serverKeyPath);
  } catch (error) {
    throw new ApiError(
      500,
      ErrorCodes.TLS_CRYPT_V2_UNAVAILABLE,
      `The server's tls-crypt-v2 key was not found at ${serverKeyPath} (${error.code ?? error.message}).\n\nIt is generated during OpenVPN installation. Run: vpnui doctor`
    );
  }
  if (serverKey.length === 0) {
    throw new ApiError(
      500,
      ErrorCodes.TLS_CRYPT_V2_UNAVAILABLE,
      `The server's tls-crypt-v2 key at ${serverKeyPath} is empty. Reinstall/repair the OpenVPN server.`
    );
  }

  const dir = workDir ?? path.dirname(serverKeyPath);
  const tmpPath = path.join(dir, `tls-crypt-v2-client.${crypto.randomBytes(8).toString('hex')}`);

  try {
    await run(
      'openvpn',
      ['--tls-crypt-v2', serverKeyPath, '--genkey', 'tls-crypt-v2-client', tmpPath],
      { timeoutMs }
    );
    const pem = await fs.readFile(tmpPath, 'utf8');
    if (!/BEGIN OpenVPN tls-crypt-v2 client key/.test(pem)) {
      throw new ApiError(
        500,
        ErrorCodes.TLS_CRYPT_V2_UNAVAILABLE,
        'openvpn produced an unexpected tls-crypt-v2 client key format. Check the OpenVPN installation.'
      );
    }
    return pem;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      ErrorCodes.TLS_CRYPT_V2_UNAVAILABLE,
      `Failed to generate a tls-crypt-v2 client key: ${error.stderr || error.message}`
    );
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}
