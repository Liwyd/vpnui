/**
 * Best-effort disconnect of a live session through OpenVPN's management
 * interface (unix socket). Revocation always prevents *new* connections via
 * the CRL; this additionally drops the current session when available.
 */
import net from 'node:net';

export async function killSession({ socketPath, clientName, timeoutMs = 3000 }) {
  if (!socketPath) return { attempted: false, reason: 'not-configured' };

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = net.connect(socketPath);
    const timer = setTimeout(() => done({ attempted: true, ok: false, reason: 'timeout' }), timeoutMs);

    socket.on('connect', () => {
      socket.write(`kill ${clientName}\r\n`);
    });
    socket.on('data', (data) => {
      clearTimeout(timer);
      const text = data.toString('utf8');
      const ok = /^SUCCESS/i.test(text.trim());
      done({ attempted: true, ok, response: text.trim().slice(0, 200) });
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      done({ attempted: true, ok: false, reason: error.code ?? error.message });
    });
    socket.on('close', () => {
      clearTimeout(timer);
      done({ attempted: true, ok: false, reason: 'closed' });
    });
  });
}

/** Cheap liveness probe: does the management socket accept connections? */
export async function probeManagement({ socketPath, timeoutMs = 1500 }) {
  if (!socketPath) return { available: false, reason: 'not-configured' };
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => done({ available: false, reason: 'timeout' }), timeoutMs);
    socket.on('connect', () => {
      clearTimeout(timer);
      done({ available: true, reason: null });
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      done({ available: false, reason: error.code ?? error.message });
    });
  });
}
