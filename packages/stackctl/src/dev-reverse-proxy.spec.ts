import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { describe, test, expect, afterEach, vi } from 'vitest';
import { defineConfig } from './config.js';
import {
  startDevReverseProxy,
  routesFromConfig,
  globMatcher,
  pathnameOf,
  type DevReverseProxyEntry,
  type DevReverseProxyEntryTarget,
  type DevReverseProxyManager,
  type DevReverseProxyTarget,
  type DevReverseProxyServer,
} from './dev-reverse-proxy.js';
import { type ProxyTls, selfSignedTls } from './dev-tls.js';
import { UPSTREAM_MAX_NEW_SOCKETS, UPSTREAM_MAX_SOCKETS } from './upstream-pool.js';

// ---------------------------------------------------------------------------
// Fixtures: real upstream servers on ephemeral ports, a stub manager, and a tiny HTTP client
// that sets the Host header the way a TLS terminator forwarding `*.example.test` would.
// ---------------------------------------------------------------------------

const ROOT = 'example.test';

/** Everything opened by a test, closed in `afterEach` so a failure can't leak a listener. */
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) {
    await cleanups.pop()!();
  }
});

interface Upstream {
  port: number;
  server: http.Server;
}

/**
 * An upstream that identifies itself: it answers every request with JSON naming itself, the
 * `Host` it saw, the path, and an `x-custom` request header, and mirrors `x-custom` back as a
 * response header. Its `upgrade` handler is a raw websocket echo.
 */
async function upstream(name: string): Promise<Upstream> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-upstream': name,
      ...(req.headers['x-custom'] ? { 'x-custom-echo': String(req.headers['x-custom']) } : {}),
    });
    res.end(
      JSON.stringify({
        upstream: name,
        host: req.headers.host,
        url: req.url,
        custom: req.headers['x-custom'] ?? null,
      }),
    );
  });
  server.on('upgrade', (_req, socket, head) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `x-upstream: ${name}\r\n\r\n`,
    );
    if (head.length) {
      socket.write(head);
    }
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.on('connection', (socket) => {
    cleanups.push(() => {
      socket.destroy();
    });
  });
  return { port: (server.address() as net.AddressInfo).port, server };
}

type Status = 'running' | 'stopped' | 'waiting' | 'restarting';

interface StubManager extends DevReverseProxyManager {
  set(name: string, status: Status | null): void;
  setReady(name: string, ready: boolean): void;
  logged: [attrs: Record<string, unknown>, message: string][];
}

function stubManager(initial: Record<string, Status> = {}): StubManager {
  const statuses = new Map<string, Status>(Object.entries(initial));
  const ready = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of listeners) {
      l();
    }
  };
  const logged: [attrs: Record<string, unknown>, message: string][] = [];
  return {
    logged,
    getStatus: (name) => statuses.get(name) ?? null,
    isReady: (name) => ready.has(name),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    systemLog: {
      info: (attrs: Record<string, unknown>, message: string) => void logged.push([attrs, message]),
    },
    set(name, status) {
      if (status === null) {
        statuses.delete(name);
      } else {
        statuses.set(name, status);
      }
      notify();
    },
    setReady(name, isReady) {
      if (isReady) {
        ready.add(name);
      } else {
        ready.delete(name);
      }
      // Deliberately no notify: the real manager's readiness changes don't wake subscribers
      // either, so the proxy has to poll for this.
    },
  };
}

async function proxyFor(
  routes: DevReverseProxyEntry[],
  opts: {
    readyTimeoutMs?: number;
    controlApiPort?: number;
    domainAliases?: string[];
    tls?: ProxyTls;
    publicAddress?: { scheme: 'https' | 'http'; port: number | undefined };
  } = {},
): Promise<DevReverseProxyServer> {
  const proxy = await startDevReverseProxy({ port: 0, domain: ROOT, routes, ...opts });
  cleanups.push(() => proxy.close());
  return proxy;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A single request through the proxy, with `host` as the Host header. */
function request(
  proxyPort: number,
  host: string,
  opts: { path?: string; headers?: Record<string, string>; method?: string; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: { host, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** Opens a raw websocket-style upgrade through the proxy; resolves once the 101 arrives. */
function upgrade(
  proxyPort: number,
  host: string,
  path = '/ws',
): Promise<{ socket: net.Socket; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path,
      headers: { host, connection: 'Upgrade', upgrade: 'websocket' },
    });
    req.on('upgrade', (res, socket) => {
      cleanups.push(() => {
        socket.destroy();
      });
      resolve({ socket, res });
    });
    req.on('response', (res) => reject(new Error(`upgrade refused: ${String(res.statusCode)}`)));
    req.on('error', reject);
    req.end();
  });
}

/** A package target. */
const pkg = (name: string, port: number, hasHealthcheck = false): DevReverseProxyTarget => ({ kind: 'package', package: name, port, hasHealthcheck }); // oxfmt-ignore

/** An infra service target. */
const infra = (name: string, port: number): DevReverseProxyTarget => ({ kind: 'service', service: name, port }); // oxfmt-ignore

/** The subdomain of `host` under ROOT (`'*'` for the bare ROOT, standing for every other host). */
const subdomainOf = (host: string) => (host === ROOT ? '*' : host.slice(0, -ROOT.length - 1));

/** A `service` entry sending `host` (a host under ROOT) to a package. */
const route = (host: string, name: string, port: number, hasHealthcheck = false): DevReverseProxyEntry => ({ subdomain: [subdomainOf(host)], target: pkg(name, port, hasHealthcheck) }); // oxfmt-ignore

/** A `service` entry sending `host` (a host under ROOT) to an infra service. */
const serviceRoute = (host: string, service: string, port: number): DevReverseProxyEntry => ({ subdomain: [subdomainOf(host)], target: infra(service, port) }); // oxfmt-ignore

/** A `paths` entry: its subdomains, and each glob's target, in order. */
const byPath = (subdomain: string[], paths: [glob: string, target: DevReverseProxyEntryTarget][]): DevReverseProxyEntry => ({ subdomain, paths: paths.map(([glob, target]) => ({ glob, target })) }); // oxfmt-ignore

/** A loopback port nothing listens on: bind an ephemeral one, read the number, release it. */
async function deadPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// ---------------------------------------------------------------------------

describe('routing by host', () => {
  test('routes each subdomain an entry lists, every one of an array', async () => {
    const web = await upstream('web');
    const api = await upstream('api');
    const proxy = await proxyFor([
      { subdomain: ['web', 'www'], target: pkg('web', web.port) },
      route(`api.${ROOT}`, 'api', api.port),
    ]);
    proxy.bindSession(stubManager({ web: 'running', api: 'running' }));

    for (const [host, expected] of [
      [`web.${ROOT}`, 'web'],
      [`www.${ROOT}`, 'web'],
      [`api.${ROOT}`, 'api'],
    ] as const) {
      const reply = await request(proxy.port, host, { path: '/todos?x=1' });
      expect(reply.status).toBe(200);
      expect(reply.headers['x-upstream']).toBe(expected);
      expect(JSON.parse(reply.body)).toMatchObject({ upstream: expected, url: '/todos?x=1' });
    }
  });

  test('ignores a :port suffix on the Host header when routing', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    const reply = await request(proxy.port, `web.${ROOT}:8443`);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).host).toBe(`web.${ROOT}:8443`);
  });

  test('404s the bare domain when no entry is `*`', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    expect((await request(proxy.port, ROOT)).status).toBe(404);
  });

  test('`*` takes every other host under the domain: the bare domain and any depth of subdomain', async () => {
    const web = await upstream('web');
    const api = await upstream('api');
    const proxy = await proxyFor([
      route(`api.${ROOT}`, 'api', api.port),
      { subdomain: ['*'], target: pkg('web', web.port) },
    ]);
    proxy.bindSession(stubManager({ web: 'running', api: 'running' }));
    for (const [host, expected] of [
      [ROOT, 'web'],
      [`ghost.${ROOT}`, 'web'],
      [`a.b.c.${ROOT}`, 'web'],
      [`x.api.${ROOT}`, 'web'],
      [`api.${ROOT}`, 'api'],
    ] as const) {
      const reply = await request(proxy.port, host);
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toMatchObject({ upstream: expected, host });
    }
    // A host under no domain is nobody's, `*` or not.
    expect((await request(proxy.port, 'web.other.test')).status).toBe(404);
  });

  test('a multi-label subdomain is exact: not a host under it, nor the shorter one', async () => {
    const v2 = await upstream('v2');
    const proxy = await proxyFor([route(`v2.api.${ROOT}`, 'v2', v2.port)]);
    proxy.bindSession(stubManager({ v2: 'running' }));
    expect((await request(proxy.port, `v2.api.${ROOT}`)).status).toBe(200);
    expect((await request(proxy.port, `x.v2.api.${ROOT}`)).status).toBe(404);
    expect((await request(proxy.port, `api.${ROOT}`)).status).toBe(404);
  });

  test.each([`ghost.${ROOT}`, `a.web.${ROOT}`, 'web.other.test', 'localhost'])(
    '404s %s, linking each host a route names once, on the public address',
    async (host) => {
      const web = await upstream('web');
      const api = await upstream('api');
      const proxy = await proxyFor(
        [
          { subdomain: ['web', 'www'], target: pkg('web', web.port) },
          route(`api.${ROOT}`, 'api', api.port),
          route(`legacy-api.${ROOT}`, 'api', api.port),
        ],
        { publicAddress: { scheme: 'https', port: undefined } },
      );
      proxy.bindSession(stubManager({ web: 'running', api: 'running' }));
      const reply = await request(proxy.port, host, { headers: { accept: 'text/html' } });
      expect(reply.status).toBe(404);
      expect(reply.headers['content-type']).toMatch(/^text\/html/);
      expect(reply.body.match(/href="[^"]+"/g)).toEqual([
        `href="https://web.${ROOT}"`,
        `href="https://www.${ROOT}"`,
        `href="https://api.${ROOT}"`,
        `href="https://legacy-api.${ROOT}"`,
      ]);
      expect(reply.body).toContain(host);
      expect(reply.body).not.toContain('<code>*</code>');
      const json = JSON.parse((await request(proxy.port, host)).body);
      expect(json).toMatchObject({ host, routes: [`web.${ROOT}`, `www.${ROOT}`, `api.${ROOT}`, `legacy-api.${ROOT}`], wildcard: false }); // oxfmt-ignore
    },
  );

  test('links on the bound port by default, and notes a `*` entry on the 404 page', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([
      route(`web.${ROOT}`, 'web', web.port),
      byPath(['*'], [['/docs/**', pkg('web', web.port)]]),
    ]);
    proxy.bindSession(stubManager({ web: 'running' }));
    const reply = await request(proxy.port, `ghost.${ROOT}`, { path: '/x', headers: { accept: 'text/html' } }); // oxfmt-ignore
    expect(reply.status).toBe(404);
    expect(reply.body).toContain(`href="http://web.${ROOT}:${String(proxy.port)}"`);
    expect(reply.body).toContain(`The <code>*</code> route takes every host under <code>${ROOT}</code> that no other route names, the bare domain included.`); // oxfmt-ignore
  });
});

