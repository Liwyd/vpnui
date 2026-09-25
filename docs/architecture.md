# Architecture

## Deployment topology (Architecture A)

OpenVPN runs **on the host** under systemd; the panel runs **in a container**
with the smallest useful set of mounts:

```text
┌────────────────────────── host ──────────────────────────┐
│ OpenVPN (systemd openvpn-server@server)                  │
│   /etc/openvpn/server/**   (server.conf, PKI, CRL, ipp)  │
│   tun device · NAT · IP forwarding                      │
│                                                          │
│   ┌────────────── rw bind ──────────────┐                │
│   ▼                                    ▼                │
│ ┌───────────────────────┐   ┌──────────────────────────┐ │
│ │ vpnui container       │   │ /var/lib/vpnui (rw bind) │ │
│ │  node + openvpn +     │   │  users.json · audit.log  │ │
│ │  openssl + easy-rsa   │   │  generated *.ovpn        │ │
│ │  scripts (mounted)    │   └──────────────────────────┘ │
│ └───────────────────────┘                                │
│        ▲ 127.0.0.1:3000 (reverse proxy terminates TLS)   │
└──────────────────────────────────────────────────────────┘
```

Rejected alternatives:

- **OpenVPN inside the container** — needs TUN, NAT, host networking and a
  systemd equivalent; more privilege for no upside. OpenVPN must survive
  panel container recreation.
- **Separate management service** — distributed-systems overhead for a
  single-host product.

### Container hardening

| Control | Value |
| --- | --- |
| capabilities | `cap_drop: ALL` |
| root filesystem | `read_only: true` + `tmpfs /tmp` |
| privilege escalation | `no-new-privileges` |
| `privileged: true` | **never** |
| writable mounts | `/etc/openvpn/server` (PKI), `/var/lib/vpnui` (panel state) |
| user | root (required to read `server.key` mode 0600; isolation comes from the controls above) |
| health | `GET /health` every 30 s |

Optional mounts for observability (see `docker-compose.yml`):
`/var/run/openvpn-server` (management socket → kick sessions on revoke) and
`/var/log/openvpn` (status file → live session view). Without them the panel
degrades gracefully (`managementAvailable: false`, `sessions.available: false`).

## Backend modules

```text
backend/
├── server.js                 entry point: config → services → HTTP → shutdown
├── app.js                    express assembly (helmet, compression, routes)
├── lib/
│   ├── config.js             env validation, layout discovery, fail-fast ConfigError
│   ├── errors.js             ApiError/ErrorCodes + envelope error handlers
│   ├── exec.js               execFile wrapper (arg arrays only, timeouts, no shell)
│   ├── mutex.js              promise chain lock (PKI serialization)
│   ├── logger.js             pino structured logs
│   └── validation.js         client/user name, password, role allowlists
├── middleware/
│   ├── auth.js               JWT verify (HS256 pinned), permission matrix
│   ├── rateLimit.js          login + global limiters
│   └── security.js           helmet + strict CSP
├── controllers/              request/response shaping only
├── services/openvpn/         all system interaction
│   ├── serverConfig.js       parse server.conf (tls mode, paths, mgmt socket)
│   ├── easyRSA.js            build/revoke/CRL commands inside withLock()
│   ├── pkiIndex.js           index.txt parser (valid/revoked/expired)
│   ├── clientConfig.js       .ovpn assembly + 0600 storage
│   ├── tlsCryptV2.js         per-client tls-crypt-v2 key generation
│   ├── crl.js · ipp.js       CRL install, ipp.txt cleanup
│   ├── mgmt.js               management-socket session kill
│   └── status.js             status file parser
├── store/                    users.json (atomic writes) + append-only audit log
└── cli/users.js              administrative user CLI
```

Principles:

- **No shell invocation anywhere.** Every external command runs through
  `execFile` with an argument array (`backend/lib/exec.js`); client names are
  additionally validated against `^[A-Za-z0-9_-]{1,64}$` before they reach
  the filesystem.
- **One lock for all PKI mutations.** `EasyRSAService.withLock()` serializes
  create/revoke/CRL so concurrent API calls cannot interleave Easy-RSA state.
- **Fail fast on configuration.** `loadConfig()` throws a `ConfigError` with a
  `vpnui doctor` hint before the server ever listens.
- **Absolute paths everywhere.** No `process.chdir`; every path is resolved
  once from validated configuration.

## Authentication and authorization

- JWT **HS256 pinned** (`algorithms: ['HS256']`) — HS512/`none` tokens are
  rejected; secret must be ≥32 characters.
- Passwords hashed with bcrypt cost 12; login failures return an identical
  `403 INVALID_CREDENTIALS` for unknown user vs wrong password.
- Login is rate limited per IP **and** per account; a global limiter covers
  the rest of the API.
- Roles: `admin` (everything), `operator` (clients + status), `user` (create
  + read clients), `readonly` (read only). Enforced in
  `middleware/auth.js#requirePermission`.
- One-shot bootstrap: `ADMIN_USERNAME`/`ADMIN_PASSWORD` are consumed only
  while `users.json` is empty, then the installer deletes them from `.env`.

## PKI flows

**Create** (inside the lock): index lookup → `easyrsa build-client-full`
(with `EASYRSA_PASSIN/OUT` for password clients) → assemble `.ovpn`
(template + CA + cert + key + `tls-crypt-v2` client block) → store 0600 →
audit.

**Revoke** (inside the lock): index lookup → `easyrsa revoke` →
`easyrsa gen-crl` → install CRL where `crl-verify` points → delete stored
profile → remove from `ipp.txt` → best-effort `kill <cn>` on the management
socket → audit.

**tls-crypt-v2 client key**: `openvpn --tls-crypt-v2 <serverKey> --genkey
tls-crypt-v2-client <tmp>` — output is spliced into the profile as
`<tls-crypt-v2>`, so every client gets a unique, revocable control-channel
key.

## Error envelope

```json
{ "success": false, "error": { "code": "CLIENT_ALREADY_EXISTS", "message": "…" } }
```

Success: `{ "success": true, "data": { … } }`. Stacks are attached only when
`NODE_ENV !== 'production'`.
