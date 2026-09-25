/**
 * OpenVPN status-file reader: currently connected clients and traffic.
 * The status file is optional (ro mount); everything degrades gracefully.
 */
import fs from 'node:fs/promises';

export async function readStatus(statusPath, { maxAgeMs = 5 * 60_000 } = {}) {
  if (!statusPath) return { available: false, reason: 'not-configured', sessions: [], updatedAt: null };
  let raw;
  try {
    raw = await fs.readFile(statusPath, 'utf8');
  } catch (error) {
    return { available: false, reason: error.code ?? 'error', sessions: [], updatedAt: null };
  }

  const lines = raw.split('\n');
  const sessions = [];
  let section = null;
  let updatedAt = null;

  for (const line of lines) {
    if (line.startsWith('Updated,')) {
      updatedAt = line.slice('Updated,'.length).trim();
      continue;
    }
    if (line === 'OpenVPN CLIENT LIST') {
      section = 'clients';
      continue;
    }
    if (line === 'ROUTING TABLE' || line === 'GLOBAL STATS' || line === 'END') {
      section = null;
      continue;
    }
    if (section === 'clients') {
      if (line.startsWith('Common Name,')) continue;
      const cols = line.split(',');
      if (cols.length < 5) continue;
      const [commonName, realIp, bytesReceived, bytesSent, connectedSince] = cols;
      if (!commonName) continue;
      sessions.push({
        commonName,
        realIp,
        bytesReceived: Number(bytesReceived) || 0,
        bytesSent: Number(bytesSent) || 0,
        connectedSince: connectedSince || null,
      });
    }
  }

  // OpenVPN writes "Updated,Thu Sep 25 18:30:00 2026"; parsers are lenient
  // here — an unparseable timestamp simply counts as fresh.
  let stale = false;
  if (updatedAt) {
    const parsed = Date.parse(updatedAt);
    if (!Number.isNaN(parsed)) stale = Date.now() - parsed > maxAgeMs;
  }
  return {
    available: true,
    reason: null,
    sessions,
    updatedAt,
    stale,
  };
}
