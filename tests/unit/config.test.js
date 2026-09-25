import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../../backend/lib/config.js';
import { ConfigError } from '../../backend/lib/errors.js';
import { makeMinimalFixture } from '../helpers/pki.mjs';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

async function withFixture(fn) {
  const fixture = await makeMinimalFixture();
  try {
    await fn(fixture);
  } finally {
    await fixture.cleanup();
  }
}

function baseEnv(fixture) {
  return {
    NODE_ENV: 'test',
    JWT_SECRET: SECRET,
    OPENVPN_SERVER_DIR: fixture.serverDir,
    EASY_RSA_DIR: fixture.easyRsaDir,
    DATA_DIR: path.join(fixture.dataDir, 'cfgtest'),
  };
}

test('JWT_SECRET is required and must be strong', async () => {
  await withFixture((fixture) => {
    assert.throws(
      () => loadConfig({ ...baseEnv(fixture), JWT_SECRET: '' }),
      (e) => e instanceof ConfigError && /openssl rand -hex 32/.test(e.message)
    );
    assert.throws(
      () => loadConfig({ ...baseEnv(fixture), JWT_SECRET: 'short' }),
      (e) => e instanceof ConfigError && /at least 32 characters/.test(e.message)
    );
  });
});

test('rejects malformed values with actionable messages', async () => {
  await withFixture((fixture) => {
    assert.throws(() => loadConfig({ ...baseEnv(fixture), PORT: '99999' }), ConfigError);
    assert.throws(() => loadConfig({ ...baseEnv(fixture), PORT: 'abc' }), ConfigError);
    assert.throws(() => loadConfig({ ...baseEnv(fixture), JWT_EXPIRES_IN: 'forever' }), ConfigError);
    assert.throws(() => loadConfig({ ...baseEnv(fixture), LOG_LEVEL: 'loud' }), ConfigError);
    assert.throws(() => loadConfig({ ...baseEnv(fixture), RATE_LIMIT_ENABLED: 'maybe' }), ConfigError);
  });
});

test('missing OpenVPN layout fails fast with doctor guidance', async () => {
  await withFixture((fixture) => {
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv(fixture),
          OPENVPN_SERVER_DIR: path.join(fixture.root, 'does-not-exist'),
          EASY_RSA_DIR: path.join(fixture.root, 'does-not-exist'),
        }),
      (e) => e instanceof ConfigError && /vpnui doctor/.test(e.message)
    );
  });
});

test('missing client template fails fast', async () => {
  await withFixture((fixture) => {
    assert.throws(
      () => loadConfig({ ...baseEnv(fixture), CLIENT_TEMPLATE: path.join(fixture.root, 'nope.txt') }),
      (e) => e instanceof ConfigError && /client template/i.test(e.message)
    );
  });
});

test('loads a valid configuration and creates the data directory', async () => {
  await withFixture((fixture) => {
    const config = loadConfig(baseEnv(fixture));
    assert.equal(config.serverDir, fixture.serverDir);
    assert.equal(config.serverConf, fixture.serverConf);
    assert.equal(config.easyRsaDir, fixture.easyRsaDir);
    assert.equal(config.indexFile, fixture.indexFile);
    assert.equal(config.jwtExpiresIn, '12h');
    assert.equal(config.bcryptRounds, 12);
    assert.ok(Object.isFrozen(config));
    // data + clients dirs exist
    assert.ok(config.clientConfigDir.startsWith(path.join(fixture.dataDir, 'cfgtest')));
  });
});

test('defaults resolve modern layout by discovery when env points at it', async () => {
  await withFixture((fixture) => {
    const config = loadConfig({
      JWT_SECRET: SECRET,
      OPENVPN_DIR: fixture.root, // root/server/server.conf does not exist... use explicit
      OPENVPN_SERVER_DIR: fixture.serverDir,
      EASY_RSA_DIR: fixture.easyRsaDir,
      DATA_DIR: path.join(fixture.dataDir, 'discovery'),
    });
    assert.equal(config.serverDir, fixture.serverDir);
  });
});
