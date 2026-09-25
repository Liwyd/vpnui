#!/usr/bin/env bash
#
# vpnui restore — restore a vpnui backup archive (PKI + panel data + .env).
#
# Usage: vpnui restore <archive.tar.gz>
#
# A safety backup of the current state is taken first. The panel container is
# restarted afterwards; the OpenVPN service is reloaded so a restored CRL
# takes effect immediately.
#
set -euo pipefail

INSTALL_DIR="${VPNUI_DIR:-/opt/vpnui}"
LIB_DIR="${VPNUI_LIB:-/usr/local/lib/vpnui}"
SERVER_DIR="${OPENVPN_SERVER_DIR:-/etc/openvpn/server}"

die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
-h | --help | '')
  usage
  [[ -z "${1:-}" ]] && exit 1 || exit 0
  ;;
esac

ARCHIVE="$1"
[[ $EUID -eq 0 ]] || die "restore must run as root (try: sudo vpnui restore <archive>)"
[[ -f "$ARCHIVE" ]] || die "archive not found: $ARCHIVE"

log "validating archive"
tar -tzf "$ARCHIVE" >/dev/null || die "not a readable tar.gz archive: $ARCHIVE"
tar -tzf "$ARCHIVE" | grep -q . || die "archive is empty: $ARCHIVE"
ok "archive is valid"

if [[ -f "$LIB_DIR/backup.sh" || -f "$(dirname "$0")/backup.sh" ]]; then
  log "taking a pre-restore safety backup of the current state"
  BACKUP_SCRIPT="$LIB_DIR/backup.sh"
  [[ -f "$BACKUP_SCRIPT" ]] || BACKUP_SCRIPT="$(dirname "$0")/backup.sh"
  bash "$BACKUP_SCRIPT" --quiet >/dev/null || die "safety backup failed — aborting restore"
  ok "safety backup created in /var/backups/vpnui/"
fi

log "restoring files"
tar -xzf "$ARCHIVE" -C /

# Permissions that matter
if [[ -f "$INSTALL_DIR/.env" ]]; then
  chmod 600 "$INSTALL_DIR/.env"
fi
if [[ -f "$SERVER_DIR/server.key" ]]; then
  chown root:root "$SERVER_DIR/server.key" 2>/dev/null || true
  chmod 600 "$SERVER_DIR/server.key" 2>/dev/null || true
fi
ok "files restored"

# Reload OpenVPN so a restored CRL/config takes effect (best effort).
if command -v systemctl >/dev/null 2>&1; then
  for unit in openvpn-server@server.service openvpn@server.service; do
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      log "reloading $unit"
      systemctl reload "$unit" 2>/dev/null || systemctl restart "$unit" 2>/dev/null || true
      break
    fi
  done
fi

# Restart the panel (compose project lives next to the restored .env).
if [[ -f "$INSTALL_DIR/docker-compose.yml" ]]; then
  log "restarting panel"
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    (cd "$INSTALL_DIR" && docker compose up -d --force-recreate)
  elif command -v podman >/dev/null && podman compose version >/dev/null 2>&1; then
    (cd "$INSTALL_DIR" && podman compose up -d --force-recreate)
  else
    die "compose not available to restart the panel"
  fi

  log "health check"
  for _ in $(seq 1 45); do
    if curl -fsS -m 2 http://127.0.0.1:3000/health >/dev/null 2>&1; then
      ok "restore complete — panel healthy"
      exit 0
    fi
    sleep 1
  done
  die "restore finished but the panel is not healthy — run: vpnui logs"
fi

ok "restore complete (panel not installed — start it with: sudo scripts/install.sh)"
