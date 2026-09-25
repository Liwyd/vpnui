#!/usr/bin/env bash
#
# vpnui installer — OpenVPN (host) + vpnui panel (container).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Liwyd/vpnui/main/scripts/install.sh | sudo bash
#   sudo scripts/install.sh [--non-interactive] [--admin-user NAME] [--skip-openvpn]
#                           [--skip-panel] [--install-dir DIR] [--help] [--version]
#
# Idempotent: an existing valid OpenVPN installation is detected and reused;
# an existing panel installation is upgraded in place. Safe to re-run.
#
set -euo pipefail

VERSION="1.0.0"
INSTALL_DIR="${VPNUI_DIR:-/opt/vpnui}"
CLI_LINK="/usr/local/bin/vpnui"
LIB_DIR="/usr/local/lib/vpnui"
REPO_URL="https://github.com/Liwyd/vpnui.git"
# SHA-256 of scripts/vendor/openvpn-install.sh (see scripts/vendor/README.md)
OPENVPN_INSTALL_SHA256="f10e139ee7f7a52fc022208c1c9ac110093605bddbe7e3fa19897d1af0c77c51"
ADMIN_USERNAME="admin"
SKIP_OPENVPN=0
SKIP_PANEL=0
REQUESTED_IMAGE="${VPNUI_IMAGE:-liwyd/vpnui:latest}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
vpnui installer — OpenVPN (host) + vpnui panel (container)

Usage:
  sudo scripts/install.sh [options]
  curl -fsSL <raw install.sh url> | sudo bash

Options:
  --non-interactive   Never prompt (default when stdin is not a TTY)
  --admin-user NAME   Bootstrap admin username (default: admin)
  --image NAME        Registry image to use (default: liwyd/vpnui:latest;
                      falls back to a local build if it cannot be pulled)
  --skip-openvpn      Reuse whatever OpenVPN installation exists
  --skip-panel        Provision OpenVPN only
  --install-dir DIR   Panel directory (default: /opt/vpnui)
  -h, --help          Show this help
  --version           Show version
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --non-interactive) ;; # accepted for compatibility — the installer never prompts
  --image)
    REQUESTED_IMAGE="${2:-}"
    [[ -n "$REQUESTED_IMAGE" ]] || die "--image requires a name (e.g. liwyd/vpnui:latest)"
    shift
    ;;
  --admin-user)
    ADMIN_USERNAME="${2:-}"
    [[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9._-]{1,64}$ ]] ||
      die "--admin-user must match [A-Za-z0-9._-]{1,64}"
    shift
    ;;
  --skip-openvpn) SKIP_OPENVPN=1 ;;
  --skip-panel) SKIP_PANEL=1 ;;
  --install-dir)
    INSTALL_DIR="${2:-}"
    [[ -n "$INSTALL_DIR" ]] || die "--install-dir requires a path"
    shift
    ;;
  -h | --help) usage; exit 0 ;;
  --version) echo "vpnui installer $VERSION"; exit 0 ;;
  *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "this installer must run as root (try: sudo $0)"

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_NAME="${ID:-unknown}"
else
  OS_NAME="unknown"
fi
log "installing vpnui $VERSION on ${OS_NAME} ($(uname -m))"

command -v curl >/dev/null || die "curl is required"
command -v tar >/dev/null || die "tar is required"
command -v openssl >/dev/null || die "openssl is required"

# ---------------------------------------------------------------------------
# Acquire the panel source (local checkout when run from a repo, else clone)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd || echo '')"
SOURCE_DIR=""
CLEANUP_TMP=""
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../Dockerfile" ]]; then
  SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  log "using local source tree: $SOURCE_DIR"
else
  command -v git >/dev/null || die "git is required to download the panel source"
  log "downloading panel source from $REPO_URL"
  CLEANUP_TMP="$(mktemp -d)"
  git clone --depth 1 "$REPO_URL" "$CLEANUP_TMP/src" >/dev/null ||
    die "could not clone $REPO_URL"
  SOURCE_DIR="$CLEANUP_TMP/src"
fi

mkdir -p "$INSTALL_DIR"
log "installing panel files into $INSTALL_DIR"
for item in Dockerfile docker-compose.yml package.json package-lock.json backend public scripts .env.example README.md; do
  [[ -e "$SOURCE_DIR/$item" ]] || continue
  rm -rf "${INSTALL_DIR:?}/$item"
  cp -a "$SOURCE_DIR/$item" "$INSTALL_DIR/"