// A `paths` entry routes its hosts by path: the first glob that matches wins, and a path no glob
// matches is a 404, never another entry's.
describe('routing by path', () => {
  /** api at its own subdomain; `app` by path; every other host by path, web last. */
  async function routed() {
    const web = await upstream('web');
    const docs = await upstream('docs');
    const v2 = await upstream('v2');
    const api = await upstream('api');
    const admin = await upstream('admin');
    const proxy = await proxyFor(
      [
        route(`api.${ROOT}`, 'api', api.port),
        byPath(
          ['app'],
          [
            ['/admin/**', pkg('admin', admin.port)],
            ['/**', pkg('web', web.port)],
          ],
        ),
        byPath(
          ['*'],
          [
            ['/docs/**', pkg('docs', docs.port)],
            ['/api/v2/**', pkg('v2', v2.port)],
            ['/api/**', pkg('api', api.port)],
            ['/**', pkg('web', web.port)],
          ],
        ),
      ],
      { domainAliases: ['example.localhost'] },
    );
    const manager = stubManager({ web: 'running', docs: 'running', v2: 'running', api: 'running', admin: 'running' }); // oxfmt-ignore
    proxy.bindSession(manager);
    return { proxy, manager };
  }

  test.each([
    [ROOT, '/docs', 'docs'],
    [ROOT, '/docs/', 'docs'],
    [ROOT, '/docs/users?page=2', 'docs'],
    [ROOT, '/docs?tab=1', 'docs'],
    [ROOT, '/docsite', 'web'],
    // The first glob that matches wins, in the order written.
    [ROOT, '/api/v2/x', 'v2'],
    [ROOT, '/api/x', 'api'],
    [ROOT, '/api', 'api'],
    [ROOT, '/apix', 'web'],
    [ROOT, '/x', 'web'],
    [ROOT, '/', 'web'],
    // Dot segments match like any other: Vite's prebundled deps, a well-known path.
    [ROOT, '/node_modules/.vite/deps/react.js', 'web'],
    [ROOT, '/.well-known/x', 'web'],
    [ROOT, '/docs/.hidden', 'docs'],
    // The query string is no part of the match.
    [ROOT, '/x?next=/docs/a', 'web'],
    [`ghost.${ROOT}`, '/docs/x', 'docs'],
    [`a.b.${ROOT}`, '/api/v2/x', 'v2'],
    ['example.localhost', '/docs', 'docs'],
    ['ghost.example.localhost', '/', 'web'],
    // A host a `service` entry claims keeps every path of it.
    [`api.${ROOT}`, '/docs/x', 'api'],
    // A non-`*` `paths` entry routes its own host by its own globs.
    [`app.${ROOT}`, '/admin/users', 'admin'],
    [`app.${ROOT}`, '/docs/x', 'web'],
    [`app.example.localhost`, '/admin', 'admin'],
  ])('routes %s%s to %s, the path unchanged', async (host, path, expected) => {
    const { proxy } = await routed();
    const reply = await request(proxy.port, host, { path });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ upstream: expected, host, url: path, custom: null });
  });

  test("with `/**` first, every path is that service's", async () => {
    const web = await upstream('web');
    const api = await upstream('api');
    const proxy = await proxyFor([
      byPath(
        ['*'],
        [
          ['/**', pkg('web', web.port)],
          ['/api/**', pkg('api', api.port)],
        ],
      ),
    ]);
    proxy.bindSession(stubManager({ web: 'running', api: 'running' }));
    for (const path of ['/api/x', '/api', '/x']) {
      expect(JSON.parse((await request(proxy.port, ROOT, { path })).body).upstream).toBe('web');
    }
  });

  test('404s a path no glob matches, never trying a later entry', async () => {
    const web = await upstream('web');
    const docs = await upstream('docs');
    const proxy = await proxyFor([
      byPath(['app'], [['/docs/**', pkg('docs', docs.port)]]),
      { subdomain: ['*'], target: pkg('web', web.port) },
    ]);
    proxy.bindSession(stubManager({ web: 'running', docs: 'running' }));
    expect((await request(proxy.port, `app.${ROOT}`, { path: '/docs/a' })).status).toBe(200);
    const reply = await request(proxy.port, `app.${ROOT}`, { path: '/elsewhere?x=1' });
    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.body)).toMatchObject({
      error: `Nothing is routed at app.${ROOT}/elsewhere`,
      host: `app.${ROOT}`,
      path: '/elsewhere',
      globs: ['/docs/**'],
      routes: [`app.${ROOT}`],
      wildcard: true,
    });
    const html = await request(proxy.port, `app.${ROOT}`, { path: '/elsewhere', headers: { accept: 'text/html' } }); // oxfmt-ignore
    expect(html.body).toContain(`<code>app.${ROOT}</code> is routed by path, and none of its globs matches <code>/elsewhere</code>: <code>/docs/**</code>.`); // oxfmt-ignore
  });

  test('404s a `*` entry with no `/**` for an unmatched path', async () => {
    const docs = await upstream('docs');
    const proxy = await proxyFor([byPath(['*'], [['/docs/**', pkg('docs', docs.port)]])]);
    proxy.bindSession(stubManager({ docs: 'running' }));
    expect((await request(proxy.port, ROOT, { path: '/x' })).status).toBe(404);
  });

  test('404s a host under no domain, path or not', async () => {
    const { proxy } = await routed();
    for (const host of ['web.other.test', 'localhost']) {
      expect((await request(proxy.port, host, { path: '/docs' })).status).toBe(404);
    }
  });

  test("answers a path route's 503 for its own service, naming the host and glob", async () => {
    const { proxy, manager } = await routed();
    manager.set('docs', 'stopped');
    const reply = await request(proxy.port, `ghost.${ROOT}`, { path: '/docs/users', headers: { accept: 'text/html' } }); // oxfmt-ignore
    expect(reply.status).toBe(503);
    expect(reply.body).toContain(`<code>ghost.${ROOT}/docs/**</code> routes to the service <code>docs</code>`); // oxfmt-ignore
    // The other targets are up all along: their paths are unaffected.
    expect((await request(proxy.port, ROOT, { path: '/x' })).status).toBe(200);
    manager.set('web', 'stopped');
    const json = JSON.parse((await request(proxy.port, ROOT, { path: '/x' })).body);
    expect(json).toMatchObject({ service: 'web', status: 'stopped', host: ROOT });
  });

  test('holds a path route for readiness like any other', async () => {
    const docs = await upstream('docs');
    const proxy = await proxyFor([byPath(['*'], [['/docs/**', pkg('docs', docs.port, true)]])]);
    const manager = stubManager({ docs: 'running' });
    proxy.bindSession(manager);
    const pending = request(proxy.port, ROOT, { path: '/docs/x' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    manager.setReady('docs', true);
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).upstream).toBe('docs');
  });

  test('routes websocket upgrades the same way, as hot reload needs', async () => {
    const { proxy } = await routed();
    for (const [host, path, expected] of [
      [ROOT, '/docs/hmr', 'docs'],
      [ROOT, '/hmr', 'web'],
      [`ghost.${ROOT}`, '/api/v2/socket?token=1', 'v2'],
      [`api.${ROOT}`, '/docs/hmr', 'api'],
      [`app.${ROOT}`, '/admin/hmr', 'admin'],
    ] as const) {
      const { socket, res } = await upgrade(proxy.port, host, path);
      expect(res.headers['x-upstream']).toBe(expected);
      socket.destroy();
    }
  });

  test('drops an upgrade no glob matches', async () => {
    const docs = await upstream('docs');
    const proxy = await proxyFor([byPath(['*'], [['/docs/**', pkg('docs', docs.port)]])]);
    proxy.bindSession(stubManager({ docs: 'running' }));
    // The proxy destroys the socket without answering: the client sees the connection reset.
    await expect(upgrade(proxy.port, ROOT, '/hmr')).rejects.toThrow('socket hang up');
  });

  test('logs each host and glob under the listener, in route order, with a note for `*`', async () => {
    const { proxy, manager } = await routed();
    const [attrs, message] = manager.logged[0]!;
    expect(Object.keys(attrs)).toEqual([
      `api.${ROOT}`,
      `app.${ROOT}/admin/**`,
      `app.${ROOT}/**`,
      '*/docs/**',
      '*/api/v2/**',
      '*/api/**',
      '*/**',
    ]);
    expect(attrs['*/docs/**']).toMatch(/^docs :\d+$/);
    expect(message).toBe(`dev reverse proxy listening on 127.0.0.1:${String(proxy.port)} — \`*\` is every other host`); // oxfmt-ignore
  });

  test('reports its routes as `reverseProxy.routes` resolves them', async () => {
    const { proxy } = await routed();
    expect(proxy.routes).toEqual([
      { subdomain: ['api'], service: 'api' },
      { subdomain: ['app'], paths: { '/admin/**': 'admin', '/**': 'web' } },
      { subdomain: ['*'], paths: { '/docs/**': 'docs', '/api/v2/**': 'v2', '/api/**': 'api', '/**': 'web' } }, // oxfmt-ignore
    ]);
  });
});

