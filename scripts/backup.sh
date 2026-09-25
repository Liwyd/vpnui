#!/usr/bin/env bash
#
# vpnui backup — archive the complete VPN state:
#   OpenVPN PKI + configuration, panel data (users/audit/profiles) and .env.
#
# Usage: vpnui backup [--quiet] [DEST_DIR]     (default: /var/backups/vpnui)
#
set -euo pipefail

INSTALL_DIR="${VPNUI_DIR:-/opt/vpnui}"
SERVER_DIR="${OPENVPN_SERVER_DIR:-/etc/openvpn/server}"
DATA_DIR_HOST="${VPNUI_DATA_DIR:-/var/lib/vpnui}"
DEST_DIR="${VPNUI_BACKUP_DIR:-/var/backups/vpnui}"
QUIET=0

die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
log() { [[ $QUIET -eq 1 ]] || printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { [[ $QUIET -eq 1 ]] || printf '\033[1;32m✓\033[0m %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
  --quiet | -q) QUIET=1 ;;
  -h | --help)
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  -*) die "unknown option: $1" ;;
  *) DEST_DIR="$1" ;;
  esac
  shift
done

[[ $EUID -eq 0 ]] || die "backup must run as root (try: sudo vpnui backup)"
[[ -d "$SERVER_DIR" || -f "$INSTALL_DIR/.env" || -d "$DATA_DIR_HOST" ]] ||
  die "nothing to back up — no $SERVER_DIR, $INSTALL_DIR/.env or $DATA_DIR_HOST found"

mkdir -p "$DEST_DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE="$DEST_DIR/vpnui-backup-$STAMP.tar.gz"

LIST_FILE="$(mktemp)"
trap 'rm -f "$LIST_FILE"' EXIT

if [[ -d "$SERVER_DIR" ]]; then
  echo "$SERVER_DIR" >>"$LIST_FILE"
fi
if [[ -d "$DATA_DIR_HOST" ]]; then
  echo "$DATA_DIR_HOST" >>"$LIST_FILE"
fi
if [[ -f "$INSTALL_DIR/.env" ]]; then
  echo "$INSTALL_DIR/.env" >>"$LIST_FILE"
fi

log "creating backup archive"
tar --ignore-failed-read \
  --exclude="$INSTALL_DIR/.git" \
  --exclude='node_modules' \
  -czf "$ARCHIVE" -T "$LIST_FILE"

chmod 600 "$ARCHIVE"
SIZE="$(du -h "$ARCHIVE" | cut -f1)"
SUM="$(sha256sum "$ARCHIVE" | awk '{print $1}')"

ok "backup written: $ARCHIVE ($SIZE)"
log "sha256: $SUM"
if [[ $QUIET -eq 0 ]]; then
  log "contents:"
  tar -tzf "$ARCHIVE" | sed 's/^/    /' | head -40
fi
echo "$ARCHIVE"
