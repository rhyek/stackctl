import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import picomatch from 'picomatch/posix.js';
import type { Config, ResolvedReverseProxyRoute } from './config.js';
import { infraServicesOf } from './config.js';
import type { ProxyTls } from './dev-tls.js';
import { routeHosts } from './route-hosts.js';
import { createUpstreamPool, isBodyless } from './upstream-pool.js';

export { routeHosts } from './route-hosts.js';

/**
 * The built-in dev reverse proxy.
 *
 * One loopback port per project, reached by a browser directly or through a TLS terminator in
 * front (Caddy, say): each request is routed by `reverseProxy.routes`, an ordered list of entries
 * like a Kubernetes ingress's rules. The first entry whose subdomain matches the request's host
 * handles it — sending it to the entry's service, or to the service of the first of its path globs
 * the request's path matches — on that service's resolved `port`. Since stackctl also knows every
 * package's live status, the proxy can answer for a package that is stopped or still starting
 * instead of surfacing a bare connection error. A package the session doesn't run is forwarded to
 * its port all the same, for an app run outside stackctl, and answered for only when nothing
 * listens there. An infra service has no live status: it is
 * answered for as starting until the session's infra step has finished, and forwarded to from then
 * on. The port speaks HTTP/1.1 and h2c, and TLS too when given a certificate (`tls`); no auth.
 *
 * Built like the control API server: created early (before any package starts) so the listener
 * is bound and the port conflict is settled up front, then bound to the session (`bindSession`)
 * once that exists. Until then every package route answers 503 "starting"; every infra one does until
 * `markInfraReady`.
 */

/** Where the proxy sends a request: a package or an infra service, on its port. */
export type DevReverseProxyTarget = {
  /** The package's or service's resolved port, on loopback. */
  port: number;
} & (
  | {
      kind: 'package';
      /** The package this route goes to. */
      package: string;
      /** Whether the package declares a `healthcheck` — if so, requests wait for it to pass. */
      hasHealthcheck: boolean;
    }
  | {
      kind: 'service';
      /** The infra service this route goes to. */
      service: string;
    }
);

/** A route to an infra service disabled in this profile: it has no port, and gets a 503 page. */
export interface DevReverseProxyDisabledTarget {
  kind: 'disabled';
  /** The infra service, by name. */
  service: string;
}

/** What a route entry names: a target the proxy forwards to, or a disabled infra service. */
export type DevReverseProxyEntryTarget = DevReverseProxyTarget | DevReverseProxyDisabledTarget;

/**
 * One `reverseProxy.routes` entry with its targets resolved: its subdomains (`['*']` for every
 * other host), and the one target it sends every path to, or its path globs, in order.
 */
export type DevReverseProxyEntry = {
  /** The subdomains, as `routes` lists them: hostname labels, or `'*'` alone. */
  subdomain: string[];
} & (
  | { target: DevReverseProxyEntryTarget; paths?: never }
  | { paths: { glob: string; target: DevReverseProxyEntryTarget }[]; target?: never }
);

/** Where one request goes: a target, with the host it asked for and the glob that matched. */
export type DevReverseProxyRoute = DevReverseProxyTarget & {
  /** The hostname the request asked for. */
  host: string;
  /** The `paths` glob the request's path matched, when that is what routed it. */
  path?: string;
};

/** A route to a package. */
type PackageRoute = DevReverseProxyRoute & { kind: 'package' };

/**
 * What a request resolves to: a route; an infra service this profile doesn't run; or nothing, with
 * the path and globs when an entry took the host but none of its globs matched.
 */
type Resolution =
  | { kind: 'route'; route: DevReverseProxyRoute }
  | { kind: 'disabled'; host: string; service: string }
  | { kind: 'none'; unmatched?: { path: string; globs: string[] } };

/**
 * Whether a `paths` glob matches a path: picomatch, with dot segments matched like any other, so
 * `/**` takes `/.well-known/x` and `/node_modules/.vite/deps/x.js` too.
 */
export function globMatcher(glob: string): (pathname: string) => boolean {
  return picomatch(glob, { dot: true });
}