describe('globMatcher and pathnameOf', () => {
  test('`/x/**` matches `/x`, `/x/` and everything under it, never `/xy`', () => {
    const api = globMatcher('/api/**');
    expect(api('/api')).toBe(true);
    expect(api('/api/')).toBe(true);
    expect(api('/api/a/b')).toBe(true);
    expect(api('/apix')).toBe(false);
    expect(api('/x/api')).toBe(false);
  });

  test('matches dot segments, and `*` within one segment only', () => {
    expect(globMatcher('/**')('/.well-known/x')).toBe(true);
    expect(globMatcher('/**')('/node_modules/.vite/deps/react.js')).toBe(true);
    expect(globMatcher('/**')('/')).toBe(true);
    expect(globMatcher('/docs/*')('/docs/a')).toBe(true);
    expect(globMatcher('/docs/*')('/docs/a/b')).toBe(false);
    expect(globMatcher('/assets/*.js')('/assets/app.js')).toBe(true);
  });

  test('take the path of an origin-form or absolute-form target, without its query', () => {
    expect(pathnameOf('/docs?x=1')).toBe('/docs');
    expect(pathnameOf('/docs#top')).toBe('/docs');
    expect(pathnameOf(`http://${ROOT}/docs/x?y`)).toBe('/docs/x');
    expect(pathnameOf(undefined)).toBe('/');
    expect(pathnameOf('*')).toBe('/');
  });
});

// A domain alias routes exactly like the canonical domain, while everything the proxy reports
// (the 404 page's links, the log) stays under the canonical one.
describe('domain aliases', () => {
  const ALIAS = 'example.localhost';

  test('routes subdomains, and `*` on the bare alias, forwarding Host unchanged', async () => {
    const web = await upstream('web');
    const api = await upstream('api');
    const proxy = await proxyFor(
      [
        { subdomain: ['web', 'www'], target: pkg('web', web.port) },
        route(`api.${ROOT}`, 'api', api.port),
        { subdomain: ['*'], target: pkg('web', web.port) },
      ],
      { domainAliases: [ALIAS] },
    );
    proxy.bindSession(stubManager({ web: 'running', api: 'running' }));

    for (const [host, expected] of [
      [`web.${ALIAS}`, 'web'],
      [`www.${ALIAS}`, 'web'],
      [ALIAS, 'web'],
      [`ghost.${ALIAS}`, 'web'],
      [`api.${ALIAS}:${String(proxy.port)}`, 'api'],
      [`api.${ROOT}`, 'api'],
    ] as const) {
      const reply = await request(proxy.port, host);
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toMatchObject({ upstream: expected, host });
    }
    expect(proxy.domains).toEqual([ROOT, ALIAS]);
  });

  test('routes every `publicAddress.domain` of a config, the aliases included', async () => {
    const web = await upstream('web');
    const docs = await upstream('docs');
    const config = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: [ROOT, ALIAS], scheme: 'https' },
        routes: [
          { subdomain: 'web', service: 'web' },
          { subdomain: '*', service: 'docs' },
        ],
      },
      services: { web: { port: web.port }, docs: { port: docs.port } },
    });
    const { publicAddress } = config.reverseProxy!;
    // As a session starts it: the canonical domain, the rest as aliases.
    const proxy = await startDevReverseProxy({
      port: 0,
      domain: publicAddress.domain,
      domainAliases: publicAddress.domains.slice(1),
      routes: routesFromConfig(config),
      publicAddress,
    });
    cleanups.push(() => proxy.close());
    proxy.bindSession(stubManager({ web: 'running', docs: 'running' }));
    for (const [host, expected] of [
      [`web.${ROOT}`, 'web'],
      [`web.${ALIAS}`, 'web'],
      [ALIAS, 'docs'],
      [`unknown.${ALIAS}`, 'docs'],
    ] as const) {
      const reply = await request(proxy.port, host);
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toMatchObject({ upstream: expected, host });
    }
    expect((await request(proxy.port, 'web.elsewhere.test')).status).toBe(404);
  });

  test('answers the status pages under the alias, naming the host asked for', async () => {
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', await deadPort())], {
      domainAliases: [ALIAS],
    });
    proxy.bindSession(stubManager({ web: 'stopped' }));
    const reply = await request(proxy.port, `web.${ALIAS}`);
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ service: 'web', status: 'stopped', host: `web.${ALIAS}` }); // oxfmt-ignore
  });

  test('routes an infra service under the alias once the infra is up', async () => {
    const mail = await upstream('mail');
    const proxy = await proxyFor([serviceRoute(`mail.${ROOT}`, 'mail', mail.port)], {
      domainAliases: [ALIAS],
    });
    expect((await request(proxy.port, `mail.${ALIAS}`)).status).toBe(503);
    proxy.markInfraReady();
    const reply = await request(proxy.port, `mail.${ALIAS}`);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ upstream: 'mail', host: `mail.${ALIAS}` });
  });

  test('carries a websocket under the alias', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)], {
      domainAliases: [ALIAS],
    });
    proxy.bindSession(stubManager({ web: 'running' }));
    const { socket, res } = await upgrade(proxy.port, `web.${ALIAS}`);
    expect(res.headers['x-upstream']).toBe('web');
    const echoed = new Promise<string>((resolve) => socket.once('data', (d: Buffer) => resolve(d.toString()))); // oxfmt-ignore
    socket.write('ping');
    expect(await echoed).toBe('ping');
  });

  test.each([`ghost.${ALIAS}`, 'web.other.test', `web.${ALIAS}.evil.test`, `web.x${ALIAS}`])(
    '404s %s, listing only the canonical links',
    async (host) => {
      const web = await upstream('web');
      const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)], {
        domainAliases: [ALIAS],
        publicAddress: { scheme: 'http', port: 4000 },
      });
      proxy.bindSession(stubManager({ web: 'running' }));
      const reply = await request(proxy.port, host, { headers: { accept: 'text/html' } });
      expect(reply.status).toBe(404);
      expect(reply.body).toContain(`href="http://web.${ROOT}:4000"`);
      expect(reply.body).not.toContain(`href="http://web.${ALIAS}`);
      // The page names every domain it answers under.
      expect(reply.body).toContain(`<code>${ROOT}</code>, <code>${ALIAS}</code>`);
    },
  );
});

