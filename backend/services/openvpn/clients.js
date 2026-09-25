/**
 * Client lifecycle orchestration: create, list, revoke, configuration
 * download. Every mutating transaction runs inside a single PKI lock so
 * concurrent API requests cannot interleave Easy-RSA state changes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError, ErrorCodes } from '../../lib/errors.js';
import { validateClientName } from '../../lib/validation.js';
import { readIndexFile } from './pkiIndex.js';
import { issuedMaterialExists } from './easyRSA.js';
import {
  buildClientConfig,
  saveClientConfig,
  readClientConfig,
  deleteClientConfig,
} from './clientConfig.js';
import { installCrl } from './crl.js';
import { removeFromIpp } from './ipp.js';
import { killSession } from './mgmt.js';

export class ClientService {
  constructor({ config, serverConfig, easyRSA, audit, logger }) {
    this.config = config;
    this.serverConfig = serverConfig;
    this.easyRSA = easyRSA;
    this.audit = audit;
    this.logger = logger;
  }

  async _index() {
    return readIndexFile(this.config.indexFile);
  }

  async _describe(entry) {
    const name = entry.name;
    let createdAt = null;
    try {
      const stat = await fs.stat(path.join(this.config.easyRsaDir, 'pki', 'issued', `${name}.crt`));
      createdAt = stat.mtime.toISOString();
    } catch {
      /* issued file may be missing for foreign entries */
    }
    let hasConfig = false;
    try {
      await fs.access(path.join(this.config.clientConfigDir, `${name}.ovpn`));
      hasConfig = true;
    } catch {
      /* optional */
    }
    return {
      name,
      status: entry.status,
      subject: entry.subject,
      serial: entry.serial,
      createdAt,
      expiresAt: entry.expiresAt,
      revokedAt: entry.revokedAt,
      hasConfig,
    };
  }

  async list() {
    return this.easyRSA.withLock(async () => {
      const { entries } = await this._index();
      const named = entries.filter((e) => e.name);
      const described = await Promise.all(named.map((e) => this._describe(e)));
      described.sort((a, b) => a.name.localeCompare(b.name));
      const counts = { total: described.length, valid: 0, revoked: 0, expired: 0, unknown: 0 };
      for (const c of described) counts[c.status] = (counts[c.status] ?? 0) + 1;
      return { clients: described, counts };
    });
  }

  async create(rawName, { password = null, actor = 'api' } = {}) {
    const name = validateClientName(rawName);

    return this.easyRSA.withLock(async () => {
      const { byName } = await this._index();
      const existing = byName.get(name);
      if (existing) {
        if (existing.status === 'revoked') {
          throw new ApiError(
            409,
            ErrorCodes.CLIENT_REVOKED_EXISTS,
            `A revoked client named "${name}" already exists. Easy-RSA keeps revoked certificates for audit purposes — choose another name.`
          );
        }
        throw new ApiError(
          409,
          ErrorCodes.CLIENT_ALREADY_EXISTS,
          existing.status === 'expired'
            ? `A client named "${name}" already exists and its certificate has expired. Choose another name.`
            : `A client with this name already exists.`
        );
      }
      if (await issuedMaterialExists(this.config.easyRsaDir, name)) {
        throw new ApiError(
          409,
          ErrorCodes.CLIENT_ALREADY_EXISTS,
          `Certificate material for "${name}" already exists in the PKI but is not listed in index.txt. Choose another name and run: vpnui doctor`
        );
      }

      await this.easyRSA.buildClient(name, {
        password,
        certDays: this.config.clientCertDays,
      });

      try {
        const { config: document, tlsMode } = await buildClientConfig({
          clientName: name,
          templatePath: this.config.clientTemplate,
          easyRsaDir: this.config.easyRsaDir,
          serverConfig: this.serverConfig,
          commandTimeoutMs: this.config.commandTimeoutMs,
        });
        const configPath = await saveClientConfig({
          clientConfigDir: this.config.clientConfigDir,
          clientName: name,
          config: document,
        });
        await this.audit.record({
          actor,
          action: 'client.create',
          target: name,
          details: { tlsMode, passwordProtected: Boolean(password) },
        });
        this.logger.info({ client: name, tlsMode }, 'client created');
        return { clientName: name, configFile: configPath };
      } catch (error) {
        // The certificate exists at this point; report precisely so the
        // operator can retry the download instead of re-running creation.
        await this.audit.record({
          actor,
          action: 'client.create',
          target: name,
          outcome: 'error',
          details: { error: error.message.slice(0, 300) },
        });
        if (error instanceof ApiError && error.code === ErrorCodes.CONFIG_GENERATION_FAILED) {
          throw new ApiError(
            500,
            ErrorCodes.CONFIG_GENERATION_FAILED,
            `The certificate for "${name}" was created, but generating the .ovpn failed:\n${error.message}\n\nThe client now appears in the client list; retry the configuration download after fixing the problem.`
          );
        }
        throw error;
      }
    });
  }

  async revoke(rawName, { actor = 'api' } = {}) {
    const name = validateClientName(rawName);

    return this.easyRSA.withLock(async () => {
      const { byName } = await this._index();
      const existing = byName.get(name);
      if (!existing) {
        throw new ApiError(404, ErrorCodes.CLIENT_NOT_FOUND, `No client named "${name}" exists.`);
      }
      if (existing.status === 'revoked') {
        throw new ApiError(
          409,
          ErrorCodes.ALREADY_REVOKED,
          `Client "${name}" is already revoked.`
        );
      }

      await this.easyRSA.revokeClient(name);
      await this.easyRSA.generateCrl({ days: this.config.crlDays });
      await installCrl({
        sourcePath: path.join(this.config.easyRsaDir, 'pki', 'crl.pem'),
        targetPath: this.serverConfig.crlPath,
      });

      await deleteClientConfig({
        clientConfigDir: this.config.clientConfigDir,
        clientName: name,
      });

      if (this.serverConfig.ippPath) {
        await removeFromIpp({ ippPath: this.serverConfig.ippPath, clientName: name }).catch(
          (error) => this.logger.warn({ err: error, client: name }, 'ipp cleanup failed')
        );
      }

      const disconnect = await killSession({
        socketPath: this.serverConfig.mgmtSocket ?? this.config.mgmtSocket,
        clientName: name,
      }).catch((error) => ({ attempted: true, ok: false, reason: error.message }));

      await this.audit.record({
        actor,
        action: 'client.revoke',
        target: name,
        details: { crl: this.serverConfig.crlPath, disconnect },
      });
      this.logger.info({ client: name, disconnect }, 'client revoked');
      return { clientName: name, revokedAt: new Date().toISOString(), disconnect };
    });
  }

  async getConfig(rawName, { actor = 'api' } = {}) {
    const name = validateClientName(rawName);

    return this.easyRSA.withLock(async () => {
      const { byName } = await this._index();
      const existing = byName.get(name);
      if (!existing) {
        throw new ApiError(404, ErrorCodes.CLIENT_NOT_FOUND, `No client named "${name}" exists.`);
      }
      if (existing.status === 'revoked') {
        throw new ApiError(
          403,
          ErrorCodes.CLIENT_REVOKED,
          `The configuration for "${name}" was withdrawn because the client is revoked.`
        );
      }

      const cached = await readClientConfig({
        clientConfigDir: this.config.clientConfigDir,
        clientName: name,
      });
      if (cached) return { clientName: name, config: cached, regenerated: false };

      // Config file lost (fresh volume, manual delete): rebuild it.
      const { config: document } = await buildClientConfig({
        clientName: name,
        templatePath: this.config.clientTemplate,
        easyRsaDir: this.config.easyRsaDir,
        serverConfig: this.serverConfig,
        commandTimeoutMs: this.config.commandTimeoutMs,
      });
      await saveClientConfig({
        clientConfigDir: this.config.clientConfigDir,
        clientName: name,
        config: document,
      });
      this.logger.info({ client: name }, 'client config regenerated');
      await this.audit.record({ actor, action: 'client.config.regenerate', target: name });
      return { clientName: name, config: document, regenerated: true };
    });
  }
}
