/**
 * Rate limiting. Two independent limiters guard login (per network, per
 * account) and a generous global limiter protects the rest of the API.
 */
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { ErrorCodes } from '../lib/errors.js';

function reject(limit) {
  return (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: ErrorCodes.RATE_LIMITED,
        message: `Too many requests. Try again in ${Math.ceil(limit.windowMs / 60000)} minute(s).`,
      },
    });
  };
}

export function createRateLimiters(config) {
  const disabled = !config.rateLimitEnabled;

  const loginIp = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.rateLimitLoginMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => disabled,
    handler: reject({ windowMs: 15 * 60_000 }),
  });

  const loginAccount = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.rateLimitLoginMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => disabled,
    keyGenerator: (req) =>
      `${ipKeyGenerator(req.ip ?? '0.0.0.0')}|${String(req.body?.username ?? '').toLowerCase()}`,
    handler: reject({ windowMs: 15 * 60_000 }),
  });

  const global = rateLimit({
    windowMs: 60_000,
    limit: config.rateLimitGlobalMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => disabled,
    handler: reject({ windowMs: 60_000 }),
  });

  return { loginIp, loginAccount, global };
}
