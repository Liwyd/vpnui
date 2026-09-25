import { ApiError, ErrorCodes } from '../lib/errors.js';
import {
  validateUsername,
  validatePassword,
  validateRole,
} from '../lib/validation.js';

export function createUserController({ userStore, audit }) {
  return {
    async list(req, res) {
      const users = await userStore.list();
      res.json({ success: true, data: { users } });
    },

    async create(req, res) {
      const { username, password, role } = req.body ?? {};
      validateUsername(username);
      validatePassword(password);
      validateRole(role);
      const created = await userStore.create({ username, password, role });
      await audit.record({
        actor: req.user.username,
        action: 'user.create',
        target: username,
        details: { role },
      });
      res.status(201).json({ success: true, data: { message: 'User created successfully', ...created } });
    },

    async update(req, res) {
      const username = validateUsername(req.params.username);
      const { role, password } = req.body ?? {};
      if (role === undefined && password === undefined) {
        throw new ApiError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'Provide at least one of: role, password.'
        );
      }
      if (role !== undefined) validateRole(role);
      if (password !== undefined) validatePassword(password);
      const updated = await userStore.update(username, { role, password });
      await audit.record({
        actor: req.user.username,
        action: 'user.update',
        target: username,
        details: { role: role ?? '(unchanged)', passwordChanged: password !== undefined },
      });
      res.json({ success: true, data: { message: 'User updated successfully', ...updated } });
    },

    async resetPassword(req, res) {
      const username = validateUsername(req.params.username);
      const { password } = req.body ?? {};
      validatePassword(password);
      await userStore.update(username, { password });
      await audit.record({
        actor: req.user.username,
        action: 'user.reset-password',
        target: username,
      });
      res.json({ success: true, data: { message: 'Password reset successfully' } });
    },

    async remove(req, res) {
      const username = validateUsername(req.params.username);
      if (username === req.user.username) {
        throw new ApiError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'You cannot delete your own account.'
        );
      }
      await userStore.remove(username);
      await audit.record({ actor: req.user.username, action: 'user.delete', target: username });
      res.json({ success: true, data: { message: 'User deleted successfully' } });
    },
  };
}