done
chmod +x "$INSTALL_DIR/scripts/"*.sh "$INSTALL_DIR/scripts/vpnui" 2>/dev/null || true
[[ -z "$CLEANUP_TMP" ]] || rm -rf "$CLEANUP_TMP"

# ---------------------------------------------------------------------------
# OpenVPN provisioning (vendored, SHA-256-pinned angristan/openvpn-install)
# ---------------------------------------------------------------------------
openvpn_usable() {
  local server_dir="${OPENVPN_SERVER_DIR:-/etc/openvpn/server}"
  [[ -f "$server_dir/server.conf" ]] || return 1
  grep -q '^ca ' "$server_dir/server.conf" || return 1
  grep -q '^crl-verify ' "$server_dir/server.conf" || return 1
  [[ -f "$server_dir/easy-rsa/pki/index.txt" ]] || return 1
  return 0
}

if [[ $SKIP_OPENVPN -eq 1 ]]; then
  warn "skipping OpenVPN provisioning (--skip-openvpn)"
elif openvpn_usable; then
  ok "existing OpenVPN installation detected — reusing it untouched"
else
  log "provisioning OpenVPN server (no usable installation found)"
  VENDORED="$INSTALL_DIR/scripts/vendor/openvpn-install.sh"
  [[ -f "$VENDORED" ]] || die "vendored openvpn-install.sh missing from $VENDORED"
  ACTUAL_SHA="$(sha256sum "$VENDORED" | awk '{print $1}')"
  [[ "$ACTUAL_SHA" == "$OPENVPN_INSTALL_SHA256" ]] ||
    die "vendored openvpn-install.sh checksum mismatch (expected $OPENVPN_INSTALL_SHA256, got $ACTUAL_SHA)"
  ok "vendored openvpn-install.sh checksum verified"

  # Non-interactive defaults: UDP/1194, tls-crypt-v2, no initial client
  # (the panel manages clients). IP forwarding/NAT handled by the script.
  bash "$VENDORED" install \
    --no-client \
    --tls-sig crypt-v2 \
    --port 1194 \
    --protocol udp \
    --log /var/log/vpnui-openvpn-install.log
  openvpn_usable || die "OpenVPN provisioning finished but the installation does not look usable"
  ok "OpenVPN server installed (tls-crypt-v2, udp/1194)"
fi

if [[ $SKIP_PANEL -eq 1 ]]; then
  ok "skipping panel installation (--skip-panel)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Container engine
# ---------------------------------------------------------------------------
COMPOSE=()
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v podman >/dev/null && podman compose version >/dev/null 2>&1; then
  COMPOSE=(podman compose)
else
  die "no container engine with compose found.
  fix (Debian/Ubuntu): apt-get install -y docker.io docker-compose-v2
       (Fedora):       dnf install -y docker podman-docker  (or docker-compose)
  then re-run this installer."
fi
ok "container engine: ${COMPOSE[*]}"

# ---------------------------------------------------------------------------
# Secrets + bootstrap credentials (generated, printed once)
# ---------------------------------------------------------------------------
ENV_FILE="$INSTALL_DIR/.env"
GENERATED_ADMIN_PASSWORD=""
if [[ ! -f "$ENV_FILE" ]]; then
  JWT_SECRET="$(openssl rand -hex 32)"
  GENERATED_ADMIN_PASSWORD="$(openssl rand -hex 9)"
  umask 077
  cat >"$ENV_FILE" <<EOF
# Generated by vpnui installer on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# JWT_SECRET signs session tokens — rotating it logs everyone out.
JWT_SECRET=$JWT_SECRET
# One-shot bootstrap credentials: consumed on the first successful start and
# then removed by the installer. Never set them again (use the panel/CLI).
ADMIN_USERNAME=$ADMIN_USERNAME
ADMIN_PASSWORD=$GENERATED_ADMIN_PASSWORD
EOF
  chmod 600 "$ENV_FILE"
  ok "generated $ENV_FILE (JWT secret + one-shot admin bootstrap)"
else
  ok "reusing existing $ENV_FILE"
fi

