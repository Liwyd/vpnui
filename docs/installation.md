# Installation

## Requirements

- A Linux host with root access (Debian/Ubuntu, Fedora/RHEL or Rocky/Alma —
  the vendored OpenVPN installer supports the common families)
- x86_64 or arm64
- Outbound HTTPS (to fetch the panel source and Easy-RSA on first install)
- A container engine with compose: **Docker** (`docker compose`, daemon
  running) or **Podman** (`podman compose` — its API socket must be running:
  `systemctl --user start podman.socket`, the installer tries this for you)
- Ports: `1194/udp` for OpenVPN (default), and the panel port (`3000/tcp`
  by default — loopback or all interfaces, your choice)

## One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/Liwyd/vpnui/main/scripts/install.sh | sudo bash
```

Or from a checkout:

```bash
git clone https://github.com/Liwyd/vpnui.git && cd vpnui
sudo scripts/install.sh
```

**The installer is interactive when a terminal is attached** — prompts are
read from `/dev/tty`, so they also appear through `curl | sudo bash`. You
will be asked for:

1. **Panel access** — `direct` (listen on `0.0.0.0`, open the dashboard via
   `http://<server-ip>:<port>`) or `loopback` (listen on `127.0.0.1`, for a
   reverse proxy). Default: **direct**.
2. **Panel port** (default `3000`).
3. **Admin username and password** (leave the password empty to generate a
   strong one — printed once at the end).
4. **Registry image** (default `liwyd/vpnui:latest`).

Without a terminal (CI, automation) or with `--non-interactive`, all
defaults apply: loopback bind, port 3000, generated credentials. Every
choice can also be passed as a flag (see below), so scripted installs stay
fully deterministic.

### What the installer does

