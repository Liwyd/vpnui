/**
 * Dashboard/status payload: everything the panel needs to describe the VPN
 * server in one round trip, with graceful degradation for optional
 * observability mounts (status file, management socket).
 */
import { parseClientTemplate } from '../services/openvpn/serverConfig.js';
import { readStatus } from '../services/openvpn/status.js';
import { probeManagement } from '../services/openvpn/mgmt.js';
import { getOpenVPNVersion } from '../services/openvpn/tlsCryptV2.js';

export function createStatusController({ config, serverConfig, clients, audit }) {
  return {
    async get(req, res) {
      const [templateInfo, status, mgmt, openvpnVersion, clientData, recent] = await Promise.all([
        parseClientTemplate(config.clientTemplate).catch(() => ({
          endpoint: null,
          port: null,
          proto: null,
        })),
        readStatus(config.statusFile).catch(() => ({
          available: false,
          reason: 'error',
          sessions: [],
          updatedAt: null,
        })),
        probeManagement({
          socketPath: serverConfig.mgmtSocket ?? config.mgmtSocket,
        }).catch(() => ({ available: false, reason: 'error' })),
        getOpenVPNVersion().catch(() => null),
        clients.list(),
        audit.recent(10).catch(() => []),
      ]);

      res.json({
        success: true,
        data: {
          server: {
            endpoint: config.publicEndpoint ?? templateInfo.endpoint,
            port: serverConfig.port ?? (templateInfo.port ? Number(templateInfo.port) : null),
            proto: serverConfig.proto ?? templateInfo.proto,
            tlsMode: serverConfig.tlsMode,
            authMode: serverConfig.authMode,
            vpnSubnet: serverConfig.vpnSubnet,
            duplicateCn: serverConfig.duplicateCn,
            serverConf: serverConfig.path,
            crlPath: serverConfig.crlPath,
          },
          openvpn: {
            managementAvailable: mgmt.available === true,
            managementReason: mgmt.available ? null : mgmt.reason,
            version: openvpnVersion?.raw ?? null,
          },
          clients: clientData.counts,
          sessions: {
            available: status.available,
            reason: status.reason,
            updatedAt: status.updatedAt,
            stale: status.stale ?? false,
            active: status.sessions,
          },
          recentOperations: recent,
          panel: { version: config.version, uptimeSeconds: Math.round(process.uptime()) },
        },
      });
    },
  };
}
