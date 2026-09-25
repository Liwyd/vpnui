/**
 * Typed application errors and the Express error handlers.
 *
 * ApiError      — errors that are safe to surface to API clients.
 * ConfigError   — startup configuration problems (fail fast, operator-facing).
 * CommandError  — external process failures (easyrsa / openvpn).
 */

export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'CONFIG_ERROR';
  }
}

export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
  RATE_LIMITED: 'RATE_LIMITED',
  USERS_NOT_INITIALIZED: 'USERS_NOT_INITIALIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  CLIENT_ALREADY_EXISTS: 'CLIENT_ALREADY_EXISTS',
  CLIENT_REVOKED_EXISTS: 'CLIENT_REVOKED_EXISTS',
  CLIENT_NOT_FOUND: 'CLIENT_NOT_FOUND',
  CLIENT_REVOKED: 'CLIENT_REVOKED',
  ALREADY_REVOKED: 'ALREADY_REVOKED',
  OPENVPN_ERROR: 'OPENVPN_ERROR',
  OPENVPN_UNAVAILABLE: 'OPENVPN_UNAVAILABLE',
  TLS_CRYPT_V2_UNAVAILABLE: 'TLS_CRYPT_V2_UNAVAILABLE',
  CONFIG_GENERATION_FAILED: 'CONFIG_GENERATION_FAILED',
  NOT_INITIALIZED: 'NOT_INITIALIZED',
};

/** Wrap async route handlers (belt-and-braces; Express 5 also forwards rejections). */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: { code: ErrorCodes.NOT_FOUND, message: `No route for ${req.method} ${req.path}` },
  });
}

export function createErrorHandler({ logger, exposeStack }) {
  return (err, req, res, _next) => {
    if (res.headersSent) {
      logger.error({ err }, 'error after response started');
      return;
    }

    if (err instanceof ApiError) {
      if (err.status >= 500) {
        logger.error({ err, path: req.path, method: req.method }, 'request failed');
      } else {
        logger.warn({ code: err.code, path: req.path, method: req.method }, 'request rejected');
      }
      const body = { success: false, error: { code: err.code, message: err.message } };
      if (err.details !== undefined) body.error.details = err.details;
      if (exposeStack && err.stack) body.error.stack = err.stack.split('\n').slice(0, 6).join('\n');
      return res.status(err.status).json(body);
    }

    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({
        success: false,
        error: { code: ErrorCodes.VALIDATION_ERROR, message: 'Request body is not valid JSON.' },
      });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        success: false,
        error: { code: ErrorCodes.VALIDATION_ERROR, message: 'Request body too large.' },
      });
    }

    logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
    const body = {
      success: false,
      error: { code: ErrorCodes.INTERNAL, message: 'Internal server error.' },
    };
    if (exposeStack && err.stack) body.error.stack = err.stack.split('\n').slice(0, 8).join('\n');
    res.status(500).json(body);
  };
}