/** The path of a request target (`/a?b`, or an absolute `http://host/a`), without its query. */
export function pathnameOf(url: string | undefined): string {
  if (!url) {
    return '/';
  }
  let target = url;
  if (!target.startsWith('/')) {
    try {
      target = new URL(target).pathname;
    } catch {
      return '/';
    }
  }
  const end = target.search(/[?#]/);
  return end === -1 ? target : target.slice(0, end);
}

/** How a page names a route's target: `api`, `infra service mail`. */
function describeTarget(route: DevReverseProxyEntryTarget): string {
  return route.kind === 'package' ? route.package : `infra service ${route.service}`;
}

/** The name a route entry gives for its target, as `reverseProxy.routes` wrote it. */
function nameOf(target: DevReverseProxyEntryTarget): string {
  return target.kind === 'package' ? target.package : target.service;
}

/** The entries as `reverseProxy.routes` resolves them: what the control API reports. */
export function resolvedRoutesOf(entries: DevReverseProxyEntry[]): ResolvedReverseProxyRoute[] {
  return entries.map(
    (entry) =>
    entry.paths === undefined
      ? { subdomain: entry.subdomain, service: nameOf(entry.target) }
      : { subdomain: entry.subdomain, paths: Object.fromEntries(entry.paths.map((p) => [p.glob, nameOf(p.target)])) }, // oxfmt-ignore
  );
}

/** What the proxy needs from the process manager. `ProcessManager` satisfies it structurally. */
export interface DevReverseProxyManager {
  /** A package's live status, or `null` for one this session isn't managing. */
  getStatus(name: string): string | null;
  /** Whether the package's healthcheck is currently passing. */
  isReady(name: string): boolean;
  /** Called on buffer/status changes; returns the unsubscribe. Readiness alone doesn't fire it. */
  subscribe(listener: () => void): () => void;
  /** stackctl's own `[stackctl]` log channel: attrs render as indented lines under the message. */
  systemLog: { info(attrs: Record<string, unknown>, message: string): void };
}

export interface DevReverseProxyServer {
  /** The port actually bound (the configured one, or the ephemeral one a test asked for). */
  port: number;
  /** The canonical domain (`publicAddress.domain`). */
  domain: string;
  /** Every domain routed: the canonical one, then its aliases. */
  domains: string[];
  /** The route list, as `reverseProxy.routes` resolves it: what the control API reports. */
  routes: ResolvedReverseProxyRoute[];
  /** Hands the proxy the live statuses; logs the route table on stackctl's own channel. */
  bindSession(manager: DevReverseProxyManager): void;
  /**
   * The session's infra step has finished: forward to the infra service routes from now on.
   * Until it's called they answer 503 "starting", and drop websocket upgrades.
   */
  markInfraReady(): void;
  /** Stops listening and destroys every open socket, proxied websockets included. */
  close(): Promise<void>;
}

/** How long a request to a running-but-not-yet-ready package is held before a 503. */
export const READY_HOLD_MS = 15_000;
/** How often a held request re-checks readiness (the manager doesn't announce it). */
const READY_POLL_MS = 250;
/**
 * How long the proxy keeps a client's idle connection open: longer than a TLS terminator keeps
 * one in its pool (Caddy: 2 min), so the terminator always lets go first. Node's default, 5 s,
 * would close connections the terminator still reuses, and each request caught by it is a 502.
 */
const CLIENT_IDLE_MS = 10 * 60_000;
/**
 * Node closes an HTTP/2 connection whose client cancels streams faster than about a thousand at
 * once, then 33 a second: a defence against "rapid reset" floods (CVE-2023-44487). Over h2c every
 * request a TLS terminator forwards shares one connection, and each page closed or reloaded
 * mid-load cancels its in-flight requests on it, so a busy e2e suite would trip it and fail every
 * other request on the connection. The proxy listens on loopback only, for one developer.
 */
const STREAM_RESETS_UNLIMITED = 2 ** 31 - 1;

/**
 * How much an HTTP/2 connection may buffer, in megabytes, before Node refuses new streams on it
 * (its default is 10). One connection carries a whole page load — from a browser over TLS, or
 * from a TLS terminator over h2c — so the proxy allows as much as Vite does on its own HTTP/2
 * server.
 */
const SESSION_MEMORY_MB = 1000;

/**
 * Headers that describe the connection between two hops rather than the message itself.
 * `node:http` manages these on each side; forwarding them would be at best redundant and at
 * worst wrong (a `transfer-encoding` copied onto a re-chunked body, say).
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * A request the proxy answers: HTTP/1.1, or a stream of an HTTP/2 connection — h2c (HTTP/2
 * without TLS), which a TLS terminator in front can use to send a whole page load over one
 * connection, or HTTP/2 over TLS, which a browser speaks when the proxy has a certificate.
 */
type ProxyRequest = http.IncomingMessage | http2.Http2ServerRequest;
type ProxyResponse = http.ServerResponse | http2.Http2ServerResponse;

/** The first bytes of every HTTP/2 connection without TLS (RFC 9113, 3.4). */
const H2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

/** The first byte of every TLS connection: a handshake record (RFC 8446, 5.1). */
const TLS_HANDSHAKE = 0x16;

/** Whether the request reached the proxy over TLS, on either protocol. */
function isEncrypted(req: ProxyRequest): boolean {
  return req instanceof http2.Http2ServerRequest
    ? req.stream.session?.encrypted === true
    : (req.socket as { encrypted?: boolean }).encrypted === true;
}

/**
 * What a request the proxy decrypted itself tells the service about where it came from: the
 * `X-Forwarded-*` a TLS terminator in front would set. Replaced rather than appended to, as the
 * proxy is where the connection ends. Nothing for a plain request, whose headers pass untouched.
 */
function forwardedHeaders(req: ProxyRequest): Record<string, string> {
  if (!isEncrypted(req)) {
    return {};
  }
  const headers: Record<string, string> = { 'x-forwarded-proto': 'https' };
  const host = hostHeaderOf(req);
  if (host !== undefined) {
    headers['x-forwarded-host'] = host;
  }
  const address = req.socket.remoteAddress;
  if (address !== undefined) {
    headers['x-forwarded-for'] = address;
  }
  return headers;
}

/** The request's host: `Host` over HTTP/1.1, `:authority` over HTTP/2. */
function hostHeaderOf(req: ProxyRequest): string | undefined {
  const authority = req.headers[':authority'];
  return req.headers.host ?? (typeof authority === 'string' ? authority : undefined);
}

/** Starts a response with no status message, on either protocol. */
function writeHead(res: ProxyResponse, status: number, headers: http.OutgoingHttpHeaders) {
  if (res instanceof http2.Http2ServerResponse) {
    res.writeHead(status, headers);
  } else {
    res.writeHead(status, headers);
  }
}

/** Drops a response mid-way: the connection over HTTP/1.1, the one stream over HTTP/2. */
function abortResponse(res: ProxyResponse) {
  if (res instanceof http2.Http2ServerResponse) {
    res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
  } else {
    res.destroy();
  }
}

/** Where the proxy sends a request for an application service: its port, and how to wait for it. */
function packageTarget(pkg: Config<string>['services'][string]): DevReverseProxyTarget {
  return {
    kind: 'package',
    package: pkg.name,
    port: pkg.port!,
    hasHealthcheck: pkg.healthcheck !== undefined,
  };
}

/**
 * A config's `reverseProxy.routes`, each name resolved to where the proxy sends it: a package, an
 * enabled infra service, or a disabled one. (The config has already checked every name exists,
 * and that each one enabled has a port.)
 */
export function routesFromConfig(config: Config<string>): DevReverseProxyEntry[] {
  const services = config.services as Record<string, Config<string>['services'][string]>;
  const infra = new Map(infraServicesOf(config).map(({ name, service }) => [name, service]));
  const targetOf = (name: string): DevReverseProxyEntryTarget => {
    const pkg = services[name];
    if (pkg !== undefined) {
      return packageTarget(pkg);
    }
    const service = infra.get(name);
    return service?.enabled === true
      ? { kind: 'service', service: name, port: service.port! }
      : { kind: 'disabled', service: name };
  };
  return (config.reverseProxy?.routes ?? []).map((entry): DevReverseProxyEntry =>
    entry.service !== undefined
      ? { subdomain: entry.subdomain, target: targetOf(entry.service) }
      : {
          subdomain: entry.subdomain,
          paths: Object.entries(entry.paths).map(([glob, name]) => ({ glob, target: targetOf(name) })), // oxfmt-ignore
        },
  );
}

/** The hostname of a `Host` header: lowercased, any `:port` dropped, or `null` when absent. */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) {
    return null;
  }
  const host = hostHeader.trim().toLowerCase();
  // `[::1]:8443` — keep the bracketed literal, drop the port. Otherwise split on the last colon.
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/** `true` when the request would rather have HTML than JSON. */
function acceptsHtml(req: ProxyRequest): boolean {
  return (req.headers.accept ?? '').includes('text/html');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

/** A tiny self-contained page — inline styles, no assets, so it renders with nothing else up. */
function page(title: string, bodyHtml: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    '<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem;color:#222;background:#fafafa}' +
    'h1{font-size:1.4rem}code{background:#eee;padding:.1em .3em;border-radius:3px}ul{padding-left:1.2rem}small{color:#666}</style>' +
    `</head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}<p><small>stackctl dev reverse proxy</small></p></body></html>`
  );
}

interface Problem {
  status: number;
  title: string;
  /** Extra JSON fields (and the paragraph list rendered in HTML). */
  detail: Record<string, unknown>;
  paragraphs: string[];
  listItems?: string[];
  headers: Record<string, string>;
}

function sendProblem(req: ProxyRequest, res: ProxyResponse, problem: Problem) {
  // The request is never needed, but read to its end: over HTTP/2, Node resets a stream whose
  // request was never read as soon as its response is written (see `forward`).
  req.resume();
  const headers = { 'cache-control': 'no-store', ...problem.headers };
  if (acceptsHtml(req)) {
    const items = problem.listItems?.length
      ? `<ul>${problem.listItems.map((i) => `<li><a href="${escapeHtml(i)}"><code>${escapeHtml(i)}</code></a></li>`).join('')}</ul>`
      : '';
    const body = problem.paragraphs.map((p) => `<p>${p}</p>`).join('') + items;
    writeHead(res, problem.status, { ...headers, 'content-type': 'text/html; charset=utf-8' });
    res.end(page(problem.title, body));
    return;
  }
  writeHead(res, problem.status, { ...headers, 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: problem.title, ...problem.detail }));
}

