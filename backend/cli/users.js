#!/usr/bin/env node
/**
 * User management CLI.
 *
 *   node backend/cli/users.js list
 *   node backend/cli/users.js create --username alice --password '...' --role admin
 *   node backend/cli/users.js reset-password --username alice --password '...'
 *   node backend/cli/users.js delete --username alice
 *   node backend/cli/users.js            (interactive menu)
 *
 * Paths come from the same environment/configuration layer as the server.
 */
import readline from 'node:readline/promises';
import process from 'node:process';
import { loadConfig } from '../lib/config.js';
import { ConfigError, ApiError } from '../lib/errors.js';
import { UserStore } from '../store/users.js';
import { validateUsername, validatePassword, validateRole } from '../lib/validation.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function makeRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

async function ask(rl, question) {
  return (await rl.question(question)).trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'interactive';

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }

  const store = new UserStore({
    usersFile: config.usersFile,
    bcryptRounds: config.bcryptRounds,
    logger: null,
  });

  const rl = makeRl();
  try {
    switch (command) {
      case 'list': {
        const users = await store.list();
        if (users.length === 0) {
          process.stdout.write('No users configured.\n');
          return;
        }
        for (const u of users) {
          process.stdout.write(
            `${u.username}\trole=${u.role}\tcreated=${u.created ?? '-'}\tlastLogin=${u.lastLogin ?? '-'}\n`
          );
        }
        return;
      }
      case 'create': {
        const username = validateUsername(args.username ?? (await ask(rl, 'Username: ')));
        const password = validatePassword(args.password ?? (await ask(rl, 'Password: ')));
        const role = validateRole(args.role ?? (await ask(rl, `Role (${UserStore.roles.join('/')}): `)));
        await store.create({ username, password, role });
        process.stdout.write(`User "${username}" created with role "${role}".\n`);
        return;
      }
      case 'reset-password': {
        const username = validateUsername(args.username ?? (await ask(rl, 'Username: ')));
        const password = validatePassword(args.password ?? (await ask(rl, 'New password: ')));
        await store.update(username, { password });
        process.stdout.write(`Password for "${username}" reset.\n`);
        return;
      }
      case 'delete': {
        const username = validateUsername(args.username ?? (await ask(rl, 'Username to delete: ')));
        await store.remove(username);
        process.stdout.write(`User "${username}" deleted.\n`);
        return;
      }
      case 'interactive':
        return await runInteractive(store, rl);
      default:
        fail(`Unknown command "${command}". Use: list | create | reset-password | delete | interactive`);
    }
  } catch (error) {
    if (error instanceof ApiError) fail(error.message);
    fail(`Error: ${error.message}`);
  } finally {
    rl.close();
  }
}

async function runInteractive(store, rl) {
  for (;;) {
    const choice = await ask(
      rl,
      '\nUser Management\n1. List users\n2. Create user\n3. Delete user\n4. Reset password\n5. Exit\n\nSelect: '
    );
    if (choice === '5') return;
    try {
      if (choice === '1') {
        const users = await store.list();
        if (users.length === 0) process.stdout.write('No users configured.\n');
        for (const u of users) {
          process.stdout.write(
            `  ${u.username}\t${u.role}\tcreated=${u.created ?? '-'}\tlastLogin=${u.lastLogin ?? '-'}\n`
          );
        }
      } else if (choice === '2') {
        const username = validateUsername(await ask(rl, 'Username: '));
        const password = validatePassword(await ask(rl, 'Password: '));
        const role = validateRole(await ask(rl, `Role (${UserStore.roles.join('/')}): `));
        await store.create({ username, password, role });
        process.stdout.write(`User "${username}" created.\n`);
      } else if (choice === '3') {
        const username = validateUsername(await ask(rl, 'Username to delete: '));
        await store.remove(username);
        process.stdout.write(`User "${username}" deleted.\n`);
      } else if (choice === '4') {
        const username = validateUsername(await ask(rl, 'Username: '));
        const password = validatePassword(await ask(rl, 'New password: '));
        await store.update(username, { password });
        process.stdout.write(`Password for "${username}" reset.\n`);
      } else {
        process.stdout.write('Invalid option.\n');
      }
    } catch (error) {
      process.stdout.write(`${error.message}\n`);
    }
  }
}

main().catch((error) => fail(`Fatal: ${error.message}`));
