/**
 * Safe external process execution.
 *
 * Never uses a shell: every command is an executable plus an argument array,
 * so user-controlled values can never be interpreted as shell syntax.
 */
import { execFile } from 'node:child_process';

export class CommandError extends Error {
  constructor({ file, args, code, signal, stdout, stderr, timedOut }) {
    const rendered = `${file} ${args.join(' ')}`;
    super(
      timedOut
        ? `Command timed out: ${rendered}`
        : `Command failed (exit ${code ?? signal ?? '?'}): ${rendered}`
    );
    this.name = 'CommandError';
    this.file = file;
    this.args = args;
    this.code = code ?? null;
    this.signal = signal ?? null;
    this.stdout = stdout ?? '';
    this.stderr = stderr ?? '';
    this.timedOut = Boolean(timedOut);
  }
}

const TRUNCATE_AT = 8 * 1024;

function clip(text) {
  if (!text) return '';
  return text.length > TRUNCATE_AT ? `${text.slice(0, TRUNCATE_AT)}…[truncated]` : text;
}

/**
 * Run a command and resolve with { stdout, stderr } on exit code 0.
 * Rejects with CommandError on non-zero exit or timeout.
 */
export function run(file, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 120_000,
    maxBuffer = 4 * 1024 * 1024,
    input,
  } = options;

  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd,
        env,
        timeout: timeoutMs,
        maxBuffer,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          return resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
        }
        const timedOut = error.killed && error.signal === 'SIGTERM' && error.code === null;
        reject(
          new CommandError({
            file,
            args,
            code: typeof error.code === 'number' ? error.code : null,
            signal: error.signal ?? null,
            stdout: clip(stdout),
            stderr: clip(stderr),
            timedOut,
          })
        );
      }
    );

    if (input !== undefined) {
      child.stdin.end(input);
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}
