/**
 * Append-only audit log (JSON Lines).
 *
 * Records security- and operations-relevant events: logins, client
 * creation/revocation, user management. Never records secrets.
 */
import fs from 'node:fs/promises';

export class AuditLog {
  constructor({ file, logger }) {
    this.file = file;
    this.logger = logger;
    this._queue = Promise.resolve();
  }

  record({ actor = 'system', action, target = null, outcome = 'ok', details = null }) {
    const entry = {
      ts: new Date().toISOString(),
      actor,
      action,
      target,
      outcome,
      details,
    };
    // Serialize appends to avoid interleaved partial lines.
    this._queue = this._queue
      .then(() => fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 }))
      .catch((error) => this.logger?.warn({ err: error }, 'audit append failed'));
    return this._queue;
  }

  async recent(limit = 20) {
    let raw;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const lines = raw.split('\n').filter(Boolean);
    const tail = lines.slice(-Math.max(1, Math.min(limit, 200)));
    const out = [];
    for (const line of tail.reverse()) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // Skip corrupt trailing lines rather than failing the whole listing.
      }
    }
    return out;
  }
}
