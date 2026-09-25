import { ApiError, ErrorCodes } from '../lib/errors.js';
import { validateClientName, requireString } from '../lib/validation.js';

export function createClientController({ clients }) {
  return {
    async list(req, res) {
      const data = await clients.list();
      res.json({ success: true, data });
    },

    async create(req, res) {
      const { clientName, usePassword = false, password } = req.body ?? {};
      validateClientName(clientName);

      let effectivePassword = null;
      if (usePassword) {
        // The passphrase protects the client private key and is never stored server-side.
        requireString(password, 'password', { max: 256 });
        if (password.length < 8) {
          throw new ApiError(
            400,
            ErrorCodes.VALIDATION_ERROR,
            'The client key password must be at least 8 characters.'
          );
        }
        effectivePassword = password;
      }

      const result = await clients.create(clientName, {
        password: effectivePassword,
        actor: req.user.username,
      });
      res.status(201).json({
        success: true,
        data: {
          message: 'Client created successfully',
          clientName: result.clientName,
          configFile: result.configFile,
        },
      });
    },

    async revoke(req, res) {
      const result = await clients.revoke(req.params.clientName, { actor: req.user.username });
      res.json({ success: true, data: { message: 'Client revoked successfully', ...result } });
    },

    async config(req, res) {
      const result = await clients.getConfig(req.params.clientName, { actor: req.user.username });
      if (req.query.download === '1' || req.query.download === 'true') {
        res.setHeader('Content-Type', 'application/x-openvpn-profile');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${result.clientName}.ovpn"`
        );
        return res.send(result.config);
      }
      res.json({
        success: true,
        data: { clientName: result.clientName, config: result.config, regenerated: result.regenerated },
      });
    },
  };
}
