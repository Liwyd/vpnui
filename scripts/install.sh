#!/usr/bin/env bash
#
# vpnui installer — OpenVPN (host) + vpnui panel (container).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Liwyd/vpnui/main/scripts/install.sh | sudo bash
#   sudo scripts/install.sh [--non-interactive] [--bind ADDR] [--port N]
#                           [--admin-user NAME] [--image NAME] [--skip-openvpn]
#                           [--skip-panel] [--install-dir DIR] [--help] [--version]
#
# Interactive when a terminal is attached (prompts are read from /dev/tty, so
# `curl | sudo bash` asks questions too); fully non-interactive in CI or with
# --non-interactive. Idempotent: an existing valid OpenVPN installation is
# detected and reused; an existing panel installation is upgraded in place.
#
set -euo pipefail

VERSION="1.1.0"
INSTALL_DIR="${VPNUI_DIR:-/opt/vpnui}"
CLI_LINK="${VPNUI_CLI_LINK:-/usr/local/bin/vpnui}"
LIB_DIR="${VPNUI_LIB:-/usr/local/lib/vpnui}"
REPO_URL="https://github.com/Liwyd/vpnui.git"
# SHA-256 of scripts/vendor/openvpn-install.sh (see scripts/vendor/README.md)
OPENVPN_INSTALL_SHA256="f10e139ee7f7a52fc022208c1c9ac110093605bddbe7e3fa19897d1af0c77c51"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD_ENV="${VPNUI_ADMIN_PASSWORD:-}"
SKIP_OPENVPN=0
SKIP_PANEL=0
NON_INTERACTIVE=0
REQUESTED_IMAGE="${VPNUI_IMAGE:-liwyd/vpnui:latest}"
BIND_CHOICE=""
PORT_CHOICE=""

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
vpnui installer — OpenVPN (host) + vpnui panel (container)

Usage:
  sudo scripts/install.sh [options]
  curl -fsSL <raw install.sh url> | sudo bash      (prompts when a TTY is attached)

Options:
  --non-interactive   Never prompt (defaults: loopback bind, port 3000)
  --bind ADDR         Panel listen address: direct (=0.0.0.0), loopback
                      (=127.0.0.1) or an explicit IPv4 address
  --port N            Panel port (default: 3000)
  --admin-user NAME   Bootstrap admin username (default: admin)
  --image NAME        Registry image to use (default: liwyd/vpnui:latest;
                      falls back to a local build if it cannot be pulled)
  --skip-openvpn      Reuse whatever OpenVPN installation exists
  --skip-panel        Provision OpenVPN only
  --install-dir DIR   Panel directory (default: /opt/vpnui)
  -h, --help          Show this help
  --version           Show version