describe('forwarding', () => {
  test('preserves the Host header and round-trips a custom header both ways', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    const reply = await request(proxy.port, `web.${ROOT}`, { headers: { 'x-custom': 'abc' } });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ host: `web.${ROOT}`, custom: 'abc' });
    expect(reply.headers['x-custom-echo']).toBe('abc');
    expect(reply.headers['x-upstream']).toBe('web');
  });

  test('streams a chunked response incrementally, before the upstream ends it', async () => {
    let finish!: () => void;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first chunk\n');
      finish = () => res.end('last chunk\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    server.on('connection', (socket) => {
      cleanups.push(() => {
        socket.destroy();
      });
    });
    const port = (server.address() as net.AddressInfo).port;

    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', port)]);
    proxy.bindSession(stubManager({ web: 'running' }));

    const chunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxy.port, path: '/stream', headers: { host: `web.${ROOT}` } },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => chunks.push(chunk));
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end();
    });
    // The first chunk must reach the client while the upstream response is still open.
    await vi.waitFor(() => expect(chunks.join('')).toContain('first chunk'));
    expect(chunks.join('')).not.toContain('last chunk');
    finish();
    await done;
    expect(chunks.join('')).toBe('first chunk\nlast chunk\n');
  });

  test('reaches an upstream that bound only the IPv6 loopback, as Vite does', async () => {
    // Vite on a modern Node listens on `[::1]` alone; a proxy pinned to 127.0.0.1 is refused.
    const server = http.createServer((_req, res) => res.end('v6'));
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(0, '::1', () => resolve(true));
    });
    if (!bound) {
      return; // no IPv6 loopback on this machine — nothing to assert
    }
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    server.on('connection', (socket) => {
      cleanups.push(() => {
        socket.destroy();
      });
    });
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    const reply = await request(proxy.port, `web.${ROOT}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('v6');
  });

  test('opens at most UPSTREAM_MAX_SOCKETS connections to an upstream, however many requests arrive at once', async () => {
    // A wave of page loads (hundreds of modules over HTTP/2 through a TLS terminator) must not
    // become hundreds of simultaneous dials: past the listen backlog (128 on macOS) the kernel
    // resets them, and each becomes a 502. Requests beyond the cap wait for a free socket.
    let open = 0;
    let maxOpen = 0;
    const server = http.createServer((_req, res) => {
      setTimeout(() => res.end('ok'), 30);
    });
    server.on('connection', (socket) => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      socket.on('close', () => open--);
      cleanups.push(() => {
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', port)]);
    proxy.bindSession(stubManager({ web: 'running' }));

    // The client stays under the proxy's own backlog, as a terminator's connection pool would.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });
    cleanups.push(() => agent.destroy());
    const replies = await Promise.all(
      Array.from(
        { length: 300 },
        () =>
          new Promise<number>((resolve, reject) => {
            const req = http.request(
              { host: '127.0.0.1', port: proxy.port, agent, headers: { host: `web.${ROOT}` } },
              (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
              },
            );
            req.on('error', reject);
            req.end();
          }),
      ),
    );
    expect(replies.filter((status) => status !== 200)).toEqual([]);
    expect(maxOpen).toBeLessThanOrEqual(UPSTREAM_MAX_SOCKETS);
  });

  test('opens at most UPSTREAM_MAX_NEW_SOCKETS connections for requests with a body, however many arrive at once', async () => {
    // Each request with a body gets a connection of its own; a burst of them must queue in the
    // proxy as GETs do, not become hundreds of simultaneous dials.
    let open = 0;
    let maxOpen = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => setTimeout(() => res.end('ok'), 30));
    });
    server.on('connection', (socket) => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      socket.on('close', () => open--);
      cleanups.push(() => {
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', port)]);
    proxy.bindSession(stubManager({ web: 'running' }));

    const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });
    cleanups.push(() => agent.destroy());
    const replies = await Promise.all(
      Array.from(
        { length: 200 },
        () =>
          new Promise<number>((resolve, reject) => {
            const req = http.request(
              {
                host: '127.0.0.1',
                port: proxy.port,
                agent,
                method: 'POST',
                headers: { host: `web.${ROOT}`, 'content-length': '2' },
              },
              (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
              },
            );
            req.on('error', reject);
            req.end('hi');
          }),
      ),
    );
    expect(replies.filter((status) => status !== 200)).toEqual([]);
    expect(maxOpen).toBeLessThanOrEqual(UPSTREAM_MAX_NEW_SOCKETS);
  });

  test("keeps a client's idle connection open past Node's 5 s default, as a terminator's pool expects", async () => {
    // A TLS terminator keeps its connections to the proxy pooled for minutes (Caddy: 2 min). Were
    // the proxy to close an idle one first, a request the terminator sends on it as it closes is
    // reset, and the terminator answers 502.
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(() => agent.destroy());
    const get = () =>
      new Promise<{ status: number; reused: boolean }>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: proxy.port, agent, headers: { host: `web.${ROOT}` } },
          (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    expect(await get()).toEqual({ status: 200, reused: false });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(await get()).toEqual({ status: 200, reused: true });
  }, 15_000);

  test("closes an idle upstream connection itself, before the upstream's announced keep-alive timeout", async () => {
    // Node's servers close an idle connection after 5 s and say so (`Keep-Alive: timeout=5`). A
    // request sent on one as the upstream closes it is reset: the proxy must let go first.
    const server = http.createServer((_req, res) => res.end('ok'));
    server.keepAliveTimeout = 3_000;
    let closedAfterMs: number | undefined;
    let answeredAt = 0;
    server.on('request', (_req, res) => res.on('finish', () => (answeredAt = Date.now())));
    server.on('connection', (socket) => {
      socket.on('close', () => (closedAfterMs = Date.now() - answeredAt));
      cleanups.push(() => {
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', port)]);
    proxy.bindSession(stubManager({ web: 'running' }));

    expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(200);
    await vi.waitFor(() => expect(closedAfterMs).toBeDefined(), { timeout: 3_500 });
    expect(closedAfterMs).toBeLessThan(2_500);
  });

  test('closes an idle upstream connection after 5 s when the upstream announces no timeout', async () => {
    // Servers other than Node's close idle connections when they choose, without saying when.
    // The pool keeps one long enough for a page load's burst and the next navigation.
    let closedAfterMs: number | undefined;
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
        const answeredAt = Date.now();
        socket.on('close', () => (closedAfterMs = Date.now() - answeredAt));
      });
      socket.on('end', () => socket.end());
      socket.on('error', () => {});
      cleanups.push(() => {
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', port)]);
    proxy.bindSession(stubManager({ web: 'running' }));

    expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(200);
    await vi.waitFor(() => expect(closedAfterMs).toBeDefined(), { timeout: 7_000 });
    expect(closedAfterMs).toBeGreaterThanOrEqual(4_500);
    expect(closedAfterMs).toBeLessThan(6_500);
  }, 10_000);

  test('a connection the upstream closes while idle leaves the pool: the next request dials anew', async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
        setTimeout(() => socket.end(), 100);
      });
      socket.on('error', () => {});
      cleanups.push(() => {
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', port)]);
    proxy.bindSession(stubManager({ web: 'running' }));

    expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(200);
    expect(connections).toBe(2);
  });

  describe('an upstream that drops a request as it arrives', () => {
    // The keep-alive race, made certain: each connection `drops` says so is destroyed when its
    // nth request arrives, before answering it. Every other request is answered, and each body
    // received is kept, by connection.
    async function droppingUpstream(drops: (connection: number, request: number) => boolean) {
      const bodies: string[][] = [];
      const server = net.createServer((socket) => {
        const nth = bodies.push([]);
        let buffered = '';
        socket.on('data', (chunk) => {
          buffered += chunk.toString('latin1');
          while (buffered.includes('\r\n\r\n')) {
            const end = buffered.indexOf('\r\n\r\n') + 4;
            const head = buffered.slice(0, end);
            const length = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? 0);
            if (buffered.length < end + length) {
              return;
            }
            const received = bodies[nth - 1]!;
            received.push(buffered.slice(end, end + length));
            buffered = buffered.slice(end + length);
            if (drops(nth, received.length)) {
              socket.destroy();
              return;
            }
            socket.write(
              'HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\nok',
            );
          }
        });
        socket.on('error', () => {});
        cleanups.push(() => {
          socket.destroy();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      return { port: (server.address() as net.AddressInfo).port, bodies };
    }

    test('a request with a body goes out on a connection of its own; a GET dropped on a reused one is sent again', async () => {
      const upstream = await droppingUpstream((connection, nth) => connection === 1 && nth === 2);
      const proxy = await proxyFor([route(`web.${ROOT}`, 'web', upstream.port)]);
      proxy.bindSession(stubManager({ web: 'running' }));
      expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(200);
      const post = await request(proxy.port, `web.${ROOT}`, {
        method: 'POST',
        headers: { 'content-length': '5' },
        body: 'hello',
      });
      expect(post.status).toBe(200);
      expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(200);
      expect(upstream.bodies).toEqual([['', ''], ['hello'], ['']]);
    });

    test('a service the session does not run: a GET dropped on a reused connection is sent again', async () => {
      const upstream = await droppingUpstream((connection, nth) => connection === 1 && nth === 2);
      const proxy = await proxyFor([route(`web.${ROOT}`, 'web', upstream.port)]);
      proxy.bindSession(stubManager({}));
      expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(200);
      expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(200);
      expect(upstream.bodies).toEqual([['', ''], ['']]);
    });

    test('one dropped on a new connection is not sent again: 502', async () => {
      const upstream = await droppingUpstream(() => true);
      const proxy = await proxyFor([route(`web.${ROOT}`, 'web', upstream.port)]);
      proxy.bindSession(stubManager({ web: 'running' }));
      expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(502);
      expect(upstream.bodies).toHaveLength(1);
    });
  });

  test('turns an upstream refusing the connection into a 502 naming the package and port', async () => {
    const port = await deadPort();
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    const reply = await request(proxy.port, `web.${ROOT}`, { headers: { accept: 'text/html' } });
    expect(reply.status).toBe(502);
    expect(reply.headers['retry-after']).toBe('1');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.body).toContain('web');
    expect(reply.body).toContain(String(port));
  });
});

describe('a pooled connection the upstream resets', () => {
  // An upstream that answers the first request on each connection and resets the connection on
  // the next, as one that closed an idle connection just as a request went out on it.
  async function resetsReusedConnections() {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      let requests = 0;
      socket.on('data', () => {
        requests++;
        if (requests === 1) {
          socket.write('HTTP/1.1 200 OK\r\nconnection: keep-alive\r\ncontent-length: 2\r\n\r\nok');
        } else {
          socket.resetAndDestroy();
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return {
      port: (server.address() as net.AddressInfo).port,
      connections: () => connections,
    };
  }

  test('sends a bodyless request once more, on a new connection', async () => {
    const upstream = await resetsReusedConnections();
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', upstream.port)]);
    proxy.markInfraReady();
    expect((await request(proxy.port, `s3.${ROOT}`)).status).toBe(200);
    const second = await request(proxy.port, `s3.${ROOT}`);
    expect(second.status).toBe(200);
    expect(second.body).toBe('ok');
    expect(upstream.connections()).toBe(2);
  });

  test('a connection handed straight to a request waiting for one counts as reused', async () => {
    // Every connection answers its first request only once the pool is full, so one request more
    // waits, and takes over the first connection freed. That connection resets it.
    let connections = 0;
    let released = false;
    const held: (() => void)[] = [];
    const server = net.createServer((socket) => {
      connections++;
      let requests = 0;
      socket.on('data', () => {
        requests++;
        if (requests > 1) {
          socket.resetAndDestroy();
          return;
        }
        const answer = () =>
          socket.write('HTTP/1.1 200 OK\r\nconnection: keep-alive\r\ncontent-length: 2\r\n\r\nok');
        if (released) {
          answer();
          return;
        }
        held.push(answer);
        if (held.length === UPSTREAM_MAX_SOCKETS) {
          // Long enough for the request past the cap to reach the proxy's queue.
          setTimeout(() => {
            released = true;
            for (const each of held) {
              each();
            }
          }, 200);
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', port)]);
    proxy.markInfraReady();

    const replies = await Promise.all(
      Array.from({ length: UPSTREAM_MAX_SOCKETS + 1 }, () => request(proxy.port, `s3.${ROOT}`)),
    );
    expect(replies.map((reply) => reply.status)).toEqual(
      Array.from({ length: UPSTREAM_MAX_SOCKETS + 1 }, () => 200),
    );
    // The pool's connections, and the one the retry opened.
    expect(connections).toBe(UPSTREAM_MAX_SOCKETS + 1);
  });

  test("a reset on the retry's new connection is the 502", async () => {
    // Every connection after the first is reset at once: the retry finds nothing there either.
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      if (connections > 1) {
        socket.resetAndDestroy();
        return;
      }
      let requests = 0;
      socket.on('data', () => {
        requests++;
        if (requests === 1) {
          socket.write('HTTP/1.1 200 OK\r\nconnection: keep-alive\r\ncontent-length: 2\r\n\r\nok');
        } else {
          socket.resetAndDestroy();
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', port)]);
    proxy.markInfraReady();
    expect((await request(proxy.port, `s3.${ROOT}`)).status).toBe(200);
    expect((await request(proxy.port, `s3.${ROOT}`)).status).toBe(502);
    expect(connections).toBe(2);
  });
});

describe('h2c (HTTP/2 without TLS) on the same port', () => {
  /** A cleartext HTTP/2 session to the proxy, closed after the test. */
  function h2session(proxyPort: number): http2.ClientHttp2Session {
    const session = http2.connect(`http://127.0.0.1:${String(proxyPort)}`);
    session.on('error', () => {});
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          // A session the server already closed never calls back.
          if (session.closed || session.destroyed) {
            resolve();
          } else {
            session.close(() => resolve());
          }
        }),
    );
    return session;
  }

  /** One request on `session`, with `host` as `:authority`. */
  function h2request(
    session: http2.ClientHttp2Session,
    host: string,
    opts: { path?: string; headers?: Record<string, string>; method?: string; body?: string } = {},
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const stream = session.request({
        ':method': opts.method ?? 'GET',
        ':path': opts.path ?? '/',
        ':authority': host,
        ...opts.headers,
      });
      let status = 0;
      let headers: http.IncomingHttpHeaders = {};
      let body = '';
      stream.setEncoding('utf8');
      stream.on('response', (h) => {
        status = Number(h[':status']);
        headers = h as http.IncomingHttpHeaders;
      });
      stream.on('data', (chunk: string) => (body += chunk));
      stream.on('end', () => resolve({ status, headers, body }));
      stream.on('error', reject);
      stream.end(opts.body);
    });
  }

  test('multiplexes many requests over one connection, each reaching the upstream with its Host and headers', async () => {
    // A TLS terminator that speaks h2c to the proxy sends a whole page load's requests as
    // streams of one connection, instead of opening a connection per request.
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    const session = h2session(proxy.port);
    const replies = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        h2request(session, `web.${ROOT}`, {
          path: `/m${String(i)}`,
          headers: { 'x-custom': 'abc' },
        }),
      ),
    );
    expect(replies.filter((r) => r.status !== 200)).toEqual([]);
    expect(JSON.parse(replies[7]!.body)).toMatchObject({
      host: `web.${ROOT}`,
      url: '/m7',
      custom: 'abc',
    });
    expect(replies[7]!.headers['x-custom-echo']).toBe('abc');
  });

  test('answers the status pages over h2c too', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'stopped' }));
    const reply = await h2request(h2session(proxy.port), `web.${ROOT}`);
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ service: 'web', status: 'stopped' });
    expect(reply.headers['retry-after']).toBe('2');
  });

  test('tells the protocols apart when the first bytes arrive in pieces', async () => {
    // The proxy reads a connection's first bytes to choose its protocol, then hands the socket to
    // the server for it with those bytes put back: nothing may be lost when they come in pieces.
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50));

    const h1 = net.connect(proxy.port, '127.0.0.1');
    cleanups.push(() => {
      h1.destroy();
    });
    let h1reply = '';
    h1.setEncoding('latin1');
    h1.on('data', (d: string) => (h1reply += d));
    await new Promise((resolve) => h1.once('connect', resolve));
    h1.write('GE');
    await pause();
    h1.write(`T / HTTP/1.1\r\nhost: web.${ROOT}\r\nconnection: close\r\n\r\n`);
    await vi.waitFor(() => expect(h1reply).toMatch(/^HTTP\/1\.1 200/));

    // An HTTP/2 client over a transport that sends its first write (the preface) in two pieces.
    const raw = net.connect(proxy.port, '127.0.0.1');
    let first = true;
    const transport = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        if (!first) {
          raw.write(chunk, callback);
          return;
        }
        first = false;
        raw.write(chunk.subarray(0, 10));
        void pause().then(() => raw.write(chunk.subarray(10), callback));
      },
      destroy(err, callback) {
        raw.destroy();
        callback(err);
      },
    });
    raw.on('data', (d) => transport.push(d));
    raw.on('end', () => transport.push(null));
    const session = http2.connect(`http://127.0.0.1:${String(proxy.port)}`, {
      createConnection: () => transport,
    });
    session.on('error', () => {});
    cleanups.push(() => {
      session.destroy();
      raw.destroy();
    });
    expect((await h2request(session, `web.${ROOT}`)).status).toBe(200);
  });

  test('never resets a stream whose client still holds its request side open', async () => {
    // A terminator may keep a GET's request side open after its headers: Caddy does for a request
    // of unknown length, as an HTTP/3 one without content-length is. Node resets (NO_ERROR) a
    // server stream whose request was never read as soon as its response is written, and on a
    // busy connection the reset can reach the terminator before the response's end, which then
    // drops the response as incomplete. The stream must stay open until the client ends it.
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    const session = h2session(proxy.port);
    const results = await Promise.all(
      Array.from(
        { length: 20 },
        () =>
          new Promise<{ status: number; resetEarly: boolean }>((resolve) => {
            const stream = session.request(
              { ':method': 'GET', ':path': '/', ':authority': `web.${ROOT}` },
              { endStream: false },
            );
            let status = 0;
            let ended = false;
            stream.on('response', (h) => (status = Number(h[':status'])));
            stream.on('error', () => {});
            stream.resume();
            stream.on('close', () => resolve({ status, resetEarly: !ended }));
            setTimeout(() => {
              ended = true;
              stream.end();
            }, 300);
          }),
      ),
    );
    expect(results.filter((r) => r.status !== 200 || r.resetEarly)).toEqual([]);
  });

  test('never resets a stream it answers itself while its client holds the request side open', async () => {
    // The same as above for the proxy's own answers (an unknown host, a package not running), which
    // never read the request either.
    const proxy = await proxyFor([]);
    const session = h2session(proxy.port);
    const result = await new Promise<{ status: number; resetEarly: boolean }>((resolve) => {
      const stream = session.request(
        { ':method': 'GET', ':path': '/', ':authority': `nope.${ROOT}` },
        { endStream: false },
      );
      let status = 0;
      let ended = false;
      stream.on('response', (h) => (status = Number(h[':status'])));
      stream.on('error', () => {});
      stream.resume();
      stream.on('close', () => resolve({ status, resetEarly: !ended }));
      setTimeout(() => {
        ended = true;
        stream.end();
      }, 300);
    });
    expect(result).toEqual({ status: 404, resetEarly: false });
  });

  test('keeps the connection open through thousands of cancelled requests', async () => {
    // Every request a TLS terminator multiplexes shares this one connection, so each page the
    // browser closes or reloads mid-load cancels its in-flight requests on it. Node's defence
    // against "rapid reset" floods would close the whole connection after about a thousand,
    // failing every other request on it.
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    const session = h2session(proxy.port);
    let goaway: number | null = null;
    session.on('goaway', (code) => (goaway = code));
    await Promise.all(
      Array.from(
        { length: 3000 },
        () =>
          new Promise<void>((resolve) => {
            const stream = session.request({
              ':method': 'GET',
              ':path': '/',
              ':authority': `web.${ROOT}`,
            });
            stream.on('error', () => {});
            stream.on('close', () => resolve());
            stream.end();
            setImmediate(() => stream.close(http2.constants.NGHTTP2_CANCEL));
          }),
      ),
    );
    const after = await h2request(session, `web.${ROOT}`);
    expect(goaway).toBeNull();
    expect(after.status).toBe(200);
  });

  test('turns an upstream refusing the connection into the same 502 over h2c', async () => {
    const port = await deadPort();
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    const reply = await h2request(h2session(proxy.port), `web.${ROOT}`);
    expect(reply.status).toBe(502);
    expect(reply.headers['retry-after']).toBe('1');
  });

  test('forwards to a routed service the session does not run, and answers its 503 when nothing listens', async () => {
    const web = await upstream('web');
    const port = await deadPort();
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port), route(`api.${ROOT}`, 'api', port)]); // oxfmt-ignore
    proxy.bindSession(stubManager({}));
    const session = h2session(proxy.port);
    const up = await h2request(session, `web.${ROOT}`, { path: '/x' });
    expect(up.status).toBe(200);
    expect(JSON.parse(up.body)).toMatchObject({ upstream: 'web', host: `web.${ROOT}`, url: '/x' });
    const down = await h2request(session, `api.${ROOT}`);
    expect(down.status).toBe(503);
    expect(down.headers['retry-after']).toBe('2');
    expect(JSON.parse(down.body)).toMatchObject({ service: 'api', port });
    const post = await h2request(session, `api.${ROOT}`, { method: 'POST', body: 'x'.repeat(256 * 1024) }); // oxfmt-ignore
    expect(post.status).toBe(503);
    expect(JSON.parse(post.body)).toMatchObject({ service: 'api', port, code: 'ECONNREFUSED' });
  });

  test('keeps serving HTTP/1.1 and websocket upgrades on the same port', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    h2session(proxy.port); // an h2c connection open alongside
    expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(200);
    const { res } = await upgrade(proxy.port, `web.${ROOT}`);
    expect(res.statusCode).toBe(101);
  });
});

