import { Router } from 'express';

/**
 * API surface:
 *
 *   POST   /api/login                          public (rate limited)
 *   GET    /api/health is NOT here — /health is a top-level route
 *   GET    /api/status                         status:read
 *   GET    /api/clients                        clients:read
 *   POST   /api/clients                        clients:create
 *   GET    /api/clients/:name/config           clients:read   (?download=1 → attachment)
 *   DELETE /api/clients/:name                  clients:revoke
 *   GET    /api/users/me                       any authenticated user
 *   GET    /api/users                          users:manage
 *   POST   /api/users                          users:manage
 *   PUT    /api/users/:username                users:manage
 *   POST   /api/users/:username/reset-password users:manage
 *   DELETE /api/users/:username                users:manage
 */
export function createApiRouter({ auth, controllers, rateLimiters }) {
  const router = Router();

  router.post('/login', rateLimiters.loginIp, rateLimiters.loginAccount, controllers.auth.login);

  router.use(auth.authenticate);

  router.get('/users/me', controllers.auth.me);
  router.get('/status', auth.requirePermission('status:read'), controllers.status.get);

  router.get('/clients', auth.requirePermission('clients:read'), controllers.clients.list);
  router.post('/clients', auth.requirePermission('clients:create'), controllers.clients.create);
  router.get(
    '/clients/:clientName/config',
    auth.requirePermission('clients:read'),
    controllers.clients.config
  );
  router.delete(
    '/clients/:clientName',
    auth.requirePermission('clients:revoke'),
    controllers.clients.revoke
  );

  router.get('/users', auth.requirePermission('users:manage'), controllers.users.list);
  router.post('/users', auth.requirePermission('users:manage'), controllers.users.create);
  router.put('/users/:username', auth.requirePermission('users:manage'), controllers.users.update);
  router.post(
    '/users/:username/reset-password',
    auth.requirePermission('users:manage'),
    controllers.users.resetPassword
  );
  router.delete('/users/:username', auth.requirePermission('users:manage'), controllers.users.remove);

  return router;
}
