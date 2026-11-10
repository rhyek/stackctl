import { getLoadedConfig, getWorkspaceDir } from '../config.js';
import {
  type DevReverseProxyServer,
  routesFromConfig,
  startDevReverseProxy,
} from '../dev-reverse-proxy.js';
import { proxyTlsFor } from '../dev-tls.js';
import { currentMode } from '../env-base.js';
import { isProcessAlive } from '../process-info.js';
import { isPortListening, readOtherModesRunning } from '../running.js';

/**
 * Starts the loaded config's dev reverse proxy, or resolves `null` when it has none. Runs after
 * the takeover, which has had a previous session of this mode release the port: whatever still
 * listens on it is someone else's, and fails the start rather than being killed. `controlApiPort`
 * is for the "service stopped" page's restart URL.
 */
export async function startSessionDevReverseProxy(opts: {
  controlApiPort: number;
}): Promise<DevReverseProxyServer | null> {
  const config = getLoadedConfig();
  const proxy = config?.reverseProxy;
  if (!config || !proxy) {
    return null;
  }
  const root = getWorkspaceDir();
  if (await isPortListening(proxy.port)) {
    const others = [...readOtherModesRunning(root, currentMode())]
      .filter(([, state]) => isProcessAlive(state.pid))
      .map(([mode]) => mode);
    const port = String(proxy.port);
    throw new Error(
      others.length > 0
        ? `dev reverse proxy port ${port} is already in use — by this project's ${others.join('/')} session, or another program. Each mode's session needs its own \`reverseProxy.port\`; give this mode a different one in its .env file.` // oxfmt-ignore
        : `dev reverse proxy port ${port} is already in use by another program. Free it, or change \`reverseProxy.port\` in stackctl.config.ts.`, // oxfmt-ignore
    );
  }
  // Before any service starts: their `NODE_EXTRA_CA_CERTS` names the trust file this writes.
  const { tls } = await proxyTlsFor(config, root);
  return startDevReverseProxy({
    port: proxy.port,
    domain: proxy.publicAddress.domain,
    domainAliases: proxy.publicAddress.domains.slice(1),
    routes: routesFromConfig(config),
    publicAddress: proxy.publicAddress,
    controlApiPort: opts.controlApiPort,
    tls,
  });
}
