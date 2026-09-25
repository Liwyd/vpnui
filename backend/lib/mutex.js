/**
 * Minimal async mutex used to serialize PKI mutations.
 *
 * Easy-RSA's index.txt / serial bookkeeping is not safe against concurrent
 * writers, and the OpenVPN status/ipp files are read-modify-write. All
 * mutating OpenVPN operations therefore go through a single process-wide
 * critical section.
 */
export class Mutex {
  constructor(name = 'mutex') {
    this.name = name;
    this._tail = Promise.resolve();
  }

  async run(fn) {
    const previous = this._tail;
    let release;
    this._tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
