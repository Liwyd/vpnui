/**
 * Easy-RSA locator for tests.
 *
 * Resolution order:
 *   1. EASYRSA_TEST_BIN environment variable
 *   2. `easyrsa` on PATH (Debian/Ubuntu package, Fedora package)
 *   3. pinned Easy-RSA tarball downloaded once into tests/.cache (gitignored)
 *
 * Returns null when nothing is available — callers must skip integration
 * tests with an explicit reason instead of faking PKI operations.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EASYRSA_VERSION = '3.2.6';
const EASYRSA_URL = `https://github.com/OpenVPN/easy-rsa/releases/download/v${EASYRSA_VERSION}/EasyRSA-${EASYRSA_VERSION}.tgz`;
// Official release checksum published with Easy-RSA v3.2.6.
const EASYRSA_SHA256 = 'c2572990ce91112eef8d1b8e4a3b58790da95b68501785c621f69121dfbd22d7';

const CACHE_DIR = path.join(__dirname, '..', '.cache');

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function downloadEasyRsa() {
  const tgz = path.join(CACHE_DIR, `EasyRSA-${EASYRSA_VERSION}.tgz`);
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  if (!(await exists(tgz))) {
    const tmp = `${tgz}.download`;
    await execFileAsync('curl', ['-fsSL', '--retry', '3', '-o', tmp, EASYRSA_URL], {
      timeout: 120_000,
    });
    await fsp.rename(tmp, tgz);
  }
  const digest = crypto.createHash('sha256').update(await fsp.readFile(tgz)).digest('hex');
  if (digest !== EASYRSA_SHA256) {
    await fsp.unlink(tgz).catch(() => {});
    throw new Error(`Easy-RSA tarball checksum mismatch (expected ${EASYRSA_SHA256}, got ${digest})`);
  }
  const outDir = path.join(CACHE_DIR, `easy-rsa-${EASYRSA_VERSION}`);
  if (!(await exists(path.join(outDir, 'easyrsa')))) {
    await fsp.mkdir(outDir, { recursive: true });
    await execFileAsync('tar', ['xzf', tgz, '--strip-components=1', '-C', outDir]);
  }
  return outDir;
}

/**
 * Find a usable Easy-RSA installation directory.
 * @returns {Promise<string|null>}
 */
export async function findEasyRsaSource() {
  if (process.env.EASYRSA_TEST_BIN) {
    const p = process.env.EASYRSA_TEST_BIN;
    return (await exists(path.join(p, 'easyrsa'))) ? p : null;
  }
  const candidates = [
    '/usr/share/easy-rsa', // Debian/Ubuntu package
    '/usr/share/easy-rsa/3', // some distros
    '/etc/easy-rsa',
  ];
  for (const dir of candidates) {
    if (await exists(path.join(dir, 'easyrsa'))) return dir;
  }
  try {
    const { stdout } = await execFileAsync('sh', ['-c', 'command -v easyrsa'], { timeout: 5000 });
    const bin = stdout.trim();
    if (bin) return path.dirname(bin);
  } catch {
    /* not on PATH */
  }
  try {
    return await downloadEasyRsa();
  } catch {
    return null;
  }
}

export function openvpnAvailable() {
  try {
    execFileSync('openvpn', ['--version'], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Copy an easy-rsa source dir into a destination (fresh, no pki). */
export async function stageEasyRsa(sourceDir, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  await execFileAsync('cp', ['-a', `${sourceDir}/.`, destDir]);
  await fsp.chmod(path.join(destDir, 'easyrsa'), 0o755).catch(() => {});
  // Ensure a clean slate even if the source had a pki.
  await fsp.rm(path.join(destDir, 'pki'), { recursive: true, force: true });
  return destDir;
}

export { EASYRSA_VERSION, os };