describe('websockets', () => {
  test('echoes through a raw upgrade on both sides', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'running' }));
    const { socket, res } = await upgrade(proxy.port, `web.${ROOT}`);
    expect(res.statusCode).toBe(101);
    expect(res.headers['x-upstream']).toBe('web');

    const echoed = new Promise<string>((resolve) => {
      socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    });
    socket.write('ping');
    expect(await echoed).toBe('ping');
  });

  test('destroys the socket for a package that is not running', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'stopped' }));
    await expect(upgrade(proxy.port, `web.${ROOT}`)).rejects.toThrow('socket hang up');
  });

  test('closing the proxy destroys an open websocket', async () => {
    const web = await upstream('web');
    const proxy = await startDevReverseProxy({
      port: 0,
      domain: ROOT,
      routes: [route(`web.${ROOT}`, 'web', web.port)],
    });
    proxy.bindSession(stubManager({ web: 'running' }));
    const { socket } = await upgrade(proxy.port, `web.${ROOT}`);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await proxy.close();
    await expect(closed).resolves.toBeUndefined();
  });
});

describe('status-aware responses', () => {
  test.each(['stopped', 'waiting', 'restarting'] as const)(
    'replies 503 for a %s package, as HTML when the request accepts it',
    async (status) => {
      const web = await upstream('web');
      const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)], {
        controlApiPort: 14001,
      });
      proxy.bindSession(stubManager({ web: status }));
      const html = await request(proxy.port, `web.${ROOT}`, {
        headers: { accept: 'text/html,application/xhtml+xml' },
      });
      expect(html.status).toBe(503);
      expect(html.headers['retry-after']).toBe('2');
      expect(html.headers['cache-control']).toBe('no-store');
      expect(html.headers['content-type']).toMatch(/^text\/html/);
      expect(html.body).toContain('web');
      expect(html.body).toContain(status);
      expect(html.body).toContain('/command/service/restart/web');
      expect(html.body).toContain('14001');
    },
  );

  test('replies 503 as JSON when the request does not accept HTML', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'stopped' }));
    const json = await request(proxy.port, `web.${ROOT}`, {
      headers: { accept: 'application/json' },
    });
    expect(json.status).toBe(503);
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(json.body)).toMatchObject({ service: 'web', status: 'stopped' });
  });

  test('replies 503 "starting" before a manager is attached', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    const reply = await request(proxy.port, `web.${ROOT}`);
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ service: 'web', status: 'starting' });
  });

  test('proxies straight through a running package with no healthcheck', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port, false)]);
    const manager = stubManager({ web: 'running' });
    proxy.bindSession(manager);
    expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(200);
  });

  test('holds a request to a running-but-not-ready package, then serves it once ready', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port, true)]);
    const manager = stubManager({ web: 'running' });
    proxy.bindSession(manager);

    let settled = false;
    const pending = request(proxy.port, `web.${ROOT}`).then((reply) => {
      settled = true;
      return reply;
    });
    // Still held after a moment: nothing has said the package is ready.
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);

    manager.setReady('web', true);
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(reply.headers['x-upstream']).toBe('web');
  });

  test('gives up the hold after the deadline with a 503 "starting"', async () => {
    const web = await upstream('web');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port, true)]);
    const manager = stubManager({ web: 'running' });
    // The proxy subscribes to the manager the moment it starts holding a request — that's the
    // signal the request has arrived (real I/O) and the deadline timer (faked) is registered.
    const held = new Promise<void>((resolve) => {
      const subscribe = manager.subscribe.bind(manager);
      manager.subscribe = (listener) => {
        resolve();
        return subscribe(listener);
      };
    });
    proxy.bindSession(manager);

    const pending = request(proxy.port, `web.${ROOT}`, { headers: { accept: 'text/html' } });
    await held;
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();

    const reply = await pending;
    expect(reply.status).toBe(503);
    expect(reply.headers['retry-after']).toBe('2');
    expect(reply.body).toContain('starting');
  });

  test('re-checks the status after the hold: a package stopped meanwhile gets the 503', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port, true)]);
    const manager = stubManager({ web: 'running' });
    proxy.bindSession(manager);
    const pending = request(proxy.port, `web.${ROOT}`, { headers: { accept: 'application/json' } });
    await new Promise((r) => setTimeout(r, 100));
    manager.set('web', 'stopped');
    const reply = await pending;
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ service: 'web', status: 'stopped' });
  });

  test('logs one stackctl entry when a session is bound: the listener as the message, one route per attr', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([{ subdomain: ['web', 'www'], target: pkg('web', web.port) }]);
    const manager = stubManager({ web: 'running' });
    proxy.bindSession(manager);
    expect(manager.logged).toHaveLength(1);
    const [attrs, message] = manager.logged[0]!;
    expect(message).toBe(`dev reverse proxy listening on 127.0.0.1:${String(proxy.port)}`);
    // Rendered by the log formatter as `  <host>: <package> :<port>` lines under the message.
    expect(attrs).toEqual({
      [`web.${ROOT}`]: `web :${String(web.port)}`,
      [`www.${ROOT}`]: `web :${String(web.port)}`,
    });
  });
});

