/**
 * Configuration loading with fail-fast validation.
 *
 * Precedence: explicit environment > validated defaults > safe discovery > clear error.
 * No dangerous fallbacks: JWT_SECRET has no default and must be provided.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { ConfigError } from './errors.js';

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const EXPIRES_RE = /^[1-9][0-9]*(s|m|h|d|w)$/;

function str(env, key, fallback = undefined) {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  return String(value);
}

function int(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(
      `${key} must be an integer between ${min} and ${max} (got "${raw}").`
    );
  }
  return value;
}

function bool(env, key, fallback) {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new ConfigError(`${key} must be a boolean (got "${raw}").`);
}

function mustExist(filePath, hint) {
  if (!fs.existsSync(filePath)) {
    throw new ConfigError(`${hint}\nExpected: ${filePath}`);
  }
  return filePath;
}

/**
 * Resolve the OpenVPN server directory and configuration file.
 * Order: explicit env -> modern layout -> legacy layout -> error.
 */
export function resolveServerLayout(env) {
  const openvpnDir = str(env, 'OPENVPN_DIR', '/etc/openvpn');
  let serverDir;
  if (str(env, 'OPENVPN_SERVER_DIR')) {
    serverDir = path.resolve(str(env, 'OPENVPN_SERVER_DIR'));
  } else if (fs.existsSync(path.join(openvpnDir, 'server', 'server.conf'))) {
    serverDir = path.join(openvpnDir, 'server');
  } else if (fs.existsSync(path.join(openvpnDir, 'server.conf'))) {
    serverDir = openvpnDir;
  } else {
    throw new ConfigError(
      [
        'OpenVPN server configuration was not found.',
        '',
        'Looked for:',
        `  ${path.join(openvpnDir, 'server', 'server.conf')}  (modern layout)`,
        `  ${path.join(openvpnDir, 'server.conf')}  (legacy layout)`,
        '',
        'Possible causes:',
        '  - OpenVPN is not installed or was never initialized',
        '  - OPENVPN_DIR / OPENVPN_SERVER_DIR are incorrect',
        '',
        'Run: vpnui doctor',
      ].join('\n')
    );
  }

  const serverConf = str(env, 'SERVER_CONF')
    ? path.resolve(str(env, 'SERVER_CONF'))
    : path.join(serverDir, 'server.conf');
  if (!fs.existsSync(serverConf)) {
    throw new ConfigError(
      [
        'OpenVPN server configuration file is missing.',
        '',
        `Expected: ${serverConf}`,
        '',
        'Set SERVER_CONF / OPENVPN_SERVER_DIR if your layout differs.',
        '',
        'Run: vpnui doctor',
      ].join('\n')
    );
  }
  return { openvpnDir, serverDir, serverConf };
}

export function resolveEasyRsa(env, serverDir) {
  let easyRsaDir;
  if (str(env, 'EASY_RSA_DIR')) {
    easyRsaDir = path.resolve(str(env, 'EASY_RSA_DIR'));
  } else if (fs.existsSync(path.join(serverDir, 'easy-rsa', 'pki'))) {
    easyRsaDir = path.join(serverDir, 'easy-rsa');
  } else if (fs.existsSync(path.join(str(env, 'OPENVPN_DIR', '/etc/openvpn'), 'easy-rsa', 'pki'))) {
    easyRsaDir = path.join(str(env, 'OPENVPN_DIR', '/etc/openvpn'), 'easy-rsa');
  } else {
    throw new ConfigError(
      [
        'Easy-RSA PKI directory was not found.',
        '',
        'Expected one of:',
        `  ${path.join(serverDir, 'easy-rsa', 'pki')}`,
        `  ${path.join(str(env, 'OPENVPN_DIR', '/etc/openvpn'), 'easy-rsa', 'pki')}`,
        '',
        'Possible causes:',
        '  - OpenVPN/Easy-RSA has not been initialized',
        '  - EASY_RSA_DIR is incorrect',
        '',
        'Run: vpnui doctor',
      ].join('\n')
    );
  }
  const indexFile = str(env, 'INDEX_FILE')
    ? path.resolve(str(env, 'INDEX_FILE'))
    : path.join(easyRsaDir, 'pki', 'index.txt');
  mustExist(
    indexFile,
    [
      'OpenVPN PKI index file was not found.',
      '',
      'Possible causes:',
      '  - OpenVPN has not been initialized',
      '  - EASY_RSA_DIR / INDEX_FILE are incorrect',
      '  - the PKI was removed',
      '',
      'Run: vpnui doctor',
    ].join('\n')
  );
  return { easyRsaDir, indexFile };
}

/**
 * Load and validate the full runtime configuration.
 * Throws ConfigError with an operator-actionable message on any problem.
 */
