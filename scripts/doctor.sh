#!/usr/bin/env bash
#
# vpnui doctor — diagnostics with ✓ / ⚠ / ✗ results and fix hints.
#
# Exit code: 0 = no errors (warnings allowed), 1 = at least one ✗.
#
set -uo pipefail

VERSION="1.1.0"
INSTALL_DIR="${VPNUI_DIR:-/opt/vpnui}"
SERVER_DIR="${OPENVPN_SERVER_DIR:-/etc/openvpn/server}"
ENV_FILE="$INSTALL_DIR/.env"
# Panel address derived from .env (VPNUI_BIND/PANEL_PORT, defaults 127.0.0.1:3000)
PANEL_PORT="$(grep '^PANEL_PORT=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
[[ "$PANEL_PORT" =~ ^[0-9]{1,5}$ ]] || PANEL_PORT=3000
PANEL_BIND="$(grep '^VPNUI_BIND=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
case "$PANEL_BIND" in
"" | 127.0.0.1 | 0.0.0.0) PANEL_HOST="127.0.0.1" ;;
*) PANEL_HOST="$PANEL_BIND" ;;
esac
PANEL_URL="http://$PANEL_HOST:$PANEL_PORT"
ERRORS=0
WARNINGS=0
PASSED=0

title() { printf '\n\033[1m%s\033[0m\n' "$*"; }
pass() {
  printf '  \033[1;32m✓\033[0m %s\n' "$*"
  PASSED=$((PASSED + 1))
}
note() { printf '      %s\n' "$*"; }
warn_check() {
  printf '  \033[1;33m⚠\033[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && note "fix: $2"
  WARNINGS=$((WARNINGS + 1))
}
fail() {
  printf '  \033[1;31m✗\033[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && note "fix: $2"
  ERRORS=$((ERRORS + 1))
}

detect_compose() {
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1 &&
    docker info >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v podman >/dev/null && podman compose version >/dev/null 2>&1 &&
    podman info >/dev/null 2>&1; then
    local sock
    sock="$(podman info --format '{{.Host.RemoteSocket.Path}}' 2>/dev/null || true)"
    if [[ -n "$sock" && -S "$sock" ]]; then
      COMPOSE=(podman compose)
    else
      COMPOSE_HINT="podman API socket not running — start it: systemctl --user start podman.socket"
      return 1
    fi
  else
    return 1
  fi
}

conf_value() { # first value of a directive in server.conf
  [[ -f "$SERVER_DIR/server.conf" ]] || return 1
  awk -v key="$1" '$1==key {print $2; exit}' "$SERVER_DIR/server.conf"
}

