/**
 * Shared test context: a fully wired application instance bound to a
 * temporary fixture (never the host's OpenVPN installation).
 */
import { loadConfig } from '../../backend/lib/config.js';
import { createLogger } from '../../backend/lib/logger.js';
import { loadServerConfig } from '../../backend/services/openvpn/serverConfig.js';
import { EasyRSAService } from '../../backend/services/openvpn/easyRSA.js';
import { ClientService } from '../../backend/services/openvpn/clients.js';
import { UserStore } from '../../backend/store/users.js';
import { AuditLog } from '../../backend/store/audit.js';
import { createApp } from '../../backend/app.js';

export const TEST_JWT_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

export async function createTestContext(fixture, { env: extraEnv = {}, rounds = 10 } = {}) {
  const env = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JWT_SECRET: TEST_JWT_SECRET,
    JWT_EXPIRES_IN: '1h',
    OPENVPN_SERVER_DIR: fixture.serverDir,
    EASY_RSA_DIR: fixture.easyRsaDir,
    DATA_DIR: fixture.dataDir,
    BCRYPT_ROUNDS: String(rounds),
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_LOGIN_MAX: '100000',
    RATE_LIMIT_GLOBAL_MAX: '1000000',
    CLIENT_CERT_DAYS: '3650',
    COMMAND_TIMEOUT_MS: '120000',
    ...extraEnv,
  };

  const config = loadConfig(env);
  const logger = createLogger({ level: 'silent' });
  const serverConfig = await loadServerConfig(config.serverConf, { easyRsaDir: config.easyRsaDir });
  const userStore = new UserStore({ usersFile: config.usersFile, bcryptRounds: rounds, logger });
  const audit = new AuditLog({ file: config.auditLogFile, logger });
  const easyRSA = new EasyRSAService({
    easyRsaDir: config.easyRsaDir,
    logger,
    commandTimeoutMs: config.commandTimeoutMs,
  });
  const clients = new ClientService({ config, serverConfig, easyRSA, audit, logger });
  const app = createApp({
    config,
    logger,
    services: { userStore, audit, clients, serverConfig },
  });

  return { app, config, logger, serverConfig, userStore, audit, easyRSA, clients };
}

/** Start the app on an ephemeral port; returns helpers + close(). */
export async function startServer(ctx) {
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { token, body, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (token) init.headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON response */
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  return {
    base,
    server,
    request,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function login(server, username, password) {
  const res = await server.request('POST', '/api/login', { body: { username, password } });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${res.text}`);
  }
  return res.json.data.token;
}
