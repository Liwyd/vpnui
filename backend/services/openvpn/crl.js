/**
 * CRL management: regenerate with Easy-RSA and install to the exact path
 * the running server.conf references (a wrong path silently leaves revoked
 * clients able to connect).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ApiError, ErrorCodes } from '../../lib/errors.js';

export async function installCrl({ sourcePath, targetPath }) {
  let content;
  try {
    content = await fs.readFile(sourcePath);
  } catch (error) {
    throw new ApiError(
      500,
      ErrorCodes.OPENVPN_ERROR,
      `Generated CRL not found at ${sourcePath} (${error.code ?? error.message}). Run: vpnui doctor`
    );
  }
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.crl.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, content, { mode: 0o644 });
    await fs.rename(tmp, targetPath); // atomic replace — readers never see a partial CRL
    await fs.chmod(targetPath, 0o644);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw new ApiError(
      500,
      ErrorCodes.OPENVPN_ERROR,
      `Could not install the CRL at ${targetPath}: ${error.message}.\n\nCheck that the VPNUI container has write access to the OpenVPN server directory.`
    );
  }
  return targetPath;
}
