import { ApiError, ErrorCodes } from '../lib/errors.js';

export function createAuthController({ auth }) {
  return {
    async login(req, res) {
      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        throw new ApiError(400, ErrorCodes.VALIDATION_ERROR, 'Username and password are required.');
      }
      const user = await auth.login({ username, password, ip: req.ip });
      const token = auth.issueToken(user);
      res.json({
        success: true,
        data: { token, user: { username: user.username, role: user.role } },
      });
    },

    async me(req, res) {
      res.json({ success: true, data: { username: req.user.username, role: req.user.role } });
    },
  };
}
