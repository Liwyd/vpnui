export function createHealthController({ config }) {
  return {
    // Lightweight, unauthenticated, used by Docker HEALTHCHECK and installers.
    health(req, res) {
      res.json({
        status: 'ok',
        version: config.version,
        uptimeSeconds: Math.round(process.uptime()),
        time: new Date().toISOString(),
      });
    },
  };
}