describe('a routed service the session does not run', () => {
  /** `web` at its subdomain, `docs` at `/docs/**`, `site` every other path: none in the session. */
  async function outside(ports: { web: number; docs: number; site: number }) {
    const proxy = await proxyFor([
      route(`web.${ROOT}`, 'web', ports.web, true),
      byPath(
        ['*'],
        [
          ['/docs/**', pkg('docs', ports.docs)],
          ['/**', pkg('site', ports.site)],
        ],
      ),
    ]);
    // The session runs only `api`: every other name is not part of it.
    proxy.bindSession(stubManager({ api: 'running' }));
    return proxy;
  }

  test('is forwarded to its port by subdomain and by glob, Host kept', async () => {
    const web = await upstream('web');
    const docs = await upstream('docs');
    const site = await upstream('site');
    const proxy = await outside({ web: web.port, docs: docs.port, site: site.port });
    for (const [host, path, expected] of [
      [`web.${ROOT}`, '/a?b=1', 'web'],
      [ROOT, '/docs/x', 'docs'],
      [`ghost.${ROOT}`, '/pricing', 'site'],
    ] as const) {
      const reply = await request(proxy.port, host, { path, headers: { 'x-custom': 'abc' } });
      expect(reply.status).toBe(200);
      expect(reply.headers['x-custom-echo']).toBe('abc');
      expect(JSON.parse(reply.body)).toEqual({
        upstream: expected,
        host,
        url: path,
        custom: 'abc',
      });
    }
  });

  test('is never held for readiness, healthcheck or not', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port, true)], { readyTimeoutMs: 60_000 }); // oxfmt-ignore
    proxy.bindSession(stubManager({}));
    const started = Date.now();
    expect((await request(proxy.port, `web.${ROOT}`)).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('carries a websocket upgrade through to its port', async () => {
    const web = await upstream('web');
    const docs = await upstream('docs');
    const site = await upstream('site');
    const proxy = await outside({ web: web.port, docs: docs.port, site: site.port });
    for (const [host, path, expected] of [
      [`web.${ROOT}`, '/ws', 'web'],
      [ROOT, '/docs/hmr', 'docs'],
      [ROOT, '/hmr', 'site'],
    ] as const) {
      const { socket, res } = await upgrade(proxy.port, host, path);
      expect(res.statusCode).toBe(101);
      expect(res.headers['x-upstream']).toBe(expected);
      const echoed = new Promise<string>((resolve) => {
        socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
      });
      socket.write('ping');
      expect(await echoed).toBe('ping');
      socket.destroy();
    }
  });

  test('answers 503 as HTML when nothing listens on its port, naming the port', async () => {
    const port = await deadPort();
    const proxy = await outside({ web: port, docs: port, site: port });
    for (const [host, path] of [
      [`web.${ROOT}`, '/'],
      [ROOT, '/docs/x'],
      [`ghost.${ROOT}`, '/'],
    ] as const) {
      const html = await request(proxy.port, host, { path, headers: { accept: 'text/html' } });
      expect(html.status).toBe(503);
      expect(html.headers['retry-after']).toBe('2');
      expect(html.headers['cache-control']).toBe('no-store');
      expect(html.headers['content-type']).toMatch(/^text\/html/);
      expect(html.body).toContain('not part of the running stackctl session');
      expect(html.body).toContain(`nothing is listening on <code>:${String(port)}</code>`);
    }
  });

  test('answers 503 as JSON when nothing listens on its port, naming the port', async () => {
    const port = await deadPort();
    const proxy = await outside({ web: port, docs: port, site: port });
    const json = await request(proxy.port, `web.${ROOT}`, { headers: { accept: 'application/json' } }); // oxfmt-ignore
    expect(json.status).toBe(503);
    expect(json.headers['retry-after']).toBe('2');
    expect(json.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(json.body)).toEqual({
      error: 'web is not running',
      service: 'web',
      status: 'not running',
      host: `web.${ROOT}`,
      port,
      code: 'ECONNREFUSED',
      hint: `not part of the running stackctl session, and nothing is listening on :${String(port)}`,
    });
  });

  test('answers the 503 promptly to a request with a body when nothing listens', async () => {
    const port = await deadPort();
    const proxy = await outside({ web: port, docs: port, site: port });
    const reply = await request(proxy.port, `web.${ROOT}`, { method: 'POST', body: 'x'.repeat(256 * 1024) }); // oxfmt-ignore
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ service: 'web', port });
  });

  /** A port whose listener resets every connection at once, as a container runtime's port forwarder does with nothing behind it. */
  async function resettingPort(): Promise<number> {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return (server.address() as net.AddressInfo).port;
  }

  test('answers the 503 when its port resets a fresh connection, with a body or without', async () => {
    const port = await resettingPort();
    const proxy = await outside({ web: port, docs: port, site: port });
    const get = await request(proxy.port, `web.${ROOT}`, { headers: { accept: 'application/json' } }); // oxfmt-ignore
    expect(get.status).toBe(503);
    expect(JSON.parse(get.body)).toMatchObject({ service: 'web', status: 'not running', port });
    const post = await request(proxy.port, `web.${ROOT}`, { method: 'POST', body: 'x'.repeat(256 * 1024) }); // oxfmt-ignore
    expect(post.status).toBe(503);
    expect(JSON.parse(post.body)).toMatchObject({ service: 'web', status: 'not running', port });
  });

  test('answers a 502 naming the error when what listens on its port does not speak HTTP', async () => {
    // A TLS server, say: something answers, so this is not "nothing listening".
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => socket.end('\x15\x03\x03\x00\x02\x02\x46 not http\r\n\r\n'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await outside({ web: port, docs: port, site: port });
    const reply = await request(proxy.port, `web.${ROOT}`, { headers: { accept: 'application/json' } }); // oxfmt-ignore
    expect(reply.status).toBe(502);
    expect(reply.headers['retry-after']).toBe('1');
    const json = JSON.parse(reply.body) as { service: string; port: number; code: string };
    expect(json).toMatchObject({ service: 'web', port });
    expect(json.code).toMatch(/^HPE_/);
  });

  test('is forwarded to its port when it leaves the session during a readiness hold', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port, true)]);
    const manager = stubManager({ web: 'running' });
    proxy.bindSession(manager);
    const pending = request(proxy.port, `web.${ROOT}`);
    await new Promise((r) => setTimeout(r, 100));
    manager.set('web', null);
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ upstream: 'web' });
  });

  test('drops a websocket upgrade when nothing listens on its port', async () => {
    const port = await deadPort();
    const proxy = await outside({ web: port, docs: port, site: port });
    await expect(upgrade(proxy.port, `web.${ROOT}`)).rejects.toThrow('socket hang up');
  });

  test('a service in the session but stopped still answers 503, though something listens on its port', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    proxy.bindSession(stubManager({ web: 'stopped' }));
    const reply = await request(proxy.port, `web.${ROOT}`, { headers: { accept: 'application/json' } }); // oxfmt-ignore
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ service: 'web', status: 'stopped' });
    await expect(upgrade(proxy.port, `web.${ROOT}`)).rejects.toThrow('socket hang up');
  });

  test('answers 503 "starting" before a manager is attached, though something listens on its port', async () => {
    const web = await upstream('web');
    const proxy = await proxyFor([route(`web.${ROOT}`, 'web', web.port)]);
    const reply = await request(proxy.port, `web.${ROOT}`);
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toMatchObject({ service: 'web', status: 'starting' });
  });
});

