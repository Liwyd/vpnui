import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateClientName,
  validateUsername,
  validatePassword,
  validateRole,
} from '../../backend/lib/validation.js';
import { ApiError } from '../../backend/lib/errors.js';

test('accepts safe client names', () => {
  for (const name of ['a', 'laptop-1', 'phone_2', 'A9_-', 'x'.repeat(64)]) {
    assert.equal(validateClientName(name), name);
  }
});

test('rejects dangerous client names', () => {
  const dangerous = [
    '',
    '../etc/passwd',
    '..',
    'a/b',
    'a\\b',
    'a;id',
    'a&&id',
    'a|id',
    'a`id`',
    'a$(id)',
    'a b',
    'a"b',
    "a'b",
    'a\nb',
    '.hidden',
    'x'.repeat(65),
    42,
    null,
    undefined,
    {},
  ];
  for (const name of dangerous) {
    assert.throws(
      () => validateClientName(name),
      (error) => error instanceof ApiError && error.status === 400,
      `expected rejection for ${JSON.stringify(name)}`
    );
  }
});

test('usernames must be well formed', () => {
  assert.equal(validateUsername('admin.user-1_x'), 'admin.user-1_x');
  assert.throws(() => validateUsername('ab'), ApiError);
  assert.throws(() => validateUsername('<img src=x>'), ApiError);
  assert.throws(() => validateUsername('a'.repeat(65)), ApiError);
});

test('password policy', () => {
  assert.equal(validatePassword('longenough'), 'longenough');
  assert.throws(() => validatePassword('short'), ApiError);
  assert.throws(() => validatePassword(123456789), ApiError);
});

test('roles are allowlisted', () => {
  assert.equal(validateRole('admin'), 'admin');
  assert.throws(() => validateRole('superuser'), ApiError);
  assert.throws(() => validateRole({}), ApiError);
});
