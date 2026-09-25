import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';

import { securityHeaders } from './middleware/security.js';
import { createRateLimiters } from './middleware/rateLimit.js';
import { createAuth } from './middleware/auth.js';
import { createApiRouter } from './routes/api.js';
import { createAuthController } from './controllers/authController.js';
import { createClientController } from './controllers/clientController.js';
import { createUserController } from './controllers/userController.js';
import { createStatusController } from './controllers/statusController.js';
import { createHealthController } from './controllers/healthController.js';
import { createErrorHandler, notFoundHandler } from './lib/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/**
 * Assemble the Express application.
 * Dependencies are injected so tests can wire fixtures without a real PKI.
 */
export function createApp({ config, logger, services }) {
  const { userStore, audit, clients, serverConfig } = services;

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders());
  app.use(compression());
  app.use(express.json({ limit: '64kb' }));

  // Structured request logs (static assets at debug level to keep prod quiet).
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const isAsset = req.path.startsWith('/vendor/') || req.path.startsWith('/js/');
      logger[isAsset ? 'debug' : 'info'](
        { req, res, durationMs: Math.round(durationMs * 10) / 10 },
        'request'
      );
    });
    next();
  });

  const rateLimiters = createRateLimiters(config);
  const auth = createAuth({ config, userStore, audit, logger });

  const controllers = {
    auth: createAuthController({ auth }),
    clients: createClientController({ clients }),
    users: createUserController({ userStore, audit }),
    status: createStatusController({ config, serverConfig, clients, audit }),
    health: createHealthController({ config }),
  };

  app.get('/health', controllers.health.health);
  app.use('/api', rateLimiters.global, createApiRouter({ auth, controllers, rateLimiters }));

  // Unknown API routes → JSON 404 (never the SPA shell).
  app.use('/api', notFoundHandler);

  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      etag: true,
      maxAge: '1h',
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}vendor${path.sep}`) || filePath.includes(`${path.sep}js${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        }
      },
    })
  );

  // SPA fallback for non-API GETs.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (error) => {
      if (error) next(error);
    });
  });

  app.use(notFoundHandler);
  app.use(createErrorHandler({ logger, exposeStack: !config.isProduction }));

  return app;
}
