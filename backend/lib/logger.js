import pino from 'pino';

export function createLogger({ level = 'info', exposeRequestHeaders = false } = {}) {
  return pino({
    level,
    base: { app: 'vpnui' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        'newPassword',
        'body.password',
        'body.newPassword',
        'secret',
        'token',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      req(req) {
        const out = { method: req.method, url: req.url };
        if (exposeRequestHeaders) out.headers = req.headers;
        return out;
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  });
}
