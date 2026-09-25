/**
 * Shared input validation. Client names are attacker-controlled input that
 * becomes a filesystem path, an Easy-RSA argument and a certificate CN, so a
 * strict allowlist (not sanitization) is used everywhere.
 */
import { ApiError, ErrorCodes } from './errors.js';

export const CLIENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,64}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;
export const ROLES = Object.freeze(['admin', 'operator', 'user', 'readonly']);

export function validateClientName(name) {
  if (typeof name !== 'string' || !CLIENT_NAME_RE.test(name)) {
    throw new ApiError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      'Invalid client name. Use 1-64 characters: letters, digits, underscores and dashes only.'
    );
  }
  return name;
}

export function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new ApiError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      'Invalid username. Use 3-64 characters: letters, digits, dots, underscores and dashes only.'
    );
  }
  return username;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new ApiError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`
    );
  }
  return password;
}

export function validateRole(role) {
  if (typeof role !== 'string' || !ROLES.includes(role)) {
    throw new ApiError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `Role must be one of: ${ROLES.join(', ')}.`
    );
  }
  return role;
}

export function requireString(value, field, { max = 512 } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, ErrorCodes.VALIDATION_ERROR, `${field} is required.`);
  }
  if (value.length > max) {
    throw new ApiError(400, ErrorCodes.VALIDATION_ERROR, `${field} must be at most ${max} characters.`);
  }
  return value;
}