describe('infra services', () => {
  /** An upstream that drains the request body and reports what it received. */
  async function bodyCounter(): Promise<number> {
    const server = http.createServer((req, res) => {
      let received = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (received += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ host: req.headers.host, method: req.method, received }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return (server.address() as net.AddressInfo).port;
  }

  test('replies 503 "starting" until the infra step has finished, manager or not', async () => {
    const store = await upstream('store');
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', store.port)]);
    const before = await request(proxy.port, `s3.${ROOT}`, { headers: { accept: 'application/json' } }); // oxfmt-ignore
    expect(before.status).toBe(503);
    expect(JSON.parse(before.body)).toMatchObject({ infraService: 'store', status: 'starting' });
    // The process manager attaching is not the signal: packages may be up while infra isn't.
    proxy.bindSession(stubManager());
    const html = await request(proxy.port, `s3.${ROOT}`, { headers: { accept: 'text/html' } });
    expect(html.status).toBe(503);
    expect(html.headers['retry-after']).toBe('2');
    expect(html.headers['cache-control']).toBe('no-store');
    expect(html.body).toContain('store');
    expect(html.body).toContain('starting');
    // …and no restart hint: there is no package to restart.
    expect(html.body).not.toContain('/command/service/restart');
  });

  test('drops a websocket upgrade until the infra step has finished', async () => {
    const store = await upstream('store');
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', store.port)]);
    proxy.bindSession(stubManager());
    await expect(upgrade(proxy.port, `s3.${ROOT}`)).rejects.toThrow('socket hang up');
  });

  test('forwards once the infra step has finished, keeping the Host and custom headers', async () => {
    const store = await upstream('store');
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', store.port)]);
    proxy.markInfraReady();
    const reply = await request(proxy.port, `s3.${ROOT}`, {
      path: '/bucket/key?X-Amz-Signature=abc',
      headers: { 'x-custom': 'signed' },
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({
      upstream: 'store',
      host: `s3.${ROOT}`,
      url: '/bucket/key?X-Amz-Signature=abc',
      custom: 'signed',
    });
    expect(reply.headers['x-custom-echo']).toBe('signed');
  });

  test('streams a request body through to the service, as an upload form needs', async () => {
    const port = await bodyCounter();
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', port)]);
    proxy.markInfraReady();
    const body = 'x'.repeat(256 * 1024);
    const reply = await new Promise<Reply>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'POST',
          path: '/bucket',
          headers: { host: `s3.${ROOT}`, 'content-type': 'multipart/form-data; boundary=b' },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })); // oxfmt-ignore
        },
      );
      req.on('error', reject);
      // Written in pieces, so it reaches the proxy chunked rather than as one buffer.
      for (let i = 0; i < body.length; i += 16 * 1024) {
        req.write(body.slice(i, i + 16 * 1024));
      }
      req.end();
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ host: `s3.${ROOT}`, method: 'POST', received: body });
  });

  test('echoes a websocket upgrade once the infra step has finished', async () => {
    const mail = await upstream('mail');
    const proxy = await proxyFor([serviceRoute(`mail.${ROOT}`, 'mail', mail.port)]);
    proxy.markInfraReady();
    const { socket, res } = await upgrade(proxy.port, `mail.${ROOT}`);
    expect(res.statusCode).toBe(101);
    const echoed = new Promise<string>((resolve) => {
      socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    });
    socket.write('ping');
    expect(await echoed).toBe('ping');
  });

  test('turns a refused connection into a 502 naming the service and its port', async () => {
    const port = await deadPort();
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', port)]);
    proxy.markInfraReady();
    const html = await request(proxy.port, `s3.${ROOT}`, { headers: { accept: 'text/html' } });
    expect(html.status).toBe(502);
    expect(html.headers['retry-after']).toBe('1');
    expect(html.body).toContain('infra service store');
    expect(html.body).toContain(String(port));
    const json = await request(proxy.port, `s3.${ROOT}`, { headers: { accept: 'application/json' } }); // oxfmt-ignore
    expect(JSON.parse(json.body)).toMatchObject({
      infraService: 'store',
      port,
      code: 'ECONNREFUSED',
    });
  });

  test('turns a reset connection into the same 502', async () => {
    const server = net.createServer((socket) => socket.resetAndDestroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const proxy = await proxyFor([serviceRoute(`s3.${ROOT}`, 'store', port)]);
    proxy.markInfraReady();
    const json = await request(proxy.port, `s3.${ROOT}`, { headers: { accept: 'application/json' } }); // oxfmt-ignore
    expect(json.status).toBe(502);
    expect(JSON.parse(json.body)).toMatchObject({ infraService: 'store', port });
    // A reset that lands while the request is still being written surfaces as EPIPE instead.
    expect(['ECONNRESET', 'EPIPE']).toContain(JSON.parse(json.body).code);
  });

  test("never consults a package's status, even one sharing the service's name", async () => {
    const service = await upstream('service');
    const proxy = await proxyFor([serviceRoute(`api-db.${ROOT}`, 'api', service.port)]);
    proxy.bindSession(stubManager({ api: 'stopped' }));
    proxy.markInfraReady();
    const reply = await request(proxy.port, `api-db.${ROOT}`);
    expect(reply.status).toBe(200);
    expect(reply.headers['x-upstream']).toBe('service');
  });

  test('lists the service hostnames on the 404 page and in the log line once a session is bound', async () => {
    const web = await upstream('web');
    const store = await upstream('store');
    const proxy = await proxyFor(
      [route(`web.${ROOT}`, 'web', web.port), serviceRoute(`s3.${ROOT}`, 'store', store.port)],
      { publicAddress: { scheme: 'https', port: undefined } },
    );
    const manager = stubManager({ web: 'running' });
    proxy.bindSession(manager);
    const reply = await request(proxy.port, `ghost.${ROOT}`, { headers: { accept: 'text/html' } });
    expect(reply.status).toBe(404);
    expect(reply.body).toContain(`href="https://s3.${ROOT}"`);
    expect(reply.body).toContain(`href="https://web.${ROOT}"`);
    expect(manager.logged[0]![0]).toEqual({
      [`web.${ROOT}`]: `web :${String(web.port)}`,
      [`s3.${ROOT}`]: `infra service store :${String(store.port)}`,
    });
  });
});

describe('routesFromConfig', () => {
  test("resolves each entry's names: a package, an enabled infra service, a disabled one", () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: ROOT, scheme: 'http', port: 4000 },
        routes: [
          { subdomain: ['web', 'www'], service: 'web' },
          { subdomain: ['s3', 'files'], service: 'store' },
          { subdomain: 'console', service: 'console' },
          { subdomain: '*', paths: { '/mail/**': 'mail', '/**': 'api' } },
        ],
      },
      infra: {
        'docker-compose': {
          services: {
            store: { port: 9000 },
            mail: { port: 8025 },
            console: { enabled: false, port: () => 9001 },
          },
        },
      },
      services: { web: { port: 3000, healthcheck: '/health' }, api: { port: 3001 } },
    });
    expect(routesFromConfig(config)).toEqual([
      { subdomain: ['web', 'www'], target: { kind: 'package', package: 'web', port: 3000, hasHealthcheck: true } }, // oxfmt-ignore
      { subdomain: ['s3', 'files'], target: { kind: 'service', service: 'store', port: 9000 } },
      { subdomain: ['console'], target: { kind: 'disabled', service: 'console' } },
      {
        subdomain: ['*'],
        paths: [
          { glob: '/mail/**', target: { kind: 'service', service: 'mail', port: 8025 } },
          { glob: '/**', target: { kind: 'package', package: 'api', port: 3001, hasHealthcheck: false } }, // oxfmt-ignore
        ],
      },
    ]);
  });

  test('is empty without routes, or without a proxy block', () => {
    expect(
      routesFromConfig(defineConfig({ serviceRootDir: 'packages', reverseProxy: { port: 4000 }, services: { web: { port: 3000 } } })), // oxfmt-ignore
    ).toEqual([]);
    expect(
      routesFromConfig(defineConfig({ serviceRootDir: 'packages', services: { web: { port: 3000 } } })), // oxfmt-ignore
    ).toEqual([]);
  });

  test("answers a disabled infra service's routes with a 503, and drops its upgrades", async () => {
    const proxy = await proxyFor([
      { subdomain: ['console'], target: { kind: 'disabled', service: 'console' } },
      byPath(['*'], [['/console/**', { kind: 'disabled', service: 'console' }]]),
    ]);
    proxy.markInfraReady();
    const manager = stubManager({});
    proxy.bindSession(manager);
    for (const [host, path] of [
      [`console.${ROOT}`, '/'],
      [ROOT, '/console/x'],
    ] as const) {
      const reply = await request(proxy.port, host, { path });
      expect(reply.status).toBe(503);
      expect(JSON.parse(reply.body)).toMatchObject({ error: 'infra service console is disabled', infraService: 'console', status: 'disabled', host }); // oxfmt-ignore
    }
    await expect(upgrade(proxy.port, `console.${ROOT}`)).rejects.toThrow('socket hang up');
    expect(manager.logged[0]![0]).toEqual({
      [`console.${ROOT}`]: 'infra service console (disabled)',
      '*/console/**': 'infra service console (disabled)',
    });
  });
});

