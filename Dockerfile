# syntax=docker/dockerfile:1
# VPNUI panel image — Architecture A: OpenVPN runs on the host, the panel
# runs in a container with only two writable mounts (/etc/openvpn/server,
# /var/lib/vpnui). See docker-compose.yml for the hardened runtime config.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime

# openssl + bash: required by the host Easy-RSA scripts the panel executes.
# openvpn: required for tls-crypt-v2 client key generation.
# tini: proper PID 1 signal handling.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openvpn \
        openssl \
        bash \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/*

ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=3000 \
    DATA_DIR=/var/lib/vpnui \
    OPENVPN_SERVER_DIR=/etc/openvpn/server \
    LOG_LEVEL=info

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY backend ./backend
COPY public ./public

# The container runs as root because the host PKI files
# (/etc/openvpn/server/*.key, mode 0600, root-owned) must be readable.
# Isolation is enforced by the runtime config instead:
#   cap_drop: ALL, read_only rootfs, no-new-privileges, no extra mounts.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "backend/server.js"]
