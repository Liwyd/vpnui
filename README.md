# vpnui

A production-oriented web panel for managing an OpenVPN server: issue and
revoke client certificates, download `.ovpn` profiles, manage panel users and
audit everything — with a strict, self-hosted frontend and a hardened
container deployment.

[![CI](https://github.com/Liwyd/vpnui/actions/workflows/ci.yml/badge.svg)](https://github.com/Liwyd/vpnui/actions/workflows/ci.yml)

## Highlights

- **Modern OpenVPN support** — `tls-crypt-v2` (unique per-client control
  channel keys), `tls-crypt`, `tls-auth`; PKI and CRL handled through the
  host's Easy-RSA installation, serialized behind a process lock.
- **Security-first panel** — JWT (HS256, pinned), bcrypt(12) password
  hashing, role-based permissions (`admin` / `operator` / `user` /
  `readonly`), rate-limited login, structured error envelope, full audit log,
  strict CSP with zero third-party assets or inline code.
- **Hardened deployment** — OpenVPN runs on the host; the panel runs in a
  container with `cap_drop: ALL`, read-only rootfs, `no-new-privileges` and
  exactly two writable mounts (`/etc/openvpn/server`, `/var/lib/vpnui`).
- **Idempotent installer + CLI** — `scripts/install.sh` provisions OpenVPN
  (pinned, SHA-256-verified vendored copy of
  [angristan/openvpn-install](https://github.com/angristan/openvpn-install))
  only when needed, reuses existing installations untouched, generates a
  strong `JWT_SECRET`, prints the initial admin password **once**, and
  installs the `vpnui` CLI.
- **Diagnostics, backup, update** — `vpnui doctor` (✓/⚠/✗ with fix hints),
  `vpnui backup` / `vpnui restore`, `vpnui update` (backup → rebuild →
  health check).

## Quick start

```bash
git clone https://github.com/Liwyd/vpnui.git
cd vpnui
sudo scripts/install.sh
```

Or straight from the repo (no clone needed):

```bash
curl -fsSL https://raw.githubusercontent.com/Liwyd/vpnui/main/scripts/install.sh | sudo bash
```

The installer prints the initial admin credentials **once** — copy them
immediately. Then:

```bash
vpnui doctor    # verify the whole stack, with fix hints
vpnui status    # container + health
vpnui logs      # follow panel logs
```

Open `http://127.0.0.1:3000` (put a TLS reverse proxy in front for remote
access — the panel deliberately serves plain HTTP on loopback by default).

## CLI

| Command | Description |
| --- | --- |
| `vpnui install` | (Re)run the idempotent installer |
| `vpnui start` / `stop` / `restart` / `status` | Container lifecycle |
| `vpnui logs` | Follow panel logs |
| `vpnui update` | Backup → update source → rebuild → restart → health check |
| `vpnui backup [DIR]` | Archive PKI + panel data + `.env` |
| `vpnui restore <archive>` | Restore a backup (safety backup first) |
| `vpnui doctor` | Diagnostics with ✓/⚠/✗ and fix hints |
| `vpnui uninstall [--purge]` | Remove the panel (OpenVPN untouched unless purged) |

## Architecture (short version)

```text
host
├── OpenVPN (systemd)  →  /etc/openvpn/server/**   (PKI, conf, CRL, ipp)
│                          tun device, NAT, IP forwarding
└── vpnui container    →  mounts: /etc/openvpn/server (rw),
                          /var/lib/vpnui (rw: users, audit, profiles)
                          cap_drop ALL · read-only rootfs · no-new-privileges
```

Details: [docs/architecture.md](docs/architecture.md).

## Development

```bash
npm ci
npm run lint        # ESLint (backend + frontend)
npm test            # unit + API + real-PKI integration tests
npm start           # run against your local OpenVPN layout (env-driven)
```

Tests create throwaway PKI fixtures in temp directories — they **never** touch
the host's `/etc/openvpn`. Integration tests download a pinned Easy-RSA 3.2.6
tarball (sha256-verified) when `easy-rsa` is not installed, and skip with a
clear reason when the toolchain is unavailable.

## API

All responses use the envelope `{ "success": bool, "data" | "error" }`;
errors carry `{ code, message }` (and a stack only outside production).

| Method & path | Permission | Purpose |
| --- | --- | --- |
| `POST /api/login` | public (rate-limited) | Get a JWT |
| `GET /api/users/me` | authenticated | Token identity |
| `GET /api/status` | `status:read` | Server/panel status payload |
| `GET /api/clients` | `clients:read` | List clients + counts |
| `POST /api/clients` | `clients:create` | Issue a certificate (+ optional key password) |
| `GET /api/clients/:name/config?download=1` | `clients:read` | `.ovpn` profile (or JSON) |
| `DELETE /api/clients/:name` | `clients:revoke` | Revoke + regenerate/install CRL + kick session |
| `GET /api/users` | `users:manage` | List panel users |
| `POST /api/users` | `users:manage` | Create user |
| `PUT /api/users/:name` | `users:manage` | Change role |
| `POST /api/users/:name/reset-password` | `users:manage` | Reset password |
| `DELETE /api/users/:name` | `users:manage` | Delete user |
| `GET /health` | public | Health for orchestrators/installers |

### Roles

| Capability | admin | operator | user | readonly |
| --- | :-: | :-: | :-: | :-: |
| list clients / download configs | ✓ | ✓ | ✓ | ✓ |
| create clients | ✓ | ✓ | ✓ | — |
| revoke clients | ✓ | ✓ | — | — |
| manage panel users | ✓ | — | — | — |
| view status | ✓ | ✓ | ✓ | ✓ |

## Configuration

Environment variables (see [.env.example](.env.example) — the installer
generates a real `.env` under `/opt/vpnui`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | **required** (≥32 chars) | Signs session tokens (`openssl rand -hex 32`) |
| `PORT` | `3000` | Panel port |
| `OPENVPN_SERVER_DIR` | `/etc/openvpn/server` | OpenVPN server directory |
| `EASY_RSA_DIR` | `<serverDir>/easy-rsa` | Easy-RSA directory |
| `SERVER_CONF` / `CLIENT_TEMPLATE` / `INDEX_FILE` | layout-derived | Individual path overrides |
| `DATA_DIR` | `/var/lib/vpnui` (container) | Users, audit log, generated profiles |
| `LOG_LEVEL` | `info` | `fatal…trace` / `silent` |
| `NODE_ENV` | — | `production` hides stacks, enables prod defaults |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | unset | One-shot bootstrap, consumed on first start |

## Backup & restore

```bash
sudo vpnui backup              # → /var/backups/vpnui/vpnui-backup-<ts>.tar.gz
sudo vpnui restore /var/backups/vpnui/vpnui-backup-<ts>.tar.gz
```

Backs up the complete VPN state: CA/PKI, server config, CRL, tls-crypt-v2
key, panel data and `.env`. Details: [docs/backup-restore.md](docs/backup-restore.md).

## Documentation

- [docs/installation.md](docs/installation.md) — installer, manual setup, reverse proxy, SELinux
- [docs/architecture.md](docs/architecture.md) — topology, modules, auth, PKI flows
- [docs/openvpn.md](docs/openvpn.md) — layouts, tls-crypt-v2, CRL, status/mgmt mounts
- [docs/backup-restore.md](docs/backup-restore.md) — backup strategy and recovery
- [docs/troubleshooting.md](docs/troubleshooting.md) — `vpnui doctor`, common failures, clean-VPS checklist

## Releases

Semantic versioning; `package.json` is the source of truth. Tagging `vX.Y.Z`
publishes `X.Y.Z` (+ `latest` on the default branch) to Docker Hub as
`<DOCKERHUB_USERNAME>/vpnui` via `.github/workflows/docker.yml`.

## Acknowledgements

OpenVPN provisioning is performed by a pinned, SHA-256-verified copy of
[angristan/openvpn-install](https://github.com/angristan/openvpn-install)
(vendored in `scripts/vendor/`). Not affiliated with or endorsed by that
project.

## License

MIT — see [LICENSE](LICENSE).