export async function startDevReverseProxy(opts: {
  /** The loopback port to bind; `0` for an ephemeral one (tests). */
  port: number;
  /** The canonical domain, the one every route's `host` is under. */
  domain: string;
  /**
   * Further domains that route exactly like the canonical one: `<x>.<alias>` reaches what
   * `<x>.<domain>` does, and the bare alias what the bare root does.
   */
  domainAliases?: string[];
  /** `reverseProxy.routes`, each target resolved (`routesFromConfig`), tried in order. */
  routes: DevReverseProxyEntry[];
  /**
   * The scheme and port browsers use (`reverseProxy.publicAddress`), for the links the 404 page
   * lists. Omitted: `http`, on the bound port.
   */
  publicAddress?: { scheme: 'https' | 'http'; port: number | undefined };
  /** The control API's port, if known, so a 503 page can spell out the exact `restart` URL. */
  controlApiPort?: number;
  /**
   * Serve TLS too, with this certificate (or one per hostname, through its `SNICallback`): a
   * connection opening with a TLS handshake gets HTTP/2 or HTTP/1.1 over TLS, by ALPN.
   */
  tls?: ProxyTls;
  /** Override of {@link READY_HOLD_MS}. */
  readyTimeoutMs?: number;
}): Promise<DevReverseProxyServer> {
  const { domain, routes: entries } = opts;
  const domains = [domain, ...(opts.domainAliases ?? [])];
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_HOLD_MS;
  // Each glob compiled once, here, rather than on every request.
  const compiled = entries.map((entry) => ({
    ...entry,
    matchers: (entry.paths ?? []).map((p) => ({ ...p, matches: globMatcher(p.glob) })),
  }));
  /** The entry each subdomain names, and the `'*'` one (last, when there is one). */
  const bySubdomain = new Map(compiled.flatMap((entry) => entry.subdomain.map((s) => [s, entry] as const))); // oxfmt-ignore
  const wildcard = bySubdomain.get('*');
  /**
   * The subdomain a host asks for under one of the domains: `''` for a bare domain, `null` for a
   * host under none. (No domain is under another — the config rejects that — so one at most.)
   */
  const subdomainOf = (host: string): string | null => {
    for (const root of domains) {
      if (host === root) {
        return '';
      }
      if (host.endsWith(`.${root}`)) {
        return host.slice(0, -root.length - 1);
      }
    }
    return null;
  };
  /**
   * Where a request goes: the entry its subdomain names, else the `'*'` one; then that entry's
   * target, or the first of its globs the path matches. An entry whose globs all miss is a 404:
   * the request never goes on to another entry. A host under no domain is nobody's. The route
   * carries the host asked for, so a status page names it.
   */
  const resolveRoute = (host: string | null, url: string | undefined): Resolution => {
    if (host === null) {
      return { kind: 'none' };
    }
    const subdomain = subdomainOf(host);
    if (subdomain === null) {
      return { kind: 'none' };
    }
    const entry = (subdomain === '' ? undefined : bySubdomain.get(subdomain)) ?? wildcard;
    if (entry === undefined) {
      return { kind: 'none' };
    }
    if (entry.target !== undefined) {
      return routed(entry.target, host);
    }
    const pathname = pathnameOf(url);
    const hit = entry.matchers.find((m) => m.matches(pathname));
    return hit === undefined
      ? { kind: 'none', unmatched: { path: pathname, globs: entry.matchers.map((m) => m.glob) } }
      : routed(hit.target, host, hit.glob);
  };
  const routed = (target: DevReverseProxyEntryTarget, host: string, path?: string): Resolution =>
    target.kind === 'disabled'
      ? { kind: 'disabled', host, service: target.service }
      : { kind: 'route', route: { ...target, host, ...(path === undefined ? {} : { path }) } };
  let manager: DevReverseProxyManager | null = null;
  let infraReady = false;
  /** Every socket we've seen, on either side, so `close()` can cut them all. */
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  /**
   * The connections forwarded requests go out on (`upstream-pool.ts`). Websocket upgrades dial on
   * their own, since an upgraded socket leaves any pool.
   */
  const upstreamPool = createUpstreamPool();

  const restartHint = (name: string) =>
    opts.controlApiPort !== undefined
      ? `POST http://127.0.0.1:${String(opts.controlApiPort)}/command/service/restart/${name}`
      : `POST /command/service/restart/${name} on the control API`;

  // `port` (the bound one) is assigned below, before any request can arrive.
  let port = opts.port;

  /** Each host a route names, under the canonical domain: what the 404 page and the log list. */
  const namedHosts = [...new Set(routeHosts(entries, [domain]))];
  const linkTo = (host: string) => {
    const scheme = opts.publicAddress?.scheme ?? 'http';
    const publicPort = opts.publicAddress === undefined ? port : opts.publicAddress.port;
    const shown = publicPort === undefined || publicPort === (scheme === 'https' ? 443 : 80) ? '' : `:${String(publicPort)}`; // oxfmt-ignore
    return `${scheme}://${host}${shown}`;
  };
  const domainList = domains.map((d) => `<code>${escapeHtml(d)}</code>`).join(', ');

  const notFound = (
    req: ProxyRequest,
    res: ProxyResponse,
    host: string | null,
    unmatched?: { path: string; globs: string[] },
  ) => {
    const urls = namedHosts.map(linkTo);
    const paragraphs = unmatched
      ? [
          `<code>${escapeHtml(host ?? '')}</code> is routed by path, and none of its globs matches <code>${escapeHtml(unmatched.path)}</code>: ` +
            `${unmatched.globs.map((g) => `<code>${escapeHtml(g)}</code>`).join(', ')}.`,
        ]
      : [];
    if (wildcard !== undefined) {
      paragraphs.push(
        `The <code>*</code> route takes every host under ${domainList} that no other route names, the bare domain included.`,
      );
    }
    paragraphs.push(
      `The stackctl dev reverse proxy for ${domainList} serves these` +
        (domains.length > 1 ? ', each under every one of those domains:' : ':'),
    );
    sendProblem(req, res, {
      status: 404,
      title: unmatched
        ? `Nothing is routed at ${host ?? ''}${unmatched.path}`
        : `Nothing is routed at ${host ?? '(no Host header)'}`,
      detail: {
        host,
        ...(unmatched && { path: unmatched.path, globs: unmatched.globs }),
        routes: namedHosts,
        wildcard: wildcard !== undefined,
        urls,
      },
      paragraphs,
      listItems: urls,
      headers: {},
    });
  };

  /** The 503 for an infra service a route names that this profile doesn't run. */
  const disabled = (req: ProxyRequest, res: ProxyResponse, host: string, service: string) => {
    sendProblem(req, res, {
      status: 503,
      title: `infra service ${service} is disabled`,
      detail: {
        infraService: service,
        status: 'disabled',
        host,
        hint: 'its `enabled` turns it off in this profile',
      },
      paragraphs: [
        `<code>${escapeHtml(host)}</code> routes to the infra service <code>${escapeHtml(service)}</code>, which its <code>enabled</code> turns off in this profile.`,
      ],
      headers: {},
    });
  };

  /** The first paragraph of a package's 503: the host, the package, and its status. */
  const routesTo = (route: PackageRoute, status: string) =>
    `<code>${escapeHtml(route.host + (route.path ?? ''))}</code> routes to the service <code>${escapeHtml(route.package)}</code>, which is currently <strong>${escapeHtml(status)}</strong>.`;

  /**
   * A 503 for a package in the session the proxy can't forward to right now. `status` is the
   * package's live status, or "starting" for one whose readiness is still pending.
   */
  const unavailable = (
    req: ProxyRequest,
    res: ProxyResponse,
    route: PackageRoute,
    status: string,
  ) => {
    sendProblem(req, res, {
      status: 503,
      title: `${route.package} is ${status}`,
      detail: {
        service: route.package,
        status,
        host: route.host,
        hint: `start it with the s hotkey, or ${restartHint(route.package)}`,
      },
      paragraphs: [
        routesTo(route, status),
        `Start it with the <code>s</code> hotkey in stackctl, or <code>${escapeHtml(restartHint(route.package))}</code>.`,
        'This page refreshes on its own.',
      ],
      headers: { 'retry-after': '2', refresh: '2' },
    });
  };

  /**
   * The 503 for a package the session doesn't run, once a dial to its port found nothing
   * answering there (`code`, the dial's error).
   */
  const nothingListening = (
    req: ProxyRequest,
    res: ProxyResponse,
    route: PackageRoute,
    code: string,
  ) => {
    const port = String(route.port);
    sendProblem(req, res, {
      status: 503,
      title: `${route.package} is not running`,
      detail: {
        service: route.package,
        status: 'not running',
        host: route.host,
        port: route.port,
        code,
        hint: `not part of the running stackctl session, and nothing is listening on :${port}`,
      },
      paragraphs: [
        routesTo(route, 'not running'),
        `It is not part of the running stackctl session, and nothing is listening on <code>:${port}</code> — start a session that includes it, or start it yourself on that port.`,
        'This page refreshes on its own.',
      ],
      headers: { 'retry-after': '2', refresh: '2' },
    });
  };

  /** The 503 for an infra service while the session is still bringing the infra up. */
  const serviceStarting = (
    req: ProxyRequest,
    res: ProxyResponse,
    route: DevReverseProxyRoute & { kind: 'service' },
  ) => {
    sendProblem(req, res, {
      status: 503,
      title: `${describeTarget(route)} is starting`,
      detail: {
        infraService: route.service,
        status: 'starting',
        host: route.host,
        hint: 'stackctl is still bringing the infra up',
      },
      paragraphs: [
        `<code>${escapeHtml(route.host)}</code> routes to the infra service <code>${escapeHtml(route.service)}</code>, which stackctl is still bringing up.`,
        'This page refreshes on its own.',
      ],
      headers: { 'retry-after': '2', refresh: '2' },
    });
  };

  /**
   * How a forwarded request that failed before its response started is answered. `reused` says
   * whether it went out on a kept-alive connection rather than a fresh one.
   */
  type ForwardFailed<R extends DevReverseProxyRoute = DevReverseProxyRoute> = (
    req: ProxyRequest,
    res: ProxyResponse,
    route: R,
    err: NodeJS.ErrnoException,
    reused: boolean,
  ) => void;

  const badGateway: ForwardFailed = (req, res, route, err) => {
    const target = route.kind === 'package' ? { service: route.package } : { infraService: route.service }; // oxfmt-ignore
    sendProblem(req, res, {
      status: 502,
      title: `${describeTarget(route)} is not answering on port ${String(route.port)}`,
      detail: { ...target, port: route.port, code: err.code ?? null },
      paragraphs: [
        `<code>${escapeHtml(route.host + (route.path ?? ''))}</code> routes to <code>${escapeHtml(describeTarget(route))}</code> on <code>localhost:${String(route.port)}</code>, ` +
          `but the connection failed (<code>${escapeHtml(err.code ?? err.message)}</code>). ` +
          (route.kind === 'package'
            ? 'It may still be starting, or listening on a different port than its config says.'
            : 'It may have stopped, or publish a different port than its config says.'),
      ],
      headers: { 'retry-after': '1', refresh: '1' },
    });
  };

  /**
   * Where to dial a route: the package's or service's port on `localhost`, trying both loopback
   * families. A package may bind only one of them — Vite on a modern Node listens on `[::1]`
   * alone — and a fixed `127.0.0.1` would be refused there while the package's own healthcheck
   * (which dials `localhost` the same way) passes.
   */
  const upstreamAddress = (route: DevReverseProxyRoute) => ({
    host: 'localhost',
    port: route.port,
    autoSelectFamily: true,
  });

  /**
   * Copies headers minus the hop-by-hop set (upgrades keep theirs — the handshake needs them) and
   * HTTP/2's pseudo-headers (`:path`, `:authority`…), which have no place in an HTTP/1.1 message.
   */
  const endToEnd = (headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => {
    const out: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!HOP_BY_HOP.has(name) && !name.startsWith(':') && value !== undefined) {
        out[name] = value;
      }
    }
    return out;
  };

  /**
   * Resolves once the package can be forwarded to (`true`), or when it can't (`false`): status no
   * longer `running`, or the hold deadline passed. Re-checks on manager notifications and on a
   * short poll, since a readiness flip on its own doesn't notify. Also gives up if the client
   * goes away while waiting (its connection, or over HTTP/2 its stream), so a held request can't
   * outlive it.
   */
  const waitUntilReady = (route: DevReverseProxyRoute & { kind: 'package' }, res: ProxyResponse) =>
    // oxfmt-ignore
    new Promise<boolean>((resolve) => {
      const check = (): boolean => {
        if (!manager) {
          return false;
        }
        if (manager.getStatus(route.package) !== 'running') {
          finish(false);
          return true;
        }
        if (manager.isReady(route.package)) {
          finish(true);
          return true;
        }
        return false;
      };
      let done = false;
      const finish = (ok: boolean) => {
        if (done) {
          return;
        }
        done = true;
        unsubscribe();
        clearInterval(poll);
        clearTimeout(deadline);
        res.off('close', onClose);
        resolve(ok);
      };
      const onClose = () => finish(false);
      const unsubscribe = manager?.subscribe(() => void check()) ?? (() => {});
      const poll = setInterval(check, READY_POLL_MS);
      const deadline = setTimeout(() => finish(false), readyTimeoutMs);
      res.once('close', onClose);
      check();
    });

  /**
   * A package the session doesn't run: its 503 when nothing answered on its port, rather than a
   * 502, since nobody said anything would be there. Nothing answered when the dial was refused, or
   * when a fresh connection was reset before any response (as a container runtime's port forwarder
   * does with nothing listening behind it). A reset on a reused connection, or something there
   * that doesn't speak HTTP, is the 502 as for any other route.
   */
  const outsideSession: ForwardFailed<PackageRoute> = (req, res, route, err, reused) => {
    const code = err.code;
    const nothingAnswered =
      code === 'ECONNREFUSED' || (!reused && (code === 'ECONNRESET' || code === 'EPIPE'));
    if (nothingAnswered) {
      nothingListening(req, res, route, code);
    } else {
      badGateway(req, res, route, err, reused);
    }
  };

  /** Sends `req` to the route's upstream and streams the reply back. */
  const forward = <R extends DevReverseProxyRoute>(
    req: ProxyRequest,
    res: ProxyResponse,
    route: R,
    failed: ForwardFailed<R> = badGateway,
  ) => {
    const bodyless = isBodyless(req);
    // oxfmt-ignore
    const upstream = upstreamPool.request(
      {
        ...upstreamAddress(route),
        method: req.method,
        path: req.url,
        // `host` is kept as received (from `:authority` over HTTP/2), so Node won't synthesize one.
        headers: { ...endToEnd(req.headers), ...forwardedHeaders(req), host: hostHeaderOf(req) },
      },
      bodyless,
      {
        onResponse: (up) => {
          // HTTP/2 has no status message.
          if (res instanceof http2.Http2ServerResponse) {
            res.writeHead(up.statusCode ?? 502, endToEnd(up.headers));
          } else {
            res.writeHead(up.statusCode ?? 502, up.statusMessage, endToEnd(up.headers));
          }
          up.pipe(res);
        },
        onError: (err, reused) => {
          // Once the response has started, there is nothing left to answer with: drop it.
          if (res.headersSent) {
            abortResponse(res);
          } else {
            failed(req, res, route, err, reused);
          }
        },
      },
    );
    if (bodyless) {
      // Sent at once, by the pool: over HTTP/2 a request can leave its side open after its
      // headers (Caddy does for one of unknown length), and piping it would forward a GET with a
      // chunked body. Read the (empty) request to its end all the same: over HTTP/2, Node resets a
      // stream whose request was never read as soon as its response is written, and a client still
      // holding its side open can receive that reset before the response's end, and drop the
      // response.
      req.resume();
    } else {
      req.pipe(upstream.body);
    }
    // A client that leaves mid-request takes the upstream request with it.
    res.on('close', () => {
      if (!res.writableEnded) {
        upstream.destroy();
      }
    });
  };

  const handle = async (req: ProxyRequest, res: ProxyResponse) => {
    const host = hostnameOf(hostHeaderOf(req));
    const resolution = resolveRoute(host, req.url);
    if (resolution.kind === 'none') {
      return notFound(req, res, host, resolution.unmatched);
    }
    if (resolution.kind === 'disabled') {
      return disabled(req, res, resolution.host, resolution.service);
    }
    const { route } = resolution;
    // A service has no live status to consult: once the infra step is done it is up (that step
    // waits for it), and a service that went away since gets the 502 like any refused dial.
    if (route.kind === 'service') {
      return infraReady ? forward(req, res, route) : serviceStarting(req, res, route);
    }
    if (!manager) {
      return unavailable(req, res, route, 'starting');
    }
    const status = manager.getStatus(route.package);
    // Not part of the session: whatever listens on its port (an app run outside stackctl, say) is
    // forwarded to, with no readiness hold, since stackctl runs no healthcheck for it.
    if (status === null) {
      return forward(req, res, route, outsideSession);
    }
    if (status !== 'running') {
      return unavailable(req, res, route, status);
    }
    if (route.hasHealthcheck && !manager.isReady(route.package)) {
      let gone = false;
      res.once('close', () => (gone = true));
      const ready = await waitUntilReady(route, res);
      if (gone) {
        return;
      }
      if (!ready) {
        const now = manager.getStatus(route.package);
        if (now === null) {
          return forward(req, res, route, outsideSession);
        }
        return unavailable(req, res, route, now === 'running' ? 'starting' : now);
      }
    }
    forward(req, res, route);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  // Nothing here may time out on the proxy's account: SSE streams and long polls live as long as
  // the app in front and the package behind want them to.
  server.requestTimeout = 0;
  server.setTimeout(0);
  server.keepAliveTimeout = CLIENT_IDLE_MS;

  // The same requests over h2c. HTTP/2 needs no websocket path here: an upgrade is HTTP/1.1.
  const h2server = http2.createServer(
    {
      maxSessionMemory: SESSION_MEMORY_MB,
      streamResetBurst: STREAM_RESETS_UNLIMITED,
      streamResetRate: STREAM_RESETS_UNLIMITED,
    },
    (req, res) => {
      void handle(req, res);
    },
  );
  h2server.setTimeout(0);
  const sessions = new Set<http2.ServerHttp2Session>();
  const trackSession = (session: http2.ServerHttp2Session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  };
  h2server.on('session', trackSession);

  // The same requests over TLS, as Vite serves them with a certificate: HTTP/2 for a client that
  // offers it by ALPN (every browser), HTTP/1.1 for the rest, websocket upgrades included.
  const tlsServer =
    opts.tls &&
    http2.createSecureServer(
      {
        ...opts.tls,
        allowHTTP1: true,
        maxSessionMemory: SESSION_MEMORY_MB,
        streamResetBurst: STREAM_RESETS_UNLIMITED,
        streamResetRate: STREAM_RESETS_UNLIMITED,
      },
      (req, res) => {
        void handle(req, res);
      },
    );
  if (tlsServer) {
    tlsServer.setTimeout(0);
    // Its HTTP/1.1 connections are served as an `http.Server`'s, from these fields, which Node
    // sets on a server with `allowHTTP1` but leaves out of its type.
    Object.assign(tlsServer, { requestTimeout: 0, keepAliveTimeout: CLIENT_IDLE_MS });
    tlsServer.on('session', trackSession);
    // A failed handshake (a browser refusing the self-signed certificate, say) is the client's
    // business: its socket closes, and nothing else does.
    tlsServer.on('tlsClientError', (_err, socket) => socket.destroy());
  }

  /**
   * Hands a new connection to the TLS server when it opens with a TLS handshake (and the proxy
   * has a certificate), to the h2c server when it opens with HTTP/2's preface, else to the
   * HTTP/1.1 one, all serving the same port. The bytes read to tell them apart are put back on the
   * socket first: each server reads them from there (Node's HTTP/2 session and TLS socket both
   * take a socket's buffered bytes before reading its handle), so each gets the socket itself.
   */
  const dispatch = (socket: net.Socket) => {
    track(socket);
    socket.on('error', () => socket.destroy());
    let seen = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      seen = Buffer.concat([seen, chunk]);
      const encrypted = tlsServer !== undefined && seen[0] === TLS_HANDSHAKE;
      const n = Math.min(seen.length, H2_PREFACE.length);
      const h2 = !encrypted && seen.subarray(0, n).equals(H2_PREFACE.subarray(0, n));
      if (h2 && seen.length < H2_PREFACE.length) {
        return; // not enough to tell yet
      }
      socket.off('data', onData);
      socket.pause();
      socket.unshift(seen);
      if (encrypted) {
        tlsServer.emit('connection', socket);
        return;
      }
      if (h2) {
        h2server.emit('connection', socket);
        return;
      }
      server.emit('connection', socket);
      socket.resume();
    };
    socket.on('data', onData);
  };
  const listener = net.createServer(dispatch);

  const upgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    track(socket);
    socket.on('error', () => socket.destroy());
    const host = hostnameOf(req.headers.host);
    const resolution = resolveRoute(host, req.url);
    const route = resolution.kind === 'route' ? resolution.route : undefined;
    // Not routable right now (no route, a disabled infra service, infra or manager not there yet,
    // or a package in the session but not `running`): just drop it — websocket clients such as
    // Vite's HMR reconnect on their own, and a real answer will be there once the target is up. A
    // package the session doesn't run is dialled like a running one, and dropped the same way when
    // nothing listens.
    const status = route?.kind === 'package' ? manager?.getStatus(route.package) : undefined;
    const routable =
      route !== undefined &&
      (route.kind === 'service' ? infraReady : status === 'running' || status === null);
    if (!route || !routable) {
      socket.destroy();
      return;
    }
    const upstream = http.request({
      ...upstreamAddress(route),
      method: req.method,
      path: req.url,
      // The upgrade handshake *is* hop-by-hop: `connection`/`upgrade` must reach the package.
      headers: { ...req.headers, ...forwardedHeaders(req) },
    });
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      track(upSocket);
      upSocket.on('error', () => upSocket.destroy());
      // Replay the upstream's 101 verbatim: status line, then its headers as it sent them.
      const lines = [`HTTP/1.1 ${String(upRes.statusCode ?? 101)} ${upRes.statusMessage ?? 'Switching Protocols'}`]; // oxfmt-ignore
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        lines.push(`${upRes.rawHeaders[i]!}: ${upRes.rawHeaders[i + 1]!}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upHead.length) {
        socket.write(upHead);
      }
      if (head.length) {
        upSocket.write(head);
      }
      socket.pipe(upSocket).pipe(socket);
      socket.once('close', () => upSocket.destroy());
      upSocket.once('close', () => socket.destroy());
    });
    // The package answered with a plain response instead of upgrading (a 4xx, say): pass the
    // status through and close, since there's no upgraded connection to keep.
    upstream.on('response', (upRes) => {
      const lines = [`HTTP/1.1 ${String(upRes.statusCode ?? 502)} ${upRes.statusMessage ?? ''}`, 'connection: close']; // oxfmt-ignore
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        if (!HOP_BY_HOP.has(upRes.rawHeaders[i]!.toLowerCase())) {
          lines.push(`${upRes.rawHeaders[i]!}: ${upRes.rawHeaders[i + 1]!}`);
        }
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      upRes.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.end();
  };
  server.on('upgrade', upgrade);
  tlsServer?.on('upgrade', upgrade);

  await new Promise<void>((resolve, reject) => {
    listener.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `dev reverse proxy port ${String(opts.port)} is already in use by another program. ` +
                'Free it, or change `reverseProxy.port` in stackctl.config.ts.',
            )
          : err,
      );
    });
    listener.listen(opts.port, '127.0.0.1', resolve);
  });
  port = (listener.address() as net.AddressInfo).port;

  return {
    port,
    domain,
    domains,
    routes: resolvedRoutesOf(entries),
    bindSession(m) {
      manager = m;
      // One entry: the listener as the message, then a line per host and glob, in route order
      // (`api.<domain>: api :3001`, `app.<domain>/docs/**: docs :3002`, `*: web :3000`), which the
      // log formatter indents beneath it — readable at any terminal width.
      const at = (t: DevReverseProxyEntryTarget) =>
        t.kind === 'disabled' ? `${describeTarget(t)} (disabled)` : `${describeTarget(t)} :${String(t.port)}`; // oxfmt-ignore
      const table = Object.fromEntries<string>(
        entries.flatMap((entry) =>
          entry.subdomain.flatMap((subdomain): [string, string][] => {
            const host = subdomain === '*' ? '*' : `${subdomain}.${domain}`;
            return entry.paths === undefined
              ? [[host, at(entry.target)]]
              : entry.paths.map((p): [string, string] => [`${host}${p.glob}`, at(p.target)]);
          }),
        ),
      );
      m.systemLog.info(
        table,
        `dev reverse proxy listening on 127.0.0.1:${String(port)}` +
          (entries.length === 0
            ? ' — nothing to route (`reverseProxy.routes` is empty)'
            : wildcard === undefined
              ? ''
              : ' — `*` is every other host'),
      );
    },
    markInfraReady() {
      infraReady = true;
    },
    close() {
      return new Promise<void>((resolve) => {
        listener.close(() => resolve());
        upstreamPool.destroy();
        for (const session of sessions) {
          session.destroy();
        }
        for (const socket of sockets) {
          socket.destroy();
        }
      });
    },
  };
}
