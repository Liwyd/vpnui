/**
 * ifconfig-pool-persist (ipp.txt) maintenance.
 * Performed with plain file reads/writes — never a shell.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function removeFromIpp({ ippPath, clientName }) {
  let raw;
  try {
    raw = await fs.readFile(ippPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const keep = raw
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith(`${clientName},`));
  const dir = path.dirname(ippPath);
  const tmp = path.join(dir, `.ipp.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, `${keep.join('\n')}${keep.length ? '\n' : ''}`, { mode: 0o644 });
  await fs.rename(tmp, ippPath);
  return true;
}
