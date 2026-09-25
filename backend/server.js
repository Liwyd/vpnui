/**
 * VPNUI server entry point: configuration → services → HTTP → graceful shutdown.
 */
import { loadConfig } from './lib/config.js';
import { ConfigError } from './lib/errors.js';
import { createLogger } from './lib/logger.js';
import { loadServerConfig } from './services/openvpn/serverConfig.js';
import { EasyRSAService } from './services/openvpn/easyRSA.js';
import { ClientService } from './services/openvpn/clients.js';
import { UserStore } from './store/users.js';
import { AuditLog } from './store/audit.js';
import { createApp } from './app.js';

function fatal(message) {
  process.stderr.write(`\nvpnui: configuration error\n\n${message}\n\n`);
  process.exit(1);
}

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) fatal(error.message);
    throw error;
  }

  const logger = createLogger({ level: config.logLevel });

  let serverConfig;
  try {
    serverConfig = await loadServerConfig(config.serverConf, { easyRsaDir: config.easyRsaDir });
  } catch (error) {
    if (error instanceof ConfigError) fatal(error.message);
    throw error;
  }

  const userStore = new UserStore({
    usersFile: config.usersFile,
    bcryptRounds: config.bcryptRounds,
    logger,
  });
  const audit = new AuditLog({ file: config.auditLogFile, logger });
  const easyRSA = new EasyRSAService({
    easyRsaDir: config.easyRsaDir,
    logger,
    commandTimeoutMs: config.commandTimeoutMs,
  });
  const clients = new ClientService({ config, serverConfig, easyRSA, audit, logger });

  // One-shot admin bootstrap (credentials come from the environment, never
  // hardcoded). Runs only while no users exist; the installer removes the
  // variables after the first successful start.
  if (config.adminBootstrapUsername && config.adminBootstrapPassword && (await userStore.isEmpty())) {
    await userStore.create({
      username: config.adminBootstrapUsername,
      password: config.adminBootstrapPassword,
      role: 'admin',
    });
    logger.info({ username: config.adminBootstrapUsername }, 'bootstrap admin user created');
    await audit.record({
      actor: 'bootstrap',
      action: 'user.create',
      target: config.adminBootstrapUsername,
      details: { role: 'admin', bootstrap: true },
    });
  }

  const app = createApp({ config, logger, services: { userStore, audit, clients, serverConfig } });

  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        nodeEnv: config.nodeEnv,
        serverDir: config.serverDir,
        tlsMode: serverConfig.tlsMode,
        authMode: serverConfig.authMode,
        version: config.version,
      },
      'vpnui listening'
    );
  });

  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    force.unref();
    server.close(() => {
      logger.info('shutdown complete');
      process.exit(0);
    });
    server.closeIdleConnections?.();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });
}

main().catch((error) => {
  process.stderr.write(`vpnui: fatal error: ${error?.stack ?? error}\n`);
  process.exit(1);
});
