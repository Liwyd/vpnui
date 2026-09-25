# VPNUI — Technical Audit

Date: 2026-09-25
Scope: full repository audit of `Liwyd/vpnui` plus design-reference audit of `Liwyd/mit-panel`, and compatibility analysis against the modern `angristan/openvpn-install` OpenVPN layout.

Severity classification: **CRITICAL** / **HIGH** / **MEDIUM** / **LOW**.

---

## 1. Current architecture

| Layer | State |
|---|---|
| Backend | Single 343-line `server.js` (Express 4, CommonJS). Auth, user store, Easy-RSA shell-outs, `.ovpn` generation and CRL handling all live inline in HTTP routes. |
| Frontend | Static `public/index.html` + `public/js/main.js`. Tailwind 2 and Font Awesome loaded from CDNs. No build step, no framework. |
| State | `users.json` (committed to git), `.env` (committed to git), PKI assumed at legacy paths. |
| OpenVPN integration | Raw `child_process.exec` shell strings, `process.chdir()`, keyword-regex error detection, legacy filesystem layout assumptions. |
| Ops | No Docker, no lockfile (lockfile gitignored), no tests (`npm test` exits 1), no lint, no CI, no installer, no health endpoint, no graceful shutdown, no logging strategy. |
| Git | 3 commits; dead file `server copy.js` present. |

---

## 2. Findings

### CRITICAL

**C1 — Command injection in `DELETE /api/clients/:clientName`** (`server.js:277`, `server.js:292`)

- `req.params.clientName` is never validated before being interpolated into shell strings:
  `exec(\`./easyrsa --batch revoke "${clientName}"\`)` and `exec(\`sed -i "/^${clientName},.*/d" ${ippPath}\`)`.
- Encoded quotes / `$(...)` / `;` in the URL parameter achieve arbitrary command execution as root.
- The create route validates names; the delete route does not.

**C2 — Hardcoded default admin password in source** (`server.js:49`)

- A real password literal is committed to a public repository and used to bootstrap the default `admin` account.
- Combined with C1 this is a realistic path to root command execution.

**C3 — Predictable JWT fallback secret** (`server.js:15`)

- `JWT_SECRET || 'your-secret-key-change-this'`: a deployment that forgets `.env` silently accepts forgeable tokens → complete authentication bypass.

**C4 — tls-crypt-v2 unsupported; config generation broken** (`server.js:216`)

- `serverConfig.includes('tls-crypt')` substring-matches `tls-crypt-v2`, then reads `/etc/openvpn/tls-crypt.key`, which does not exist on a modern install → HTTP 500 on every config generation.
- No per-client tls-crypt-v2 key is ever generated; the correct mechanism
  (`openvpn --tls-crypt-v2 <server.key> --genkey tls-crypt-v2-client <file>`) is absent entirely.

**C5 — Legacy filesystem layout assumptions** (`server.js:19-27`)

- Defaults target `/etc/openvpn/easy-rsa`, `/etc/openvpn/server.conf`, `/etc/openvpn/client-template.txt`.
- The modern layout (confirmed against current `angristan/openvpn-install` master, which produces exactly the layout described in the requirements) is:

  ```text
  /etc/openvpn/server/
  ├── server.conf
  ├── client-template.txt
  ├── crl.pem
  ├── ipp.txt
  ├── ca.crt / ca.key
  ├── server_<random>.crt / .key
  ├── tls-crypt-v2.key
  └── easy-rsa/pki/{ca.crt,index.txt,issued/,private/,reqs/}
  ```

- On a clean modern VPS the application is dead on arrival without manual `.env` surgery.

### HIGH

**H1 — `process.chdir()` global mutation + relative `USERS_FILE`** (`server.js:253`, `server.js:276`, `.env`)

- Global cwd changes race across concurrent requests.
- `USERS_FILE=users.json` is relative, so after the first client operation `loadUsers()` resolves under the Easy-RSA directory and can silently bootstrap a default admin there.

**H2 — Password-protected client creation is broken** (`server.js:255-257`)

- `easyrsa --batch build-client-full <name>` without `nopass` / `EASYRSA_PASSIN` prompts interactively → hangs or fails in a server context.

**H3 — No role authorization on client CRUD**

- Only `authenticateToken` is applied. The `readonly` role can create and revoke certificates. Role checks exist only on user creation.

**H4 — No login rate limiting; user-enumeration timing**

- Unlimited online brute force; unknown-user path skips `bcrypt.compare` (timing difference).

**H5 — Advertised API does not exist**

- Frontend calls `GET /api/users`, `GET /api/users/me`, `PUT /api/users/:username`, `DELETE /api/users/:username`, `POST /api/users/:username/reset-password`. None are implemented. Admin UI can never activate. README documents them regardless.

**H6 — Stored XSS in admin UI** (`public/js/main.js:244-262`)

- `user.username` injected into `innerHTML` unescaped; usernames are unvalidated (`users.js` accepts arbitrary strings).

**H7 — `.ovpn` written to `/root` with default umask** (`server.js:16`)