describe('tls', () => {
  /** An upstream answering with the request's forwarded headers, and echoing them on an upgrade. */
  async function headersEcho(): Promise<number> {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          host: req.headers.host,
          proto: req.headers['x-forwarded-proto'] ?? null,
          forwardedHost: req.headers['x-forwarded-host'] ?? null,
          forwardedFor: req.headers['x-forwarded-for'] ?? null,
        }),
      );
    });
    server.on('upgrade', (req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `x-proto: ${String(req.headers['x-forwarded-proto'] ?? 'none')}\r\n\r\n`,
      );
      socket.on('data', (chunk) => socket.write(chunk));
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    server.on('connection', (socket) => cleanups.push(() => void socket.destroy()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return (server.address() as net.AddressInfo).port;
  }

  /** The proxy over TLS, `web` and `api` both at the headers echo; `statuses` the session's. */
  async function tlsProxy(statuses: Record<string, Status> = { web: 'running', api: 'running' }) {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-tls-'));
    cleanups.push(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
    const port = await headersEcho();
    const { tls: proxyTls, trustFile } = await selfSignedTls({
      workspaceDir,
      mode: 'spec',
      hosts: [ROOT, `web.${ROOT}`, `api.${ROOT}`],
      domains: [ROOT],
    });
    const proxy = await proxyFor(
      [route(`web.${ROOT}`, 'web', port), route(`api.${ROOT}`, 'api', port)],
      { tls: proxyTls },
    );
    proxy.bindSession(stubManager(statuses));
    return { proxy, ca: fs.readFileSync(trustFile, 'utf8'), trustFile };
  }

  /** The certificate the proxy presents for `servername`, verified against `ca`. */
  function peerCertificate(port: number, servername: string | undefined, ca: string) {
    return new Promise<{ subject: string; authorized: boolean }>((resolve, reject) => {
      const socket = tls.connect(
        { host: '127.0.0.1', port, servername, ca, rejectUnauthorized: false },
        () => {
          // oxfmt-ignore
          const raw = socket.getPeerX509Certificate()!;
          resolve({ subject: new X509Certificate(raw.raw).subject, authorized: socket.authorized });
          socket.destroy();
        },
      );
      socket.on('error', reject);
    });
  }

  test('serves HTTP/2 over TLS by ALPN, trusted through the trust file, with forwarded headers', async () => {
    const { proxy, ca } = await tlsProxy();
    const session = http2.connect(`https://127.0.0.1:${String(proxy.port)}`, { ca, servername: `web.${ROOT}` }); // oxfmt-ignore
    cleanups.push(() => {
      session.destroy();
    });
    const body = await new Promise<string>((resolve, reject) => {
      const req = session.request({ ':path': '/', ':authority': `web.${ROOT}` });
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (text += chunk));
      req.on('end', () => resolve(text));
      req.on('error', reject);
      req.end();
    });
    expect(session.alpnProtocol).toBe('h2');
    expect(JSON.parse(body)).toEqual({
      host: `web.${ROOT}`,
      proto: 'https',
      forwardedHost: `web.${ROOT}`,
      forwardedFor: '127.0.0.1',
    });
  });

  test('serves HTTP/1.1 over TLS to a client offering no HTTP/2, replacing forwarded headers it sent', async () => {
    const { proxy, ca } = await tlsProxy();
    const reply = await new Promise<{ protocol: string | false | null; body: string }>(
      (resolve, reject) => {
        const req = https.request(
          {
            host: '127.0.0.1',
            port: proxy.port,
            servername: `api.${ROOT}`,
            ca,
            headers: { host: `api.${ROOT}`, 'x-forwarded-for': '6.6.6.6', 'x-forwarded-proto': 'http' }, // oxfmt-ignore
            agent: false,
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (body += chunk));
            res.on('end', () => resolve({ protocol: (res.socket as tls.TLSSocket).alpnProtocol, body })); // oxfmt-ignore
          },
        );
        req.on('error', reject);
        req.end();
      },
    );
    // Node's HTTPS client offers no protocol by ALPN, so the server falls back to HTTP/1.1.
    expect(reply.protocol).toBe(false);
    expect(JSON.parse(reply.body)).toMatchObject({ proto: 'https', forwardedFor: '127.0.0.1' });
  });

  test('tells a routed service the session does not run that the request came in over https', async () => {
    // Only `api` runs: `web` is forwarded to its port all the same, with the same headers.
    const { proxy, ca } = await tlsProxy({ api: 'running' });
    const session = http2.connect(`https://127.0.0.1:${String(proxy.port)}`, { ca, servername: `web.${ROOT}` }); // oxfmt-ignore
    cleanups.push(() => {
      session.destroy();
    });
    const body = await new Promise<string>((resolve, reject) => {
      const req = session.request({ ':path': '/', ':authority': `web.${ROOT}` });
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (text += chunk));
      req.on('end', () => resolve(text));
      req.on('error', reject);
      req.end();
    });
    expect(JSON.parse(body)).toEqual({
      host: `web.${ROOT}`,
      proto: 'https',
      forwardedHost: `web.${ROOT}`,
      forwardedFor: '127.0.0.1',
    });
  });

  test('still serves plain HTTP/1.1 on the same port, its headers untouched', async () => {
    const { proxy } = await tlsProxy();
    const reply = await request(proxy.port, `web.${ROOT}`, { headers: { 'x-forwarded-proto': 'https' } }); // oxfmt-ignore
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({
      host: `web.${ROOT}`,
      proto: 'https',
      forwardedHost: null,
      forwardedFor: null,
    });
  });

  test('still serves h2c on the same port, with no forwarded headers added', async () => {
    const { proxy } = await tlsProxy();
    const session = http2.connect(`http://127.0.0.1:${String(proxy.port)}`);
    cleanups.push(() => {
      session.destroy();
    });
    const body = await new Promise<string>((resolve, reject) => {
      const req = session.request({ ':path': '/', ':authority': `web.${ROOT}` });
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (text += chunk));
      req.on('end', () => resolve(text));
      req.on('error', reject);
      req.end();
    });
    expect(JSON.parse(body)).toMatchObject({ host: `web.${ROOT}`, proto: null });
  });

  test('carries a websocket upgrade over TLS, telling the service it came in over https', async () => {
    const { proxy, ca } = await tlsProxy();
    const { socket, proto } = await new Promise<{ socket: Duplex; proto: unknown }>(
      (resolve, reject) => {
        // oxfmt-ignore
        const req = https.request({
        host: '127.0.0.1',
        port: proxy.port,
        servername: `web.${ROOT}`,
        ca,
        agent: false,
        headers: { host: `web.${ROOT}`, connection: 'Upgrade', upgrade: 'websocket' },
      });
        req.on('upgrade', (res, upgraded) => resolve({ socket: upgraded, proto: res.headers['x-proto'] })); // oxfmt-ignore
        req.on('response', (res) =>
          reject(new Error(`upgrade refused: ${String(res.statusCode)}`)),
        );
        req.on('error', reject);
        req.end();
      },
    );
    cleanups.push(() => void socket.destroy());
    expect(proto).toBe('https');
    const echoed = new Promise<string>((resolve) => socket.once('data', (d: Buffer) => resolve(d.toString()))); // oxfmt-ignore
    socket.write('ping');
    expect(await echoed).toBe('ping');
  });

  test("presents each hostname its own certificate, makes one for an unknown name under the root, and the root's for any other", async () => {
    // oxfmt-ignore
    const { proxy, ca } = await tlsProxy();
    expect(await peerCertificate(proxy.port, `api.${ROOT}`, ca)).toEqual({
      subject: `CN=api.${ROOT}`,
      authorized: true,
    });
    // Not in the trust file, so not trusted — but named, so the browser can show the 404.
    expect(await peerCertificate(proxy.port, `ghost.${ROOT}`, ca)).toEqual({
      subject: `CN=ghost.${ROOT}`,
      authorized: false,
    });
    expect((await peerCertificate(proxy.port, 'elsewhere.test', ca)).subject).toBe(`CN=${ROOT}`);
    expect((await peerCertificate(proxy.port, undefined, ca)).subject).toBe(`CN=${ROOT}`);
  });

  test('a Node process given the trust file as NODE_EXTRA_CA_CERTS trusts the proxy', async () => {
    const { proxy, trustFile } = await tlsProxy();
    const script = `
      import https from 'node:https';
      https.get({ host: '127.0.0.1', port: ${String(proxy.port)}, servername: 'web.${ROOT}', headers: { host: 'web.${ROOT}' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => console.log(JSON.parse(body).proto));
      }).on('error', (err) => { console.error(err.code); process.exit(1); });`;
    const run = (env: NodeJS.ProcessEnv) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        execFile(
          process.execPath,
          ['--input-type=module', '-e', script],
          { env },
          (err, stdout, stderr) => resolve({ code: err ? 1 : 0, out: (stdout || stderr).trim() }),
        );
      });
    const { NODE_EXTRA_CA_CERTS: _, ...env } = process.env;
    expect(await run({ ...env, NODE_EXTRA_CA_CERTS: trustFile })).toEqual({
      code: 0,
      out: 'https',
    });
    expect(await run(env)).toEqual({ code: 1, out: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  });
});
