# VPNUI — Implementation Plan

Status: executing.
Companion document: [AUDIT.md](./AUDIT.md).

---

## 1. Goals

Turn the audited codebase into a production-oriented OpenVPN management panel:

1. Correct modern OpenVPN support (layout, tls-crypt-v2, CRL, revocation, `.ovpn`).
2. Secure-by-default backend (no injection, no default secrets, real authz, rate limits).
3. Reproducible Docker image + compose deployment.
4. Idempotent installer with `vpnui` CLI and `vpnui doctor` diagnostics.
5. GitHub Actions CI + Docker Hub publishing.
6. Automated tests (unit, integration, API).
7. Backup/restore, upgrade safety, documentation.

**Explicitly deferred:** frontend redesign (mit-panel visual language). Scope exception: minimal frontend security fixes and the API endpoints the current UI already calls.

## 2. Architecture decisions

### 2.1 Deployment topology — Architecture A (host OpenVPN, containerized panel)

```text
┌──────────────────────── host ────────────────────────┐
│ OpenVPN (systemd openvpn-server@server)              │
│   /etc/openvpn/server/**  (PKI, conf, crl, ipp)      │
│   tun device, NAT, IP forwarding                     │
│            ▲ rw bind (only this dir)                 │
│ ┌──────────┴──────────┐   ┌───────────────────────┐  │
│ │ vpnui container     │   │ volumes               │  │
│ │  node + openvpn +   │   │ /var/lib/vpnui (data) │  │
│ │  openssl binaries   │   └───────────────────────┘  │
│ └─────────────────────┘                              │
└──────────────────────────────────────────────────────┘
```

Rejected alternatives:

- **B (OpenVPN in container):** needs TUN, NAT, host networking, systemd-equivalent inside the container — more privilege, no upside. OpenVPN must survive panel container recreation.
- **C (separate management service):** distributed-systems overhead for a single-host product.

Container hardening: `cap_drop: ALL`, read-only rootfs + `tmpfs /tmp`, `no-new-privileges`, no `privileged: true`, rw bind limited to `/etc/openvpn/server`, app data volume for users/audit/generated configs, optional ro mounts for OpenVPN status file and management socket.

**Documented root requirement:** the panel container runs as root because the PKI it must manage is root-owned on the host; least privilege is achieved by narrowing the mounted filesystem surface and dropping all capabilities, not by a container user that would force `chmod`/`chown` of CA material. Documented in `docs/architecture.md`.

### 2.2 Backend

- Node 22 + Express (kept; restructured, not rewritten): `routes → controllers → services/openvpn → lib`.
- All process execution via `execFile` argument arrays — **no shell interpolation anywhere**.
- One async mutex serializes PKI mutations (Easy-RSA `index.txt` is not concurrency-safe).
- Errors: `execFile` exit-code based, with timeouts and output caps.
- Config: fail-fast env validation at startup; no dangerous defaults (`JWT_SECRET` required).
- API envelope: `{ success, data }` / `{ success:false, error:{ code, message } }`.
- Storage: JSON users file with atomic write (tmp + rename) + serialized writes; append-only JSONL audit log. SQLite deferred — not justified at this scale.

### 2.3 OpenVPN service layer

| Module | Responsibility |
|---|---|
| `paths.js` | Resolve server dir/conf/easy-rsa from explicit env → validated defaults → actionable error. |
| `serverConfig.js` | Parse `server.conf`: port, proto, endpoint hints, TLS mode, CRL path, status path, server cert name, auth mode (`pki` / `fingerprint`). |
| `easyRSA.js` | `build-client-full` (with `EASYRSA_PASSIN/OUT` for password clients), `revoke-issued`/`revoke`, `gen-crl`; mutex; availability/version checks. |
| `pkiIndex.js` | Tab-aware `index.txt` parser → `{ name, status: valid\|revoked\|expired, expiresAt, revokedAt, serial }`; cross-check `pki/issued|private`. |
| `tlsCryptV2.js` | Per-client key: `openvpn --tls-crypt-v2 <server.key> --genkey tls-crypt-v2-client <tmp>` (temp file inside server dir — Ubuntu 25.04+ AppArmor rejects `/tmp`); feature detection with clear failure. |
| `clientConfig.js` | Build `.ovpn`: template + `<ca>`/`<cert>`/`<key>` + correct TLS block (`tls-crypt-v2` / `tls-crypt` / `tls-auth` / `peer-fingerprint`); PEM extracted by BEGIN/END markers. |
| `crl.js` | Regenerate CRL, install to path referenced by `server.conf`, verify perms, reload signal if required (CRL is re-read per connection — no restart needed). |
| `status.js` | Optional parse of OpenVPN status file for active sessions; graceful degradation when not mounted. |
| `clients.js` | Orchestration: create, revoke, list, config download — with strict name allowlist `[a-zA-Z0-9_-]{1,64}`. |

### 2.4 Security strategy

