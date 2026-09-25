import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIndex, parseIndexLine, extractCn, parseIndexDate } from '../../backend/services/openvpn/pkiIndex.js';

const VALID = 'V\t290101120000Z\t\t01\tunknown\t/CN=alice';
const REVOKED = 'R\t290101120000Z\t250101120000Z\t02\tunknown\t/CN=bob';
const EXPIRED = 'V\t200101120000Z\t\t03\tunknown\t/CN=carol';
const DN_FORM = 'V\t290101120000Z\t\t04\tunknown\t/O=Example Org/CN=dave=extra';

test('parses valid, revoked and expired entries', () => {
  assert.equal(parseIndexLine(VALID).status, 'valid');
  assert.equal(parseIndexLine(REVOKED).status, 'revoked');
  assert.equal(parseIndexLine(EXPIRED).status, 'expired');
});

test('extracts names with = from DN without truncation', () => {
  const entry = parseIndexLine(DN_FORM);
  assert.equal(entry.name, 'dave=extra');
  assert.equal(extractCn('/O=X/CN=plain'), 'plain');
  assert.equal(extractCn('CN=no-leading-slash'), 'no-leading-slash');
  assert.equal(extractCn('/C=XX/O=Y'), null);
});

test('parses UTCTime dates', () => {
  const date = parseIndexDate('290101120000Z');
  assert.equal(date.toISOString(), '2029-01-01T12:00:00.000Z');
  assert.equal(parseIndexDate('990101120000Z').getUTCFullYear(), 1999);
  assert.equal(parseIndexDate(''), null);
  assert.equal(parseIndexDate('garbage'), null);
});

test('skips blank lines and indexes by name', () => {
  const { entries, byName } = parseIndex(`${VALID}\n\n${REVOKED}\n\n`);
  assert.equal(entries.length, 2);
  assert.equal(byName.get('alice').status, 'valid');
  assert.equal(byName.get('bob').status, 'revoked');
  assert.equal(byName.get('ghost'), undefined);
});

test('handles missing tab fields without throwing', () => {
  const entry = parseIndexLine('V');
  assert.ok(entry);
  assert.equal(entry.status, 'unknown');
  assert.equal(entry.name, null);
});

test('revocation date is captured', () => {
  assert.equal(parseIndexLine(REVOKED).revokedAt, '2025-01-01T12:00:00.000Z');
});
