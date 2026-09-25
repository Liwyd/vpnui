/**
 * Easy-RSA execution layer.
 *
 * All PKI mutations are serialized through a process-wide mutex (Easy-RSA's
 * index.txt / serial bookkeeping is not concurrency-safe), executed without
 * a shell, with timeouts, and with exit-code based error detection.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { run, CommandError } from '../../lib/exec.js';
import { ApiError, ErrorCodes } from '../../lib/errors.js';
import { Mutex } from '../../lib/mutex.js';

const UNKNOWN_COMMAND_RE = /not a recognized command|unknown command|unrecognized option|usage:/i;

export class EasyRSAService {
  constructor({ easyRsaDir, logger, commandTimeoutMs = 120_000 }) {
    this.easyRsaDir = easyRsaDir;
    this.logger = logger;
    this.commandTimeoutMs = commandTimeoutMs;
    /**
     * PKI operations are lock-free individually; the orchestrator
     * (ClientService) wraps whole transactions in `withLock()` so that a
     * revoke + CRL regeneration + install cannot interleave.
     */
    this.mutex = new Mutex('easyrsa');
    this._binary = null;
    this._subcommands = null;
  }

  /** Run fn with exclusive access to the PKI. Reentrant use deadlocks — do not nest. */
  withLock(fn) {
    return this.mutex.run(fn);
  }

  async _resolveBinary() {
    if (this._binary) return this._binary;
    const candidates = [path.join(this.easyRsaDir, 'easyrsa'), 'easyrsa'];
    for (const candidate of candidates) {
      try {
        await run(candidate, ['version'], {
          cwd: this.easyRsaDir,
          timeoutMs: 15_000,
        });
        this._binary = candidate;
        return candidate;
      } catch {
        /* try next */
      }
    }
    throw new ApiError(
      500,
      ErrorCodes.OPENVPN_ERROR,
      [
        'Easy-RSA is not usable.',
        '',
        `Expected an "easyrsa" executable in: ${this.easyRsaDir}`,
        '',
        'Possible causes:',
        '  - Easy-RSA has not been installed/extracted',
        '  - EASY_RSA_DIR is incorrect',
        '',
        'Run: vpnui doctor',
      ].join('\n')
    );
  }

  _env(extra = {}) {
    return { ...process.env, EASYRSA_BATCH: '1', ...extra };
  }

  async _easyrsa(args, { env = {}, timeoutMs } = {}) {
    const binary = await this._resolveBinary();
    return run(binary, args, {
      cwd: this.easyRsaDir,
      env: this._env(env),
      timeoutMs: timeoutMs ?? this.commandTimeoutMs,
    });
  }

  /** Build a client certificate. `password` encrypts the private key. */
  async buildClient(name, { password, certDays } = {}) {
    const env = {};
    if (certDays) env.EASYRSA_CERT_EXPIRE = String(certDays);

    let args;
    if (password) {
      // Non-interactive passphrase supply (easyrsa would otherwise prompt).
      env.EASYRSA_PASSPHRASE = password;
      args = [
        '--batch',
        '--passin=env:EASYRSA_PASSPHRASE',
        '--passout=env:EASYRSA_PASSPHRASE',
        'build-client-full',
        name,
      ];
    } else {
      args = ['--batch', 'build-client-full', name, 'nopass'];
    }

    try {
      return await this._easyrsa(args, { env });
    } catch (error) {
      this._throwEasyRSA(error, `build the certificate for client "${name}"`);
    }
  }

  /**
   * Revoke a client certificate.
   * Newer easy-rsa ships `revoke-issued`; older versions only `revoke`.
   */
  async revokeClient(name) {
    const subcommands = await this._detectSubcommands();
    const sub = subcommands.has('revoke-issued') ? 'revoke-issued' : 'revoke';
    try {
      return await this._easyrsa(['--batch', sub, name]);
    } catch (error) {
      this._throwEasyRSA(error, `revoke the certificate for client "${name}"`);
    }
  }

  /** Regenerate the certificate revocation list. */
  async generateCrl({ days } = {}) {
    const env = days ? { EASYRSA_CRL_DAYS: String(days) } : {};
    try {
      return await this._easyrsa(['--batch', 'gen-crl'], { env });
    } catch (error) {
      this._throwEasyRSA(error, 'regenerate the CRL');
    }
  }

  async _detectSubcommands() {
    if (this._subcommands) return this._subcommands;
    const set = new Set();
    try {
      const { stdout, stderr } = await this._easyrsa(['help'], { timeoutMs: 20_000 });
      for (const token of `${stdout}\n${stderr}`.matchAll(/\b([a-z][a-z0-9-]{2,})\b/g)) {
        set.add(token[1]);
      }
    } catch {
      // `easyrsa help` exits non-zero on some versions; ignore and probe directly.
    }
    this._subcommands = set;
    return set;
  }

  _throwEasyRSA(error, action) {
    if (error instanceof ApiError) throw error;
    if (error instanceof CommandError) {
      const output = `${error.stdout}\n${error.stderr}`.trim();
      if (error.timedOut) {
        throw new ApiError(
          500,
          ErrorCodes.OPENVPN_ERROR,
          `Easy-RSA timed out while trying to ${action}. The PKI may be locked by another process; check for stuck easyrsa processes and run: vpnui doctor`
        );
      }
      if (UNKNOWN_COMMAND_RE.test(output)) {
        throw new ApiError(500, ErrorCodes.OPENVPN_ERROR, `Easy-RSA rejected the operation while trying to ${action}: ${output.slice(0, 500)}`);
      }
      // Easy-RSA prints human-readable reasons on failure; surface them.
      throw new ApiError(
        500,
        ErrorCodes.OPENVPN_ERROR,
        `Failed to ${action}. Easy-RSA said:\n${output.slice(0, 800) || `exit ${error.code}`}`
      );
    }
    throw new ApiError(500, ErrorCodes.OPENVPN_ERROR, `Failed to ${action}: ${error.message}`);
  }
}

/** True when the given client has issued material in the PKI. */
export async function issuedMaterialExists(easyRsaDir, name) {
  try {
    await fs.access(path.join(easyRsaDir, 'pki', 'issued', `${name}.crt`));
    return true;
  } catch {
    return false;
  }
}