Environment:
  VPNUI_ADMIN_PASSWORD  Pre-set the bootstrap admin password (skips prompting)
  VPNUI_IMAGE           Same as --image
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --non-interactive) NON_INTERACTIVE=1 ;;
  --bind)
    BIND_CHOICE="${2:-}"
    [[ -n "$BIND_CHOICE" ]] || die "--bind requires an address (direct|loopback|IPv4)"
    shift
    ;;
  --port)
    PORT_CHOICE="${2:-}"
    [[ "$PORT_CHOICE" =~ ^[0-9]{1,5}$ ]] || die "--port must be a number (1-65535)"
    ((10#$PORT_CHOICE >= 1 && 10#$PORT_CHOICE <= 65535)) || die "--port out of range: $PORT_CHOICE"
    shift
    ;;
  --image)
    REQUESTED_IMAGE="${2:-}"
    [[ -n "$REQUESTED_IMAGE" ]] || die "--image requires a name (e.g. liwyd/vpnui:latest)"
    [[ "$REQUESTED_IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] ||
      die "--image contains unsupported characters: $REQUESTED_IMAGE"
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
# Interactive capability: prompts are read from /dev/tty (not stdin), so they
# also work when the script itself arrives over stdin (`curl | sudo bash`).
# ---------------------------------------------------------------------------
INTERACTIVE=0
if [[ $NON_INTERACTIVE -eq 0 && -t 1 && -r /dev/tty && -w /dev/tty ]]; then
  INTERACTIVE=1
fi

ask() { # ask VAR "label" "default" [secret]
  local var="$1" label="$2" def="$3" secret="${4:-}" reply=""
  if [[ $INTERACTIVE -eq 0 ]]; then
    printf -v "$var" '%s' "$def"
    return 0
  fi
  if [[ -n "$secret" ]]; then
    printf '%s [%s]: ' "$label" "$def" >/dev/tty
    IFS= read -r -s reply </dev/tty || reply=""
    printf '\n' >/dev/tty
  else
    printf '%s [%s]: ' "$label" "$def" >/dev/tty
    IFS= read -r reply </dev/tty || reply=""
  fi
  reply="${reply#"${reply%%[![:space:]]*}"}"
  reply="${reply%"${reply##*[![:space:]]}"}"
  printf -v "$var" '%s' "${reply:-$def}"
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  # Test hook: allow unprivileged runs only for explicitly custom install dirs.
  if [[ -n "${VPNUI_ALLOW_NONROOT:-}" && "$INSTALL_DIR" != "/opt/vpnui" ]]; then
    warn "running unprivileged (VPNUI_ALLOW_NONROOT) into $INSTALL_DIR"
  else
    die "this installer must run as root (try: sudo $0)"
  fi
fi

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
# Small .env helpers
# ---------------------------------------------------------------------------
env_get() { # env_get FILE KEY -> value (empty when absent)
  grep "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true
}

env_set() { # env_set FILE KEY VALUE  (safe for simple values only)
  if grep -q "^$2=" "$1" 2>/dev/null; then
    sed -i "s|^$2=.*|$2=$3|" "$1"
  else
    printf '%s=%s\n' "$2" "$3" >>"$1"
  fi
}

detect_public_ip() {
  local ip=""
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -4 -fsS -m 4 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && { printf '%s' "$ip"; return 0; }
  done
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && { printf '%s' "$ip"; return 0; }
  return 1
}

normalize_bind() { # direct|loopback|IPv4 -> IPv4 (fails on anything else)
  case "$1" in
  direct | all | 0.0.0.0) printf '0.0.0.0' ;;
  loopback | local | localhost) printf '127.0.0.1' ;;
  *)
    [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
    printf '%s' "$1"
    ;;
  esac
}

qualify_image_ref() { # add docker.io/ when the ref has no registry host
  local ref="$1" first="${1%%/*}"
  if [[ "$ref" != */* ]]; then
    printf 'docker.io/library/%s' "$ref"
  elif [[ "$first" == *.* || "$first" == *:* || "$first" == "localhost" ]]; then
    printf '%s' "$ref"
  else
    printf 'docker.io/%s' "$ref"
  fi
}

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
# Container engine (must be installed AND running)
# ---------------------------------------------------------------------------
COMPOSE=()
ENGINE_HINT=""
podman_socket_ok() {
  local sock
  sock="$(podman info --format '{{.Host.RemoteSocket.Path}}' 2>/dev/null || true)"
  [[ -n "$sock" && -S "$sock" ]]
}
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1 &&
  docker info >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v podman >/dev/null && podman compose version >/dev/null 2>&1 &&
  podman info >/dev/null 2>&1; then
  if podman_socket_ok; then
    COMPOSE=(podman compose)
  else
    log "starting the podman API socket (required by compose)"
    if [[ $EUID -eq 0 ]]; then
      systemctl start podman.socket >/dev/null 2>&1 || true
    else
      systemctl --user start podman.socket >/dev/null 2>&1 || true
    fi
    sleep 1
    if podman_socket_ok; then
      COMPOSE=(podman compose)
      ok "podman API socket started"
    else
      ENGINE_HINT="podman's API socket is not running — start it with:
         systemctl --user start podman.socket   (rootful: sudo systemctl start podman.socket)"
    fi
  fi
fi
[[ ${#COMPOSE[@]} -gt 0 ]] || die "no running container engine with compose found.
  fix (Debian/Ubuntu): apt-get install -y docker.io docker-compose-v2 && systemctl enable --now docker
       (Fedora):       dnf install -y docker && systemctl enable --now docker   (or podman)
  ${ENGINE_HINT:+
  $ENGINE_HINT}
  then re-run this installer."
ok "container engine: ${COMPOSE[*]}"

# ---------------------------------------------------------------------------
# Panel settings (interactive prompts, flag overrides, .env defaults)
# ---------------------------------------------------------------------------
ENV_FILE="$INSTALL_DIR/.env"
FRESH_ENV=0
[[ -f "$ENV_FILE" ]] || FRESH_ENV=1

CUR_BIND="$(env_get "$ENV_FILE" VPNUI_BIND)"
CUR_PORT="$(env_get "$ENV_FILE" PANEL_PORT)"
CUR_IMAGE="$(env_get "$ENV_FILE" IMAGE_NAME)"
[[ "$CUR_PORT" =~ ^[0-9]{1,5}$ ]] || CUR_PORT="3000"

# 1) listen address
BIND_DEF="$CUR_BIND"
[[ -n "$BIND_DEF" ]] || BIND_DEF="127.0.0.1"
BIND_RAW="$BIND_CHOICE"
if [[ -z "$BIND_RAW" ]]; then
  if [[ $INTERACTIVE -eq 1 ]]; then
    BIND_DEF_LABEL="loopback"
    [[ "$BIND_DEF" == "0.0.0.0" ]] && BIND_DEF_LABEL="direct"
    ask BIND_RAW "Panel access — direct (open via server IP) or loopback (reverse proxy)?" "$BIND_DEF_LABEL"
  else
    BIND_RAW="$BIND_DEF"
  fi
fi
BIND_ADDR="$(normalize_bind "$BIND_RAW")" ||
  die "invalid bind address: $BIND_RAW (use direct, loopback or an IPv4 address)"

# 2) port
PANEL_PORT="$PORT_CHOICE"
if [[ -z "$PANEL_PORT" ]]; then
  if [[ $INTERACTIVE -eq 1 ]]; then
    ask PANEL_PORT "Panel port" "$CUR_PORT"
  else
    PANEL_PORT="$CUR_PORT"
  fi
fi
[[ "$PANEL_PORT" =~ ^[0-9]{1,5}$ ]] || die "port must be a number: $PANEL_PORT"
((10#$PANEL_PORT >= 1 && 10#$PANEL_PORT <= 65535)) || die "port out of range: $PANEL_PORT"

# 3) bootstrap admin (fresh installs only — existing panels keep their users)
ADMIN_PASSWORD="$ADMIN_PASSWORD_ENV"
if [[ $FRESH_ENV -eq 1 ]]; then
  if [[ $INTERACTIVE -eq 1 ]]; then
    ask ADMIN_USERNAME "Admin username" "$ADMIN_USERNAME"
    [[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9._-]{1,64}$ ]] ||
      die "admin username must match [A-Za-z0-9._-]{1,64}"
    ask ADMIN_PASSWORD "Admin password (empty = generate a strong one)" "$ADMIN_PASSWORD" secret
  fi
  [[ -n "$ADMIN_PASSWORD" ]] || ADMIN_PASSWORD="$(openssl rand -hex 9)"
fi

# 4) image (fresh installs, or existing registry installs; pure-build installs
#    keep their mode and are not prompted)
if [[ $FRESH_ENV -eq 1 || -n "$CUR_IMAGE" ]]; then
  IMAGE_DEF="$REQUESTED_IMAGE"
  [[ -n "$CUR_IMAGE" ]] && IMAGE_DEF="$CUR_IMAGE"
  if [[ $INTERACTIVE -eq 1 ]]; then
    ask REQUESTED_IMAGE "Registry image" "$IMAGE_DEF"
  else
    REQUESTED_IMAGE="$IMAGE_DEF"
  fi
  [[ "$REQUESTED_IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] ||
    die "invalid image name: $REQUESTED_IMAGE"
fi
# Unqualified names (liwyd/vpnui) must be registry-qualified — podman refuses
# short-name resolution without a TTY, which breaks `curl | bash` installs.
REQUESTED_IMAGE="$(qualify_image_ref "$REQUESTED_IMAGE")"

if [[ "$BIND_ADDR" == "0.0.0.0" ]]; then
  warn "panel will listen on ALL interfaces (0.0.0.0:$PANEL_PORT) over plain HTTP"
  warn "put a TLS reverse proxy in front before exposing this to the internet"
fi

# ---------------------------------------------------------------------------
# Secrets + bootstrap credentials (generated, printed once)
# ---------------------------------------------------------------------------
GENERATED_ADMIN_PASSWORD=""
if [[ $FRESH_ENV -eq 1 ]]; then
  JWT_SECRET="$(openssl rand -hex 32)"
  GENERATED_ADMIN_PASSWORD="$ADMIN_PASSWORD"
  umask 077
  cat >"$ENV_FILE" <<EOF
# Generated by vpnui installer on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# JWT_SECRET signs session tokens — rotating it logs everyone out.
JWT_SECRET=$JWT_SECRET
# One-shot bootstrap credentials: consumed on the first successful start and
# then removed by the installer. Never set them again (use the panel/CLI).
ADMIN_USERNAME=$ADMIN_USERNAME
ADMIN_PASSWORD=$ADMIN_PASSWORD
# Host-facing listen settings (docker-compose.yml interpolates these).
VPNUI_BIND=$BIND_ADDR
PANEL_PORT=$PANEL_PORT
EOF
  ok "generated $ENV_FILE (JWT secret + one-shot admin bootstrap)"
else
  env_set "$ENV_FILE" VPNUI_BIND "$BIND_ADDR"
  env_set "$ENV_FILE" PANEL_PORT "$PANEL_PORT"
  ok "reusing existing $ENV_FILE (bind=$BIND_ADDR, port=$PANEL_PORT)"
fi
# Persist explicit host-dir overrides (custom OpenVPN/data layouts, tests).
[[ -z "${VPNUI_OVPN_HOST_DIR:-}" ]] || env_set "$ENV_FILE" VPNUI_OVPN_HOST_DIR "$VPNUI_OVPN_HOST_DIR"
[[ -z "${VPNUI_DATA_HOST_DIR:-}" ]] || env_set "$ENV_FILE" VPNUI_DATA_HOST_DIR "$VPNUI_DATA_HOST_DIR"
chmod 600 "$ENV_FILE"

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
  env_set "$ENV_FILE" IMAGE_NAME "$REQUESTED_IMAGE"
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

# ---------------------------------------------------------------------------
# Health check (against the configured bind address + port)
# ---------------------------------------------------------------------------
HEALTH_HOST="$BIND_ADDR"
[[ "$HEALTH_HOST" == "0.0.0.0" ]] && HEALTH_HOST="127.0.0.1"
log "waiting for the panel to become healthy on port $PANEL_PORT"
HEALTHY=0
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "http://$HEALTH_HOST:$PANEL_PORT/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done
if [[ $HEALTHY -ne 1 ]]; then
  (cd "$INSTALL_DIR" && "${COMPOSE[@]}" logs --tail 40) || true
  die "panel did not become healthy within 60s (see logs above)"
fi
ok "panel healthy at http://$HEALTH_HOST:$PANEL_PORT/health"

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
mkdir -p "$(dirname "$CLI_LINK")"
install -m 0755 "$INSTALL_DIR/scripts/vpnui" "$CLI_LINK"
mkdir -p "$LIB_DIR"
for s in doctor.sh backup.sh restore.sh; do
  install -m 0755 "$INSTALL_DIR/scripts/$s" "$LIB_DIR/$s"
done
ok "installed $CLI_LINK (try: vpnui doctor)"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
PUBLIC_IP="$(detect_public_ip || true)"
[[ -n "$PUBLIC_IP" ]] || PUBLIC_IP="<server-ip>"

echo
echo "────────────────────────────  vpnui installed  ────────────────────────────"
if [[ "$BIND_ADDR" == "0.0.0.0" ]]; then
  echo " Panel:      http://$PUBLIC_IP:$PANEL_PORT   (direct access, port $PANEL_PORT)"
  echo " Security:   plain HTTP on a public interface — add a TLS reverse proxy"
  echo "             before exposing it to the internet"
  echo " Firewall:   allow $PANEL_PORT/tcp if you access it from outside"
  echo "             (e.g. ufw allow $PANEL_PORT/tcp)"
else
  echo " Panel:      http://127.0.0.1:$PANEL_PORT   (loopback only — reverse proxy required)"
  echo " Server IP:  $PUBLIC_IP"
fi
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