conf_path() { # resolve a (possibly relative) path from server.conf
  case "$1" in
  /*) printf '%s\n' "$1" ;;
  *) printf '%s/%s\n' "$SERVER_DIR" "$1" ;;
  esac
}

echo "vpnui doctor v$VERSION — $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---------------------------------------------------------------------------
title "System"
if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  pass "OS: ${PRETTY_NAME:-unknown} ($(uname -m))"
else
  warn_check "OS: /etc/os-release missing" "run this on a supported Linux distro (Debian/Ubuntu/Fedora)"
fi

if [[ $EUID -eq 0 ]]; then
  pass "privileges: running as root (all checks enabled)"
else
  warn_check "privileges: not root — firewall/permission checks are limited" "re-run with sudo for full coverage"
fi

# ---------------------------------------------------------------------------
title "Container engine"
COMPOSE=()
if detect_compose; then
  pass "compose: ${COMPOSE[*]}"
else
  fail "compose: no usable docker/podman compose found" \
    "apt-get install -y docker.io docker-compose-v2 && systemctl enable --now docker${COMPOSE_HINT:+ — $COMPOSE_HINT}"
fi

# ---------------------------------------------------------------------------
title "OpenVPN installation"
if command -v openvpn >/dev/null 2>&1; then
  OVPN_VER="$(openvpn --version 2>/dev/null | head -1 | awk '{print $2}')"
  pass "openvpn: $OVPN_VER"
  OVPN_MAJOR="${OVPN_VER%%.*}"
  OVPN_REST="${OVPN_VER#*.}"
  OVPN_MINOR="${OVPN_REST%%[^0-9]*}"
  if [[ -n "$OVPN_MAJOR" && -n "$OVPN_MINOR" ]] &&
    { [[ "$OVPN_MAJOR" -gt 2 ]] || { [[ "$OVPN_MAJOR" -eq 2 ]] && [[ "$OVPN_MINOR" -ge 5 ]]; }; }; then
    pass "tls-crypt-v2 support: openvpn >= 2.5"
  else
    warn_check "tls-crypt-v2 support: openvpn < 2.5" "upgrade openvpn (crypt-v2 keys need >= 2.5)"
  fi
else
  fail "openvpn: binary not found" "dnf install -y openvpn  (or apt-get install -y openvpn) — needed for tls-crypt-v2 client keys"
fi

if [[ -f "$SERVER_DIR/server.conf" ]]; then
  pass "server.conf: $SERVER_DIR/server.conf"
else
  fail "server.conf: missing ($SERVER_DIR/server.conf)" "run: sudo scripts/install.sh  (provisions OpenVPN with defaults)"
fi

MISSING_DIRECTIVES=""
for directive in port proto server ca cert key crl-verify; do
  conf_value "$directive" >/dev/null || MISSING_DIRECTIVES="$MISSING_DIRECTIVES $directive"
done
if [[ -z "$MISSING_DIRECTIVES" && -f "$SERVER_DIR/server.conf" ]]; then
  pass "server.conf directives: port, proto, server, ca, cert, key, crl-verify"
elif [[ -f "$SERVER_DIR/server.conf" ]]; then
  fail "server.conf directives missing:$MISSING_DIRECTIVES" "inspect $SERVER_DIR/server.conf and compare with docs/openvpn.md"
fi

CLIENT_TEMPLATE="${CLIENT_TEMPLATE:-$SERVER_DIR/client-template.txt}"
if [[ -f "$CLIENT_TEMPLATE" ]] && grep -q '^remote ' "$CLIENT_TEMPLATE"; then
  pass "client template: $CLIENT_TEMPLATE"
else
  fail "client template: missing or has no 'remote' line ($CLIENT_TEMPLATE)" "the installer creates it; re-run: sudo scripts/install.sh"
fi

# ---------------------------------------------------------------------------
title "PKI"
if [[ -f "$SERVER_DIR/easy-rsa/pki/index.txt" ]]; then
  pass "index.txt: $SERVER_DIR/easy-rsa/pki/index.txt"
else
  fail "index.txt: missing — Easy-RSA PKI not initialized" "run: sudo scripts/install.sh"
fi

CA_FILE="$(conf_value ca 2>/dev/null || true)"
CERT_FILE="$(conf_value cert 2>/dev/null || true)"
KEY_FILE="$(conf_value key 2>/dev/null || true)"
if [[ -n "$CA_FILE" && -f "$(conf_path "$CA_FILE")" ]]; then
  pass "CA certificate: $(conf_path "$CA_FILE")"
else
  fail "CA certificate: missing (${CA_FILE:-unspecified})" "re-run the installer or restore a backup (vpnui restore)"
fi
if [[ -n "$CERT_FILE" && -f "$(conf_path "$CERT_FILE")" ]]; then
  pass "server certificate: $(conf_path "$CERT_FILE")"
else
  fail "server certificate: missing (${CERT_FILE:-unspecified})" "re-run the installer or restore a backup (vpnui restore)"
fi
if [[ -n "$KEY_FILE" && -f "$(conf_path "$KEY_FILE")" ]]; then
  if [[ -r "$(conf_path "$KEY_FILE")" ]]; then
    pass "server key: $(conf_path "$KEY_FILE") (readable)"
  else
    warn_check "server key: $(conf_path "$KEY_FILE") not readable by $(id -un)" "chown root:root + chmod 600 on the key; run the panel as root (documented requirement)"
  fi
else
  fail "server key: missing (${KEY_FILE:-unspecified})" "re-run the installer or restore a backup (vpnui restore)"
fi

CRL_FILE="$(conf_value crl-verify 2>/dev/null || true)"
if [[ -n "$CRL_FILE" ]]; then
  CRL_PATH="$(conf_path "$CRL_FILE")"
  if [[ -f "$CRL_PATH" ]] && openssl crl -in "$CRL_PATH" -noout 2>/dev/null; then
    CRL_REVOKED="$(openssl crl -in "$CRL_PATH" -noout -text 2>/dev/null | grep -c 'Serial Number:' || true)"
    pass "CRL: $CRL_PATH parses (revoked entries: $CRL_REVOKED)"
  else
    fail "CRL: $CRL_PATH missing or unparsable" "cd $SERVER_DIR/easy-rsa && EASYRSA_BATCH=1 ./easyrsa gen-crl && cp pki/crl.pem $SERVER_DIR/"
  fi
fi

TLS_CRYPT_V2_FILE="$(conf_value tls-crypt-v2 2>/dev/null || true)"
if [[ -n "$TLS_CRYPT_V2_FILE" ]]; then
  if [[ -f "$(conf_path "$TLS_CRYPT_V2_FILE")" ]]; then
    pass "tls-crypt-v2 server key: $(conf_path "$TLS_CRYPT_V2_FILE")"
  else
    fail "tls-crypt-v2 server key: missing ($(conf_path "$TLS_CRYPT_V2_FILE"))" "openvpn --genkey tls-crypt-v2-server $SERVER_DIR/tls-crypt-v2.key"
  fi
else
  warn_check "tls-crypt-v2: not configured in server.conf" "modern installs use tls-crypt-v2 (docs/openvpn.md)"
fi

EASYRSA_BIN=""
for candidate in "${EASY_RSA_DIR:-}" "$SERVER_DIR/easy-rsa" /usr/share/easy-rsa /usr/share/easy-rsa/3 /etc/easy-rsa; do
  [[ -n "$candidate" && -x "$candidate/easyrsa" ]] && EASYRSA_BIN="$candidate/easyrsa" && break
done
if [[ -n "$EASYRSA_BIN" ]]; then
  pass "easy-rsa: $EASYRSA_BIN"
else
  fail "easy-rsa: not found (looked at \$EASY_RSA_DIR, $SERVER_DIR/easy-rsa, /usr/share/easy-rsa)" "apt-get install -y easy-rsa  (or dnf install -y easy-rsa)"
fi

# ---------------------------------------------------------------------------
title "Host networking"
IPFWD="$(sysctl -n net.ipv4.ip_forward 2>/dev/null || echo '?')"
if [[ "$IPFWD" == "1" ]]; then
  pass "ip_forward: enabled"
else
  fail "ip_forward: ${IPFWD} (clients cannot reach the internet/LAN through the VPN)" "echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-vpnui.conf && sysctl --system"
fi

VPN_NET="$(awk '$1=="server" {print $2; exit}' "$SERVER_DIR/server.conf" 2>/dev/null || true)"
VPN_MASK="$(awk '$1=="server" {print $3; exit}' "$SERVER_DIR/server.conf" 2>/dev/null || true)"
VPN_CIDR=""
if [[ -n "$VPN_NET" && -n "$VPN_MASK" ]]; then
  IFS=. read -r o1 o2 o3 o4 <<<"$VPN_MASK"
  prefix=0
  for octet in "$o1" "$o2" "$o3" "$o4"; do
    for bit in 128 64 32 16 8 4 2 1; do
      if ((octet & bit)); then prefix=$((prefix + 1)); fi
    done
  done
  VPN_CIDR="$VPN_NET/$prefix"
fi
if command -v iptables >/dev/null 2>&1 && [[ -n "${VPN_CIDR:-}" ]]; then
  if [[ $EUID -eq 0 ]]; then
    if iptables -t nat -C POSTROUTING -s "$VPN_CIDR" -j MASQUERADE 2>/dev/null; then
      pass "NAT: MASQUERADE rule present for $VPN_CIDR"
    elif iptables -t nat -S 2>/dev/null | grep -q MASQUERADE; then
      warn_check "NAT: a MASQUERADE rule exists but not for $VPN_CIDR" "verify NAT: iptables -t nat -S (installer normally adds: -s $VPN_CIDR -j MASQUERADE)"
    else
      fail "NAT: no MASQUERADE rule for $VPN_CIDR" "iptables -t nat -A POSTROUTING -s $VPN_CIDR -j MASQUERADE"
    fi
  else
    warn_check "NAT: not checked (needs root)" "re-run: sudo vpnui doctor"
  fi
else
  warn_check "NAT: not checked (iptables or VPN subnet unknown)" "re-run after OpenVPN is installed"
fi

if command -v systemctl >/dev/null 2>&1; then
  OVPN_UNIT=""
  for unit in openvpn-server@server.service openvpn@server.service; do
    if systemctl list-unit-files "$unit" >/dev/null 2>&1 &&
      systemctl cat "$unit" >/dev/null 2>&1; then
      OVPN_UNIT="$unit"
      break
    fi
  done
  if [[ -z "$OVPN_UNIT" ]]; then
    warn_check "systemd unit: no openvpn-server@server/openvpn@server unit found" "enable your distro's openvpn-server unit for boot persistence"
  elif systemctl is-active --quiet "$OVPN_UNIT"; then
    pass "systemd: $OVPN_UNIT active"
  else
    fail "systemd: $OVPN_UNIT installed but not active" "systemctl enable --now $OVPN_UNIT"
  fi
fi

# ---------------------------------------------------------------------------
title "Panel"
if [[ ${#COMPOSE[@]} -gt 0 && -f "$INSTALL_DIR/docker-compose.yml" ]]; then
  CONTAINER_ID="$(cd "$INSTALL_DIR" 2>/dev/null && "${COMPOSE[@]}" ps -q vpnui 2>/dev/null | head -1)"
  CONTAINER_STATE=""
  MOUNTS=""
  if [[ -n "$CONTAINER_ID" ]]; then
    CONTAINER_STATE="$("${COMPOSE[0]}" inspect --format '{{.State.Status}}' "$CONTAINER_ID" 2>/dev/null || echo unknown)"
    MOUNTS="$("${COMPOSE[0]}" inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$CONTAINER_ID" 2>/dev/null || true)"
  fi
  if [[ "$CONTAINER_STATE" == "running" ]]; then
    pass "container: running"
  else
    fail "container: ${CONTAINER_STATE:-not found}" "cd $INSTALL_DIR && ${COMPOSE[*]} up -d   (logs: vpnui logs)"
  fi

  if [[ -n "$MOUNTS" ]]; then
    case "$MOUNTS" in
    *"/etc/openvpn/server"*) pass "mount: /etc/openvpn/server" ;;
    *) fail "mount: /etc/openvpn/server not mounted into the container" "check docker-compose.yml volumes" ;;
    esac
    case "$MOUNTS" in
    *"/var/lib/vpnui"*) pass "mount: /var/lib/vpnui" ;;
    *) fail "mount: /var/lib/vpnui not mounted into the container" "check docker-compose.yml volumes" ;;
    esac
  fi
elif [[ ! -f "$INSTALL_DIR/docker-compose.yml" ]]; then
  fail "panel: not installed at $INSTALL_DIR" "run: sudo scripts/install.sh"
else
  fail "panel: compose unavailable (see above)" "install docker or podman with compose"
fi

if [[ -f "$ENV_FILE" ]]; then
  pass "env file: $ENV_FILE"
  pass "listen: ${PANEL_BIND:-127.0.0.1 (default)} port $PANEL_PORT"
  JWT_LINE="$(grep '^JWT_SECRET=' "$ENV_FILE" 2>/dev/null | head -1 || true)"
  JWT_VALUE="${JWT_LINE#JWT_SECRET=}"
  if [[ ${#JWT_VALUE} -ge 32 ]]; then
    pass "JWT_SECRET: set (${#JWT_VALUE} chars)"
  else
    fail "JWT_SECRET: missing or too short (<32 chars)" "echo \"JWT_SECRET=\$(openssl rand -hex 32)\" >> $ENV_FILE && vpnui restart"
  fi
  if grep -q '^ADMIN_PASSWORD=' "$ENV_FILE" 2>/dev/null; then
    warn_check "bootstrap credentials still present in .env" "they are consumed on first start — remove ADMIN_USERNAME/ADMIN_PASSWORD lines after a successful start"
  fi
  ENV_PERMS="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '?')"
  if [[ "$ENV_PERMS" == "600" || "$ENV_PERMS" == "400" ]]; then
    pass ".env permissions: $ENV_PERMS"
  else
    warn_check ".env permissions: $ENV_PERMS (should be 600)" "chmod 600 $ENV_FILE"
  fi
else
  fail "env file: missing ($ENV_FILE)" "run: sudo scripts/install.sh"
fi

HEALTH_JSON="$(curl -fsS -m 3 "$PANEL_URL/health" 2>/dev/null || true)"
if [[ -n "$HEALTH_JSON" ]] && grep -q '"status":"ok"' <<<"$HEALTH_JSON"; then
  PANEL_VERSION="$(grep -o '"version":"[^"]*"' <<<"$HEALTH_JSON" | head -1 | cut -d'"' -f4)"
  UPTIME="$(grep -o '"uptimeSeconds":[0-9]*' <<<"$HEALTH_JSON" | cut -d: -f2)"
  pass "health: $PANEL_URL/health ok (version ${PANEL_VERSION:-?}, uptime ${UPTIME:-?}s)"
else
  fail "health: no response from $PANEL_URL/health" "vpnui logs   ·   vpnui status"
fi

# ---------------------------------------------------------------------------
echo
if [[ $ERRORS -eq 0 ]]; then
  printf '\033[1;32mResult: %d passed, %d warnings, 0 errors\033[0m\n' "$PASSED" "$WARNINGS"
  exit 0
fi
printf '\033[1;31mResult: %d errors, %d warnings, %d passed — fix the ✗ items above\033[0m\n' \
  "$ERRORS" "$WARNINGS" "$PASSED"
exit 1