- Client private keys become world-readable; `/root` assumption breaks under containers/non-root.

**H8 — No dependency lockfile committed** (`.gitignore` contains `/package-lock.json`)

- Non-reproducible installs; Docker builds drift.

**H9 — No Docker, CI, or tests**

- Nothing gates a broken release; `npm test` explicitly fails.

**H10 — Fragile `index.txt` parsing** (`server.js:187-189`)

- Only `V` lines parsed → revoked/expired clients invisible.
- `split('=')[1]` truncates CNs containing `=`.
- Consequence: duplicate checks and existence checks are wrong (revoked-name reuse, false positives).

**H11 — Fragile PEM extraction** (`server.js:211`)

- `cert.split('Certificate:')[1]` produces a corrupt `<cert>` block when header text differs.

**H12 — Secrets committed to git history**

- `.env` and `users.json` (real bcrypt hashes) are tracked. Rotation required; history cleanup optional.

### MEDIUM

**M1 — Error detection by keyword regex** (`server.js:149-163`) — matches output words (`bad`, `invalid`, `error`): a client named `bad-ass` falsely fails; process exit codes are ignored. `exec` has no timeout and no `maxBuffer` cap → a hung Easy-RSA wedges requests indefinitely.

**M2 — `loadUsers` read-modify-write without locking** — concurrent writes corrupt `users.json`.

**M3 — No structured logging, no operation audit trail** — who revoked what, when, is unrecorded.

**M4 — No security headers** — no helmet/CSP; CDN-loaded Tailwind/Font Awesome make a strict CSP impossible and add supply-chain exposure.

**M5 — JWT expiry hardcoded to `5d`**, ignoring the documented `JWT_EXPIRES_IN`; no algorithm pinning.

**M6 — CRL installed to the wrong path on modern layouts** — revocation writes `/etc/openvpn/crl.pem` while modern `server.conf` references `/etc/openvpn/server/crl.pem` → **revoked clients keep connecting**.

**M7 — No active-session awareness, no revocation disconnect** (management socket unused).

**M8 — Catch-all route** (`server.js:337`) returns `index.html` for unknown API paths instead of JSON 404.

**M9 — No operation timeouts anywhere**; no request body limits made explicit.

### LOW

- No pagination on client listing (unbounded response).
- README wrong: clone URL, endpoints, roles, project structure.
- Dead file `server copy.js`.
- bcrypt cost 10 (acceptable, bump to 12).
- No password policy on user creation.
- No versioning strategy or `/health` endpoint.
- `express.json()` limits implicit (default 100 KB).

---

## 3. OpenVPN compatibility problems

1. Layout: legacy paths assumed (C5).
2. tls-crypt-v2: not supported at all (C4).
3. CRL target path wrong for modern `server.conf` (M6).
4. `index.txt` state machine incomplete — no revoked/expired handling (H10).
5. Server certificate name assumed; real name is `server_<random>` (requirements §5).
6. `usePassword` client flow broken (H2).
7. No version/feature detection for tls-crypt-v2 availability.
8. No `peer-fingerprint` (auth-mode `fingerprint`) handling, which the modern installer can also produce.

## 4. Installation problems

- No installer exists. README instructs: run foreign script, `npm install`, edit `.env`, `sudo node server.js`.
- No OS/Docker/OpenVPN/ports detection, no idempotency, no backups, no diagnostics, no CLI, no doctor.

## 5. Docker problems

- Nothing containerizable today: `process.chdir`, `/root` writes, root-owned PKI paths, no lockfile, no health endpoint, no signal handling, no healthcheck.

## 6. Frontend problems

- Redesign deferred by explicit decision (see IMPLEMENTATION_PLAN.md).
- Remaining in-scope: stored-XSS fix (H6), endpoints the current UI already expects (H5), removal of hardcoded password (C2).
- Design reference (`mit-panel`) audited: React+Vite+TS+Tailwind, shadcn-style components, HSL CSS-variable theme (coral light / near-black dark), `nx-surface` raised cards, `rounded-card: 1.75rem`, 900-weight tight headings, Yekan/Vazirmatn fonts, fixed sidebar + `PageLayout`, lucide icons, theme toggle, responsive drawer. Frontend redesign will port this language in a later phase.

## 7. Dependency problems

- `package-lock.json` gitignored (H8).
- No lint configuration; no test framework.
- Tailwind/Font Awesome via CDN (M4).
- `server copy.js` dead code.

## 8. Migration risks

| Risk | Mitigation |
|---|---|
| Existing deployments use legacy paths | Explicit env config first, validated defaults second, safe discovery third; error messages show expected paths. |
| `users.json` already exists | Keep format; atomic write + serialized writes; no forced migration. |
| Secrets in git history | Rotate on upgrade (documented); `.env`/`users.json` untracked going forward. |
| Existing clients in PKI | PkiIndex parser reads existing `index.txt`; no PKI rewrite required. |
| Old `.ovpn` files in `/root` | Documented; new files go to app data dir; old location not deleted automatically. |
| angristan script variance | Vendored copy pinned + SHA-256 verified; detection prefers any existing install. |