- JWT: `HS256` pinned, `JWT_SECRET` required (fail fast), configurable expiry (default 12 h).
- Passwords: bcrypt cost 12; dummy-hash compare for unknown users; min length policy.
- Rate limiting: login (per IP + per user), plus a global API limiter.
- Authorization: role middleware (`admin` / `operator` / `readonly`) on every mutation.
- Headers: helmet + CSP (self-hosted assets only).
- Input validation on every route; strict allowlists; no raw user input into paths or processes.
- Audit log for create/revoke/auth failures/user management.
- Secrets: `.env` gitignored; installer generates `JWT_SECRET` and admin password (`openssl rand`), password printed once.

### 2.5 Docker

- Multi-stage: builder (npm ci, backend syntax check, frontend build step prepared) → slim runtime with `openvpn` + `openssl` + `ca-certificates`.
- `HEALTHCHECK` → `GET /health` (unauthenticated, cheap).
- SIGTERM/SIGINT graceful shutdown.
- Pin base images by digest-verified tags; lockfile committed for reproducible `npm ci`.

### 2.6 Installer / CLI

- `scripts/install.sh` — entry point (`curl | sudo bash` compatible, `--non-interactive`, `--help`, `--version`).
- **OpenVPN provisioning: vendored, SHA-256-pinned copy of `angristan/openvpn-install`** (supports non-interactive install, `--tls-sig crypt-v2`, pki/fingerprint auth modes) invoked only when no usable installation exists; an existing valid installation is detected and reused, never destroyed. Backups taken before any modification.
- `scripts/vpnui` → `/usr/local/bin/vpnui`: `install | start | stop | restart | status | update | uninstall | doctor | logs`.
- `scripts/doctor.sh` — `✓ OK / ⚠ WARNING / ✗ ERROR` checks: OS, arch, Docker, compose, OpenVPN version, easy-rsa, server.conf, client template, PKI, CA, server cert/key, CRL, tls-crypt-v2 server key, IP forwarding, firewall, services, container, mounts, permissions, env, `/health`, image version — each failure with a fix hint.
- `scripts/backup.sh` / `scripts/restore.sh` — CA/PKI/conf/CRL/tls-crypt-v2/app data.
- Update path: validate → backup → pull image → restart → health check → report (rollback notes on failure).

### 2.7 CI/CD

- `.github/workflows/ci.yml` — PR + push to main: `npm ci` → lint → unit/integration/API tests (installs `openvpn` + `easy-rsa` on the runner for real crypto tests) → frontend build check → Docker build (no push).
- `.github/workflows/docker.yml` — validate job (build) → publish job (main + `v*` tags only): `docker/login-action` with `secrets.DOCKERHUB_USERNAME`/`secrets.DOCKERHUB_TOKEN`, `metadata-action` tags: `latest` (default branch), `main`, `vX.Y.Z`, `<sha>`. PRs never publish.

### 2.8 Testing

- Unit: name validation, `index.txt` parsing, `server.conf` parsing, `.ovpn` assembly, env validation, auth middleware.
- Integration: temp-PKI fixtures (never host PKI): client build, tls-crypt-v2 generation (real `openvpn`), revoke, CRL regeneration/install. Skips with explicit reason if binaries unavailable.
- API: login, unauthorized access, role enforcement, create/duplicate/invalid names, revoke, config download, rate limiting.
- Lint: ESLint (backend + frontend).

### 2.9 Documentation

`README.md` rewrite + `docs/architecture.md`, `docs/installation.md`, `docs/openvpn.md`, `docs/backup-restore.md`, `docs/troubleshooting.md`.

## 3. Execution order

1. `docs: audit + implementation plan`
2. `refactor: backend core` — structure, env validation, logger, error envelope, `/health`, shutdown, exec helper
3. `feat: modern openvpn service layer`
4. `fix: support tls-crypt-v2 client generation` (+ CRL path, PEM extraction, password clients)
5. `refactor: harden authentication and API` (+ user endpoints, helmet/CSP, rate limits, validation)
6. `test: add unit, integration and API tests`
7. `feat: add production docker image`
8. `feat: add vpnui installer, CLI and doctor diagnostics`
9. `ci: add lint/test pipeline and docker hub publishing`
10. `fix: frontend security fixes and API compatibility`
11. `feat: add backup, restore and safe update scripts`
12. `docs: rewrite deployment documentation`
13. `test: end-to-end validation` (local + CI; clean-VPS checklist for operator)

## 4. Validation plan

- **Local:** OpenVPN 2.7.7 + Node 22 — full unit/integration/API suites against temp PKIs including real tls-crypt-v2 generation; Docker image build.
- **CI:** Ubuntu runner installs `openvpn` + `easy-rsa`; runs all suites and builds the image.
- **Clean VPS:** scripted `vpnui doctor`-driven checklist executed by the operator (documented in `docs/troubleshooting.md`); not claimed as executed here.

## 5. Versioning

Semantic versioning; `package.json` version is the source of truth; git tag `vX.Y.Z` triggers versioned image publish; release process documented in README.
