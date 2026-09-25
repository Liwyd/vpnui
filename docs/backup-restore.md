# Backup & restore

## What a backup contains

`vpnui backup` archives **everything needed to rebuild the service on a fresh
host**:

| Path | Contents |
| --- | --- |
| `/etc/openvpn/server/` | `server.conf`, CA, server cert/key, CRL, `ipp.txt`, tls-crypt-v2 key, the whole Easy-RSA PKI (`index.txt`, issued certs, private keys) |
| `/var/lib/vpnui/` | `users.json` (panel accounts), audit log, generated `.ovpn` profiles |
| `/opt/vpnui/.env` | `JWT_SECRET` and other configuration |

Not included (recreated automatically): container images, `node_modules`,
panel source, the vendored installer.

## Creating backups

```bash
sudo vpnui backup                    # → /var/backups/vpnui/vpnui-backup-<UTC ts>.tar.gz
sudo vpnui backup /mnt/backups       # custom destination
sudo vpnui backup --quiet            # archive path only (scripts)
```

The archive is mode `600`; the command prints its size and SHA-256.

**When to run:** automatically before every `vpnui update`, before every
restore, and on your own schedule (cron):

```cron
17 3 * * * root /usr/local/bin/vpnui backup --quiet /var/backups/vpnui
```

Copy archives off-host (they contain the CA private key — encrypt at rest).

> For a perfectly consistent snapshot stop the panel first
> (`vpnui stop`). In practice file-level snapshots taken while the panel is
> idle are safe: PKI mutations are short and serialized by an internal lock.

## Restoring

```bash
sudo vpnui restore /var/backups/vpnui/vpnui-backup-20260925-120000.tar.gz
```

The restore script:

1. validates the archive (`tar -tzf`),
2. takes a **safety backup of the current state** (aborting if that fails),
3. extracts to `/`, re-applies `600` on `.env` and `root:root 600` on
   `server.key`,
4. reloads/restarts the OpenVPN unit so a restored CRL takes effect,
5. recreates the panel container and waits for `GET /health`.

Restore refuses to continue if any of those steps fails — the previous state
remains recoverable from the safety backup.

## Recovering on a fresh host

```bash
# 1. Install the stack (provisioning is fine — we overwrite it)
curl -fsSL https://raw.githubusercontent.com/Liwyd/vpnui/main/scripts/install.sh | sudo bash
# 2. Stop, restore, verify
sudo vpnui stop
sudo vpnui restore /path/to/vpnui-backup-<ts>.tar.gz
sudo vpnui doctor
```

The restored `JWT_SECRET` keeps existing sessions valid and the restored
`users.json` keeps all panel accounts.

## What is NOT covered

- Host packages (openvpn, docker) — reinstall with your package manager
- Reverse-proxy certificates/configuration
- Firewall rules outside the OpenVPN installer's scope

`vpnui doctor` flags missing pieces after a rebuild.