1. **OpenVPN provisioning (only if needed).** Detects an existing usable
   installation (`server.conf` + `crl-verify` + Easy-RSA `index.txt`) and
   reuses it untouched. Otherwise it runs the vendored, SHA-256-verified
   copy of [angristan/openvpn-install](https://github.com/angristan/openvpn-install)
   non-interactively: UDP/1194, `tls-crypt-v2`, no initial client (the panel
   manages clients), IP forwarding and NAT configured by the script.
2. **Copies the panel** to `/opt/vpnui` (override: `--install-dir`).
3. **Asks for the panel settings** (interactive) or applies flags/defaults;
   writes `VPNUI_BIND` and `PANEL_PORT` into `.env` so compose publishes the
   chosen address/port.
4. **Generates secrets** into `/opt/vpnui/.env` (mode 600):
   `JWT_SECRET=$(openssl rand -hex 32)` plus one-shot
   `ADMIN_USERNAME`/`ADMIN_PASSWORD`.
5. **Pulls the published image** (`liwyd/vpnui:latest` by default) from
   Docker Hub and starts it with `--no-build`. If the image cannot be pulled
   (not yet published, private repo, or registry unreachable) it **falls
   back to building locally** — see the build log for which path was used.
6. **Waits for `GET /health`** on the configured port.
7. **Prints the initial admin credentials once**, then deletes the bootstrap
   variables from `.env`.
8. **Installs the CLI**: `/usr/local/bin/vpnui` and
   `/usr/local/lib/vpnui/{doctor,backup,restore}.sh`.
9. **Prints the dashboard URL** — in direct mode that is
   `http://<server-ip>:<port>` (plus a firewall/TLS reminder), in loopback
   mode the loopback URL and the server IP for your reverse proxy.

The installer is idempotent — re-running it is the upgrade path
(`vpnui update` pulls the newest registry image, or rebuilds, with a backup
first). Re-running also never copies the install tree onto itself
(`vpnui install` executes the script from inside `/opt/vpnui`); if the
tree is incomplete, it is restored from the repository automatically.

### Image source

| Situation | Result |
| --- | --- |
| Registry image pullable (default `liwyd/vpnui:latest`) | No build on the host — `IMAGE_NAME` written to `.env`, `compose up -d --no-build` |
| Pull fails | Local build from the copied source tree (works offline from the registry) |
| Custom registry/user | `sudo scripts/install.sh --image <user>/vpnui:<tag>` (or `VPNUI_IMAGE=...`) |

`vpnui update` follows the same rule: if `.env` has `IMAGE_NAME`, it runs
`compose pull` + `up -d --no-build`; otherwise it refreshes the source and
rebuilds.

### Updates (`vpnui update`)

Updates are designed to always complete, never lose data, and never leave
old images behind:

1. **Pre-update backup** (`vpnui backup` — PKI, panel data, `.env`).
2. **New code**: pull the registry image (or rebuild from source).
3. **Restart + health check** (45 s). Panel data lives in bind mounts and is
   never touched — no `down -v`, no volume removal.
4. **On failure: automatic rollback.** The previous image is retagged,
   started again and health-checked; the command exits non-zero with a clear
   message and the backup path.
5. **On success: the old image is pruned** (removed if nothing else uses
   it), so disk usage does not grow with each update.

### Installer options

```text
--non-interactive   Never prompt (no TTY, CI, automation)
--bind ADDR         direct (=0.0.0.0), loopback (=127.0.0.1) or an IPv4 addr
--port N            Panel port (default: 3000)
--admin-user NAME   Bootstrap admin username (default: admin)
--image NAME        Registry image (default: liwyd/vpnui:latest)
--skip-openvpn      Panel only; keep whatever OpenVPN installation exists
--skip-panel        Provision OpenVPN only
--install-dir DIR   Panel directory (default: /opt/vpnui)
```

`VPNUI_ADMIN_PASSWORD` pre-sets the bootstrap password without putting it
on the command line.

## After install

```bash
vpnui doctor     # full-stack diagnostics with fix hints
vpnui status     # container + health
vpnui user list  # panel accounts
openvpn --version
```

Manage panel accounts with `vpnui user add <name> [--role admin] [--password …]`,
`vpnui user list`, `vpnui user reset <name>` and `vpnui user delete <name>` —
without `--password` the container prompts interactively (roles: `admin`,
`operator`, `user`, `readonly`).

Log in at the URL printed by the installer — `http://<server-ip>:3000` in
direct mode, `http://127.0.0.1:3000` in loopback mode — with the printed
credentials.

## Direct access vs reverse proxy

- **Direct** (`--bind direct`, the interactive default): the panel listens on
  `0.0.0.0:<port>` and the installer prints `http://<server-ip>:<port>`.
  Open the port in your firewall (e.g. `ufw allow 3000/tcp`). Traffic is
  plain HTTP — put a TLS reverse proxy in front before exposing it to the
  internet (basic auth over HTTP is sniffable).
- **Loopback** (`--bind loopback`, the non-interactive default): the panel
  listens on `127.0.0.1:<port>` only. Remote access requires a reverse
  proxy on the same host.

Both are stored in `.env` as `VPNUI_BIND` / `PANEL_PORT`; changing them and
running `vpnui restart` re-publishes the port.

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
sudo vpnui uninstall            # stop container, remove CLI/scripts; keeps
                                # source, data, backups and images
sudo vpnui uninstall --purge    # complete removal: container, images,
                                # /opt/vpnui, /var/lib/vpnui, CLI, scripts
sudo vpnui uninstall --purge --delete-backups   # also /var/backups/vpnui
# OpenVPN itself (never touched by vpnui uninstall):
sudo openvpn-install uninstall  # (vendored script also offers this)
```

Both modes print a **verification table** (`✓/✗`) afterwards and exit
non-zero if anything that should be gone is still present — so you always
know the removal actually completed. OpenVPN is left untouched unless you
remove it explicitly.

## Troubleshooting

Run `vpnui doctor` first — every check prints a fix hint. See
[troubleshooting.md](troubleshooting.md) for common failures and the
clean-VPS validation checklist.