export function loadConfig(env = process.env, { cwd = process.cwd() } = {}) {
  dotenv.config({ path: path.join(cwd, '.env'), quiet: true });

  const nodeEnv = str(env, 'NODE_ENV', 'production');
  const logLevel = str(env, 'LOG_LEVEL', nodeEnv === 'test' ? 'warn' : 'info');
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of: ${[...LOG_LEVELS].join(', ')} (got "${logLevel}").`);
  }

  const jwtSecret = str(env, 'JWT_SECRET');
  if (!jwtSecret) {
    throw new ConfigError(
      [
        'JWT_SECRET is required and has no default.',
        '',
        'Generate one with:',
        '  openssl rand -hex 32',
        '',
        'Then add it to your .env file (see .env.example).',
      ].join('\n')
    );
  }
  if (jwtSecret.length < 32) {
    throw new ConfigError(
      `JWT_SECRET must be at least 32 characters (got ${jwtSecret.length}). Generate one with: openssl rand -hex 32`
    );
  }

  const jwtExpiresIn = str(env, 'JWT_EXPIRES_IN', '12h');
  if (!EXPIRES_RE.test(jwtExpiresIn)) {
    throw new ConfigError(
      `JWT_EXPIRES_IN must look like 12h, 30m, 7d (got "${jwtExpiresIn}").`
    );
  }

  const { openvpnDir, serverDir, serverConf } = resolveServerLayout(env);
  const { easyRsaDir, indexFile } = resolveEasyRsa(env, serverDir);

  const dataDir = path.resolve(str(env, 'DATA_DIR', path.join(cwd, 'data')));
  const clientConfigDir = str(env, 'CLIENT_CONFIG_DIR', path.join(dataDir, 'clients'));
  const usersFile = str(env, 'USERS_FILE', path.join(dataDir, 'users.json'));
  const auditLogFile = str(env, 'AUDIT_LOG_FILE', path.join(dataDir, 'audit.log'));

  for (const dir of [dataDir, clientConfigDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new ConfigError(`Cannot create data directory ${dir}: ${error.message}`);
    }
  }

  const clientTemplate = str(env, 'CLIENT_TEMPLATE', path.join(serverDir, 'client-template.txt'));
  mustExist(
    clientTemplate,
    [
      'OpenVPN client template was not found.',
      '',
      'VPNUI uses it as the base of every generated .ovpn file.',
      'Set CLIENT_TEMPLATE if your layout differs.',
      '',
      'Run: vpnui doctor',
    ].join('\n')
  );

  return Object.freeze({
    nodeEnv,
    isProduction: nodeEnv === 'production',
    isTest: nodeEnv === 'test',
    version: str(env, 'APP_VERSION', '1.0.0'),
    port: int(env, 'PORT', 3000, { min: 1, max: 65535 }),
    logLevel,
    trustProxy: env.TRUST_PROXY === undefined ? false : parseTrustProxy(env.TRUST_PROXY),

    jwtSecret,
    jwtExpiresIn,
    bcryptRounds: int(env, 'BCRYPT_ROUNDS', 12, { min: 10, max: 15 }),

    openvpnDir,
    serverDir,
    serverConf,
    easyRsaDir,
    indexFile,
    clientTemplate,
    dataDir,
    clientConfigDir,
    usersFile,
    auditLogFile,

    statusFile: str(env, 'STATUS_FILE', '/var/log/openvpn/status.log'),
    mgmtSocket: str(env, 'MGMT_SOCKET', '/var/run/openvpn-server/server.sock'),
    publicEndpoint: str(env, 'SERVER_ENDPOINT'),

    clientCertDays: int(env, 'CLIENT_CERT_DAYS', 3650, { min: 1, max: 36500 }),
    crlDays: int(env, 'CRL_DAYS', 5475, { min: 1, max: 36500 }),
    commandTimeoutMs: int(env, 'COMMAND_TIMEOUT_MS', 120_000, { min: 1000, max: 600_000 }),

    rateLimitEnabled: bool(env, 'RATE_LIMIT_ENABLED', true),
    rateLimitLoginMax: int(env, 'RATE_LIMIT_LOGIN_MAX', 10, { min: 1, max: 100_000 }),
    rateLimitGlobalMax: int(env, 'RATE_LIMIT_GLOBAL_MAX', 600, { min: 1, max: 1_000_000 }),

    adminBootstrapUsername: str(env, 'ADMIN_USERNAME'),
    adminBootstrapPassword: str(env, 'ADMIN_PASSWORD'),
  });
}

function parseTrustProxy(raw) {
  const value = String(raw).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return 1;
  if (['0', 'false', 'no', 'off', ''].includes(value)) return false;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  // Express also accepts e.g. "loopback" — pass strings through.
  return raw;
}
