/**
 * Authentication (JWT, HS256 pinned) and authorization (role → permission).
 */
import jwt from 'jsonwebtoken';
import { ApiError, ErrorCodes } from '../lib/errors.js';

export const PERMISSIONS = Object.freeze({
  admin: ['status:read', 'clients:read', 'clients:create', 'clients:revoke', 'users:manage'],
  operator: ['status:read', 'clients:read', 'clients:create', 'clients:revoke'],
  user: ['status:read', 'clients:read', 'clients:create'],
  readonly: ['status:read', 'clients:read'],
});

export function createAuth({ config, userStore, audit, logger }) {
  function authenticate(req, res, next) {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return next(new ApiError(401, ErrorCodes.UNAUTHORIZED, 'Authentication token required.'));
    }
    try {
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      if (!payload || typeof payload.sub !== 'string' || typeof payload.role !== 'string') {
        return next(new ApiError(401, ErrorCodes.UNAUTHORIZED, 'Invalid token payload.'));
      }
      req.user = { username: payload.sub, role: payload.role };
      next();
    } catch (error) {
      const message =
        error.name === 'TokenExpiredError'
          ? 'Token expired. Please log in again.'
          : 'Invalid or expired token.';
      next(new ApiError(401, ErrorCodes.UNAUTHORIZED, message));
    }
  }

  function requirePermission(permission) {
    return (req, res, next) => {
      if (!req.user) {
        return next(new ApiError(401, ErrorCodes.UNAUTHORIZED, 'Authentication required.'));
      }
      const allowed = PERMISSIONS[req.user.role] ?? [];
      if (!allowed.includes(permission)) {
        logger.warn(
          { user: req.user.username, role: req.user.role, permission, path: req.path },
          'permission denied'
        );
        return next(
          new ApiError(403, ErrorCodes.FORBIDDEN, `Your role (${req.user.role}) cannot perform this action.`)
        );
      }
      next();
    };
  }

  function issueToken(user) {
    return jwt.sign({ sub: user.username, role: user.role }, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: config.jwtExpiresIn,
    });
  }

  async function login({ username, password, ip }) {
    const user = await userStore.verify(username, password);
    if (!user) {
      await audit.record({
        actor: username,
        action: 'auth.login',
        outcome: 'denied',
        details: { ip },
      });
      throw new ApiError(403, ErrorCodes.INVALID_CREDENTIALS, 'Invalid username or password.');
    }
    await userStore.markLogin(user.username);
    await audit.record({ actor: user.username, action: 'auth.login', details: { ip } });
    return user;
  }

  return { authenticate, requirePermission, issueToken, login };
}
