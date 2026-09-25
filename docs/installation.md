# Installation

## Requirements

- A Linux host with root access (Debian/Ubuntu, Fedora/RHEL or Rocky/Alma —
  the vendored OpenVPN installer supports the common families)
- x86_64 or arm64
- Outbound HTTPS (to fetch the panel source and Easy-RSA on first install)
- A container engine with compose: **Docker** (`docker compose`) or
  **Podman** (`podman compose`)
- Ports: `1194/udp` for OpenVPN (default), `3000/tcp` for the panel on
  loopback only

## One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/Liwyd/vpnui/main/scripts/install.sh | sudo bash
```

Or from a checkout:

```bash
git clone https://github.com/Liwyd/vpnui.git && cd vpnui
sudo scripts/install.sh
```

### What the installer does

1. **OpenVPN provisioning (only if needed).** Detects an existing usable
   installation (`server.conf` + `crl-verify` + Easy-RSA `index.txt`) and
   reuses it untouched. Otherwise it runs the vendored, SHA-256-verified
   copy of [angristan/openvpn-install](https://github.com/angristan/openvpn-install)
   non-interactively: UDP/1194, `tls-crypt-v2`, no initial client (the panel
   manages clients), IP forwarding and NAT configured by the script.
2. **Copies the panel** to `/opt/vpnui` (override: `--install-dir`).
3. **Generates secrets** into `/opt/vpnui/.env` (mode 600):
   `JWT_SECRET=$(openssl rand -hex 32)` plus one-shot
   `ADMIN_USERNAME`/`ADMIN_PASSWORD`.
4. **Pulls the published image** (`liwyd/vpnui:latest` by default) from
   Docker Hub and starts it with `--no-build`. If the image cannot be pulled
   (not yet published, private repo, or registry unreachable) it **falls
   back to building locally** — see the build log for which path was used.
5. **Waits for `GET /health`**.
6. **Prints the initial admin credentials once**, then deletes the bootstrap
   variables from `.env`.
7. **Installs the CLI**: `/usr/local/bin/vpnui` and
   `/usr/local/lib/vpnui/{doctor,backup,restore}.sh`.

The installer is idempotent — re-running it is the upgrade path
(`vpnui update` pulls the newest registry image, or rebuilds, with a backup
first).

### Image source

| Situation | Result |
| --- | --- |
| Registry image pullable (default `liwyd/vpnui:latest`) | No build on the host — `IMAGE_NAME` written to `.env`, `compose up -d --no-build` |
| Pull fails | Local build from the copied source tree (works offline from the registry) |
| Custom registry/user | `sudo scripts/install.sh --image <user>/vpnui:<tag>` (or `VPNUI_IMAGE=...`) |

`vpnui update` follows the same rule: if `.env` has `IMAGE_NAME`, it runs
`compose pull` + `up -d --no-build`; otherwise it refreshes the source and
rebuilds.

### Installer options

```text
--non-interactive   Never prompt (automatic when stdin is not a TTY)
--admin-user NAME   Bootstrap admin username (default: admin)
--image NAME        Registry image (default: liwyd/vpnui:latest)
--skip-openvpn      Panel only; keep whatever OpenVPN installation exists
--skip-panel        Provision OpenVPN only
--install-dir DIR   Panel directory (default: /opt/vpnui)
```

## After install

```bash
vpnui doctor     # full-stack diagnostics with fix hints
vpnui status     # container + health
openvpn --version
```

Log in at `http://127.0.0.1:3000` with the printed credentials.

## Exposing the panel remotely (TLS reverse proxy)

The panel binds loopback (`127.0.0.1:3000` in `docker-compose.yml`) and
serves plain HTTP. For remote access, terminate TLS in front of it, e.g.
Caddy:

```
panel.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

or nginx (`proxy_pass http://127.0.0.1:3000;` + `proxy_set_header` basics).
Then change the publish rule to `127.0.0.1:3000:3000` **stays as-is** — the
proxy runs on the same host. Do not expose raw port 3000 to the internet.

## SELinux (Fedora/RHEL)

The compose file labels bind mounts with `:z` so the container may read the
PKI. If you add mounts of your own, keep the `:z` suffix (shared label) or
use `:Z` for private ones.

## Manual (no installer)

```bash
# 1. OpenVPN with angristan's script (or your own provisioning)
# 2. Panel files
sudo mkdir -p /opt/vpnui && sudo cp -a . /opt/vpnui/
# 3. Secrets
sudo cp /opt/vpnui/.env.example /opt/vpnui/.env
sudo sh -c 'echo "JWT_SECRET=$(openssl rand -hex 32)" >> /opt/vpnui/.env'
sudo chmod 600 /opt/vpnui/.env
# 4. Start
cd /opt/vpnui && sudo docker compose up -d --build
# 5. First admin user (CLI, runs inside the container — deps are baked in)
cd /opt/vpnui
sudo docker compose exec vpnui node backend/cli/users.js \
  create --username admin --password '<strong-password>' --role admin
```

## Uninstall

```bash
sudo vpnui uninstall            # panel only; keeps source and data
sudo vpnui uninstall --purge    # also deletes /opt/vpnui and /var/lib/vpnui
# OpenVPN itself:
sudo openvpn-install uninstall  # (vendored script also offers this)
```

## Troubleshooting

Run `vpnui doctor` first — every check prints a fix hint. See
[troubleshooting.md](troubleshooting.md) for common failures and the
clean-VPS validation checklist.
