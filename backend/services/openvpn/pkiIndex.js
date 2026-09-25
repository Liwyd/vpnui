/**
 * Easy-RSA pki/index.txt parser.
 *
 * Format (tab separated):
 *   V<TAB>expiry<TAB><revocation><TAB>serial<TAB>file<TAB>subject
 *   R<TAB>expiry<TAB>revocation<TAB>serial<TAB>file<TAB>subject
 *   E<TAB>expiry<TAB><TAB><TAB><TAB>subject
 *
 * The subject is a DN such as `/C=XX/O=Example/CN=laptop`; the client name
 * is the CN. CN values may contain `=`, so the DN is parsed structurally
 * instead of by naive splitting.
 */
import fs from 'node:fs/promises';

const STATUS_MAP = { V: 'valid', R: 'revoked', E: 'expired' };

/** Parse an ASN.1 UTCTime-ish `YYMMDDHHMMSSZ` date. */
export function parseIndexDate(raw) {
  if (!raw) return null;
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z?$/.exec(raw.trim());
  if (!m) return null;
  const [, yy, mo, dd, hh, mm, ss] = m;
  const year = Number(yy) >= 50 ? 1900 + Number(yy) : 2000 + Number(yy);
  const date = new Date(Date.UTC(year, Number(mo) - 1, Number(dd), Number(hh), Number(mm), Number(ss)));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function extractCn(subject) {
  if (!subject) return null;
  const normalized = subject.startsWith('/') ? subject : `/${subject}`;
  const re = /\/CN=([^/]*)(?:\/|$)/g;
  let match;
  let last = null;
  while ((match = re.exec(normalized)) !== null) {
    last = match[1];
  }
  return last && last.length > 0 ? last : null;
}

export function parseIndexLine(line) {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.trim()) return null;
  const parts = trimmed.split('\t');
  const statusFlag = parts[0]?.trim();
  const known = STATUS_MAP[statusFlag];
  const expiry = parts[1] ?? '';
  const revokedAt = parts[2] ?? '';
  const serial = parts[3] ?? '';
  const subject = parts[5] ?? '';
  const name = extractCn(subject);
  const expiresAt = parseIndexDate(expiry);

  let status;
  if (parts.length < 6 || !subject) {
    // Malformed/truncated line: never guess a state.
    status = 'unknown';
  } else if (known === 'valid' && expiresAt && expiresAt.getTime() < Date.now()) {
    status = 'expired';
  } else if (known) {
    status = known;
  } else {
    status = 'unknown';
  }

  return {
    status,
    name,
    subject: subject || null,
    serial: serial || null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    revokedAt: revokedAt ? (parseIndexDate(revokedAt)?.toISOString() ?? null) : null,
    rawStatus: statusFlag ?? null,
  };
}

export function parseIndex(text) {
  const entries = [];
  const seen = new Map();
  for (const line of text.split('\n')) {
    const entry = parseIndexLine(line);
    if (!entry) continue;
    entries.push(entry);
    if (entry.name) seen.set(entry.name, entry);
  }
  return { entries, byName: seen };
}

export async function readIndexFile(indexPath) {
  let text;
  try {
    text = await fs.readFile(indexPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      const err = new Error(
        `OpenVPN PKI index file was not found.\n\nExpected:\n ${indexPath}\n\nPossible causes:\n - OpenVPN has not been initialized\n - EASY_RSA_DIR is incorrect\n - the PKI was removed\n\nRun: vpnui doctor`
      );
      err.code = 'NOT_INITIALIZED';
      throw err;
    }
    throw error;
  }
  return parseIndex(text);
}

/**
 * Resolve the effective state of a client name.
 *
 * easy-rsa can contain multiple historical entries for one CN (an old
 * revoked certificate plus, in some workflows, a newer issuance). The most
 * recent entry wins; `valid` requires a non-expired certificate.
 */
export function effectiveStatus(byName, name) {
  return byName.get(name) ?? null;
}
