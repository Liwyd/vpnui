# Troubleshooting

## Start here: `vpnui doctor`

```bash
sudo vpnui doctor
```

Every check prints `✓ OK`, `⚠ WARNING` or `✗ ERROR` **with a fix hint**.
Exit code `1` means at least one `✗`. Checks cover: OS/arch, container
engine, OpenVPN version and `tls-crypt-v2` support, `server.conf`
directives, client template, PKI (`index.txt`, CA, server cert/key, CRL,
tls-crypt-v2 key, easy-rsa), IP forwarding, NAT, the systemd unit, the
container and its mounts, `.env` (JWT strength, permissions, leftover
bootstrap credentials) and the live `/health` endpoint.

Run it without root for a partial report; with `sudo` for the full one.

## Common failures

### `vpnui status` → health: not responding

```bash
vpnui logs                 # application-level cause
vpnui status
cd /opt/vpnui && docker compose ps
```

Typical causes: `JWT_SECRET` missing/short (fix in `.env`, then
`vpnui restart`), wrong `OPENVPN_SERVER_DIR` (fail-fast at startup — the log
says exactly which file is missing), or a port clash on 3000.

### `Cannot create data directory /var/lib/vpnui/...: EACCES`

SELinux: add the `:z` suffix to the bind mounts in `docker-compose.yml`
(already present) and relabel:

```bash
sudo restorecon -Rv /var/lib/vpnui /etc/openvpn/server
```

Permission: `/var/lib/vpnui` must be writable by root (the container runs as
root): `sudo chown root:root /var/lib/vpnui && sudo chmod 755 /var/lib/vpnui`.

### Login always fails with 403 INVALID_CREDENTIALS

- Lost the printed password? Reset it:
  `sudo node /opt/vpnui/backend/cli/users.js reset-password --username <name> --password '...'`
- `users.json` restored from an older backup than you think?

### JWT errors / everyone logged out after an upgrade

Rotating or truncating `JWT_SECRET` invalidates all tokens — expected.
Keep `/opt/vpnui/.env` across upgrades (the installer never overwrites an
existing `.env`).

### Client creation fails: "tls-crypt-v2" / `openvpn --genkey`

The container needs an `openvpn` binary ≥ 2.5 (baked into the image) and the
server needs `/etc/openvpn/server/tls-crypt-v2.key`. Recreate the server key:

```bash
sudo openvpn --genkey tls-crypt-v2-server /etc/openvpn/server/tls-crypt-v2.key
sudo systemctl restart openvpn-server@server
```

### Revoked client still connects

OpenVPN reads the CRL from `crl-verify` — confirm the panel installed it and
reload:

```bash
sudo openssl crl -in /etc/openvpn/server/crl.pem -noout -text | head
sudo systemctl reload openvpn-server@server
```

### `easy-rsa: not found`

The PKI directory must live inside (or next to) the server dir. Either
re-run the installer or point `EASY_RSA_DIR` at your existing Easy-RSA
checkout in `.env`, then `vpnui restart`.

### Page loads unstyled / scripts blocked

The CSP allows only same-origin assets; the CSS is vendored at
`public/vendor/tailwind.min.css`. If you front the panel with a proxy,
ensure it does not strip headers and that it forwards `/vendor/*`.

### No container engine

```bash
# Debian/Ubuntu
sudo apt-get install -y docker.io docker-compose-v2
# Fedora
sudo dnf install -y docker docker-compose
```

## Clean-VPS validation checklist

Run on a **fresh VPS** after `git clone` + `sudo scripts/install.sh`.
Each step must print the shown result before moving on.

1. **Install completes** — installer prints `✓ panel healthy` and the
   one-time admin credentials (copy them now).
2. `sudo vpnui doctor` → **0 errors** (warnings about nonessential items are
   acceptable only if you intentionally skipped them).
3. `sudo vpnui status` → container `running`, health JSON `status: ok`.
4. Log in at `http://<vps>:3000` (or your proxy) → dashboard shows
   `admin (admin)`.
5. **Issue a client**: *Add New Client* → name `test1` → profile modal opens
   containing `<tls-crypt-v2>` and `remote <endpoint> <port>`.
6. `sudo tar -xOf /opt/vpnui/… ` (or check via API) — verify the profile
   downloads as `test1.ovpn` (`?download=1`).
7. **Connect a real device** with the profile → `sudo vpnui doctor` still
   green; in the OpenVPN status file (if mounted) the session appears.
8. **Revoke `test1`** → row shows `revoked`; the device is disconnected
   within the kill/reload window.
9. `sudo openssl crl -in /etc/openvpn/server/crl.pem -noout -text` → shows
   the revocation.
10. **Second client with key password**: `test2` + password → profile starts
    with `-----BEGIN ENCRYPTED PRIVATE KEY-----`; importing prompts for the
    password.
11. **User management**: create `operator1` (role operator) → log in in a
    private window → can manage clients, cannot see *User Management*.
12. **Rate limiting**: 6 wrong logins in a row → `429 RATE_LIMITED` response.
13. `sudo vpnui backup` → archive listed with SHA-256.
14. `sudo vpnui stop && sudo vpnui restore <archive>` → health returns to
    `ok`, admin login still works.
15. `sudo vpnui update` → pre-update backup created, container rebuilt,
    health `ok`.
16. `sudo reboot` → after boot: `sudo vpnui status` healthy,
    `systemctl is-active openvpn-server@server` → `active`,
    `sudo vpnui doctor` → 0 errors.

Record the output of step 2 and 16 — they are the two artefacts worth keeping
with the deployment.
