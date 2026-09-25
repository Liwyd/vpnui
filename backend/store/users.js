/**
 * User store: JSON file with atomic writes and serialized mutations.
 *
 * Sufficient for a single-process panel managing a handful of operator
 * accounts. SQLite would add a native dependency without a concrete need;
 * see docs/architecture.md for the escalation path.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcrypt';
import { Mutex } from '../lib/mutex.js';
import { ApiError, ErrorCodes } from '../lib/errors.js';

const ROLES = Object.freeze(['admin', 'operator', 'user', 'readonly']);

function nowIso() {
  return new Date().toISOString();
}

export class UserStore {
  constructor({ usersFile, bcryptRounds = 12, logger }) {
    this.usersFile = usersFile;
    this.bcryptRounds = bcryptRounds;
    this.logger = logger;
    this._mutex = new Mutex('users-store');
  }

  static get roles() {
    return ROLES;
  }

  async _read() {
    let raw;
    try {
      raw = await fs.readFile(this.usersFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { users: [], metadata: {} };
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.users)) {
        throw new Error('invalid structure');
      }
      return { users: parsed.users, metadata: parsed.metadata ?? {} };
    } catch (error) {
      throw new ApiError(
        500,
        ErrorCodes.INTERNAL,
        `User store ${this.usersFile} is corrupt (${error.message}). Restore it from backup (see docs/backup-restore.md).`
      );
    }
  }

  async _write(data) {
    data.metadata = { ...(data.metadata ?? {}), lastUpdated: nowIso() };
    const dir = path.dirname(this.usersFile);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(this.usersFile)}.${process.pid}.tmp`);
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.usersFile);
  }

  async isEmpty() {
    const { users } = await this._read();
    return users.length === 0;
  }

  async list() {
    const { users } = await this._read();
    return users.map((u) => ({
      username: u.username,
      role: u.role,
      created: u.created ?? null,
      lastLogin: u.lastLogin ?? null,
    }));
  }

  async find(username) {
    const { users } = await this._read();
    return users.find((u) => u.username === username) ?? null;
  }

  async create({ username, password, role }) {
    return this._mutex.run(async () => {
      const data = await this._read();
      if (data.users.some((u) => u.username === username)) {
        throw new ApiError(409, ErrorCodes.CONFLICT, `User "${username}" already exists.`);
      }
      const passwordHash = await bcrypt.hash(password, this.bcryptRounds);
      data.users.push({
        username,
        password: passwordHash,
        role,
        created: nowIso(),
        lastLogin: null,
      });
      await this._write(data);
      return { username, role };
    });
  }

  async update(username, { role, password }) {
    return this._mutex.run(async () => {
      const data = await this._read();
      const user = data.users.find((u) => u.username === username);
      if (!user) {
        throw new ApiError(404, ErrorCodes.NOT_FOUND, `User "${username}" not found.`);
      }
      if (role !== undefined) user.role = role;
      if (password !== undefined) user.password = await bcrypt.hash(password, this.bcryptRounds);
      await this._write(data);
      return { username, role: user.role };
    });
  }

  async remove(username) {
    return this._mutex.run(async () => {
      const data = await this._read();
      const before = data.users.length;
      data.users = data.users.filter((u) => u.username !== username);
      if (data.users.length === before) {
        throw new ApiError(404, ErrorCodes.NOT_FOUND, `User "${username}" not found.`);
      }
      if (data.users.length === 0) {
        throw new ApiError(
          409,
          ErrorCodes.CONFLICT,
          'Refusing to remove the last remaining user.'
        );
      }
      await this._write(data);
      return { username };
    });
  }

  async markLogin(username) {
    try {
      await this._mutex.run(async () => {
        const data = await this._read();
        const user = data.users.find((u) => u.username === username);
        if (!user) return;
        user.lastLogin = nowIso();
        await this._write(data);
      });
    } catch (error) {
      this.logger?.warn({ err: error }, 'failed to record last login');
    }
  }

  async verify(username, password) {
    const user = await this.find(username);
    if (!user) {
      // Constant-ish work for unknown users to blunt username timing oracles.
      await bcrypt.compare(password, DUMMY_HASH);
      return null;
    }
    const match = await bcrypt.compare(password, user.password);
    return match ? user : null;
  }

  async ensureAdmin({ username, password }) {
    return this._mutex.run(async () => {
      const data = await this._read();
      if (data.users.length > 0) return false;
      const passwordHash = await bcrypt.hash(password, this.bcryptRounds);
      data.users.push({
        username,
        password: passwordHash,
        role: 'admin',
        created: nowIso(),
        lastLogin: null,
        bootstrap: true,
      });
      await this._write(data);
      return true;
    });
  }
}

// Precomputed bcrypt hash used only as timing equalization for unknown users.
const DUMMY_HASH = bcrypt.hashSync('vpnui-timing-equalizer-not-a-password', 10);