# ---------------------------------------------------------------------------
# Panel image: pull the published image from Docker Hub first; only build
# locally when the registry image is unavailable (not yet published, private
# repo, or no outbound registry access).
# ---------------------------------------------------------------------------
IMAGE_FROM_REGISTRY=0
log "starting the panel container"
if "${COMPOSE[0]}" pull "$REQUESTED_IMAGE" >/dev/null 2>&1; then
  IMAGE_FROM_REGISTRY=1
  ok "pulled $REQUESTED_IMAGE from Docker Hub"
else
  warn "could not pull $REQUESTED_IMAGE (not published yet, or registry unreachable)"
  warn "falling back to a local image build"
fi

# Keep compose in sync: IMAGE_NAME decides which image `up` uses
# (docker-compose.yml: image: ${IMAGE_NAME:-vpnui:local}).
if [[ $IMAGE_FROM_REGISTRY -eq 1 ]]; then
  if grep -q '^IMAGE_NAME=' "$ENV_FILE"; then
    sed -i "s|^IMAGE_NAME=.*|IMAGE_NAME=$REQUESTED_IMAGE|" "$ENV_FILE"
  else
    printf '\n# Registry image: vpnui update pulls this instead of building\nIMAGE_NAME=%s\n' \
      "$REQUESTED_IMAGE" >>"$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  log "starting from the registry image (no local build)"
  (cd "$INSTALL_DIR" && "${COMPOSE[@]}" up -d --no-build)
else
  if grep -q '^IMAGE_NAME=' "$ENV_FILE"; then
    sed -i '/^IMAGE_NAME=/d' "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
  log "building the image locally"
  (cd "$INSTALL_DIR" && "${COMPOSE[@]}" build && "${COMPOSE[@]}" up -d)
fi

log "waiting for the panel to become healthy"
HEALTHY=0
for _ in $(seq 1 60); do
  if curl -fsS -m 2 http://127.0.0.1:3000/health >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done
if [[ $HEALTHY -ne 1 ]]; then
  (cd "$INSTALL_DIR" && "${COMPOSE[@]}" logs --tail 40) || true
  die "panel did not become healthy within 60s (see logs above)"
fi
ok "panel healthy at http://127.0.0.1:3000/health"

# Strip one-shot bootstrap credentials from .env once the panel is up
# (the admin user now exists; the variables are no longer needed).
if grep -q '^ADMIN_PASSWORD=' "$ENV_FILE" 2>/dev/null; then
  sed -i '/^ADMIN_USERNAME=/d;/^ADMIN_PASSWORD=/d' "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "removed one-shot bootstrap credentials from .env"
fi

# ---------------------------------------------------------------------------
# CLI + helper scripts
# ---------------------------------------------------------------------------
log "installing vpnui CLI"
install -m 0755 "$INSTALL_DIR/scripts/vpnui" "$CLI_LINK"
mkdir -p "$LIB_DIR"
for s in doctor.sh backup.sh restore.sh; do
  install -m 0755 "$INSTALL_DIR/scripts/$s" "$LIB_DIR/$s"
done
ok "installed $CLI_LINK (try: vpnui doctor)"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "────────────────────────────  vpnui installed  ────────────────────────────"
echo " Panel:      http://127.0.0.1:3000  (put a TLS reverse proxy in front for remote access)"
echo " Install:    $INSTALL_DIR"
if [[ $IMAGE_FROM_REGISTRY -eq 1 ]]; then
  echo " Image:      $REQUESTED_IMAGE (pulled from Docker Hub)"
else
  echo " Image:      built locally (registry image unavailable at install time)"
fi
if [[ $SKIP_OPENVPN -eq 1 ]]; then
  OPENVPN_STATE="skipped"
elif openvpn_usable; then
  OPENVPN_STATE="existing installation reused"
else
  OPENVPN_STATE="freshly provisioned"
fi
echo " OpenVPN:    $OPENVPN_STATE"
if [[ -n "$GENERATED_ADMIN_PASSWORD" ]]; then
  echo
  echo " ┌──────────────────────────────────────────────────────────────────────┐"
  echo " │ Initial admin credentials — COPY THESE NOW, shown only once:        │"
  echo " │   username: $ADMIN_USERNAME"
  echo " │   password: $GENERATED_ADMIN_PASSWORD"
  echo " └──────────────────────────────────────────────────────────────────────┘"
fi
echo
echo " Next: vpnui doctor   ·   vpnui logs   ·   vpnui status"
echo "──────────────────────────────────────────────────────────────────────────"
