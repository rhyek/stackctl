import http from 'node:http';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createControlClient, probeInstance, type SessionEvent } from './control-client.js';

const servers: http.Server[] = [];

function startServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
}

// Pinned, so a run from inside a stackctl session of another profile can't change the answers.
beforeEach(() => vi.stubEnv('STACKCTL_PROFILE', 'development'));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.close(() => r());
          s.closeAllConnections(); // a held `/events` stream would keep it open
        }),
    ),
  );
});

const SNAPSHOT = {
  pid: 4242,
  sessionId: 'b1946ac9-2e5f-4f0b-9d3e-1c6f0a9e3d21',
  configPath: '/ws/stackctl.config.ts',
  profile: 'test',
  profileSource: 'flag',
  startedByAgent: true,
  logFile: '/ws/node_modules/.stackctl/profiles/test/logs/171.log',
  services: { web: 'running' },
  ready: { web: true },
  infra: { db: 'running' },
  sessionReady: true,
  config: { packages: [] },
  reverseProxy: {
    port: 21050,
    domain: 'localhost',
    domains: ['localhost'],
    routes: [{ host: 'web.localhost', service: 'web', port: 3000 }],
  },
};

describe('createControlClient', () => {
  test('query.status() returns the parsed session snapshot', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SNAPSHOT));
    });
    const status = await createControlClient(port).query.status();
    expect(status).toEqual(SNAPSHOT);
  });

  test('query.status() returns null when the response lacks pid/configPath (old version)', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ web: 'running' }));
    });
    expect(await createControlClient(port).query.status()).toBeNull();
  });

  test('query.status() reads a missing startedByAgent as false (pre-0.7.0 instance)', async () => {
    const { startedByAgent: _omitted, ...oldShape } = SNAPSHOT;
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(oldShape));
    });
    expect(await createControlClient(port).query.status()).toEqual({
      ...oldShape,
      startedByAgent: false,
    });
  });

  test('query.status() reads a missing profileSource as null', async () => {
    const { profileSource: _omitted, ...oldShape } = SNAPSHOT;
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(oldShape));
    });
    expect(await createControlClient(port).query.status()).toEqual({ ...oldShape, profileSource: null }); // oxfmt-ignore
  });

  test('query.status() returns null when nothing is listening', async () => {
    const port = await startServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => servers.splice(0)[0]!.close(() => r())); // free the port
    expect(await createControlClient(port, 200).query.status()).toBeNull();
  });

  test('command.service.* posts the action and package, and is false for a refused one', async () => {
    const hits: string[] = [];
    const port = await startServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const code = req.url?.endsWith('/web') ? (req.url.includes('/stop/') ? 200 : 202) : 404;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: code !== 404 }));
    });
    const client = createControlClient(port);
    expect(await client.command.service.restart('web')).toBe(true);
    expect(await client.command.service.stop('web')).toBe(true);
    expect(await client.command.service.start('nope')).toBe(false);
    expect(hits).toEqual([
      'POST /command/service/restart/web',
      'POST /command/service/stop/web',
      'POST /command/service/start/nope',
    ]);
  });

  test('command.service.stop() and start() wait past the default timeout', async () => {
    const port = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 300);
    });
    const client = createControlClient(port, 100);
    expect(await client.command.service.stop('web')).toBe(true);
    expect(await client.command.service.start('web')).toBe(true); // a start waits too
    expect(await client.command.service.restart('web')).toBe(false); // the default wait, timed out
  });

  test('command.infra.* posts the action and service, and is false for a busy or unknown one', async () => {
    const hits: string[] = [];
    const port = await startServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const code =
        req.url === '/command/infra/reset/db' ? 202 : req.url?.endsWith('/cache') ? 404 : 409;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: code === 202 }));
    });
    const client = createControlClient(port);
    expect(await client.command.infra.reset('db')).toBe(true);
    expect(await client.command.infra.stop('db')).toBe(false);
    expect(await client.command.infra.start('cache')).toBe(false);
    expect(await client.command.infra.restart('cache')).toBe(false);
    expect(hits).toEqual([
      'POST /command/infra/reset/db',
      'POST /command/infra/stop/db',
      'POST /command/infra/start/cache',
      'POST /command/infra/restart/cache',
    ]);
  });

  test('query.status() reads a missing infra as null', async () => {
    const { infra: _omitted, ...noInfra } = SNAPSHOT;
    const port = await startServer((_req, res) => res.end(JSON.stringify(noInfra)));
    expect(await createControlClient(port).query.status()).toEqual({ ...noInfra, infra: null });
  });

  test('query.status() reads a missing reverseProxy as null', async () => {
    const { reverseProxy: _omitted, ...noProxy } = SNAPSHOT;
    const port = await startServer((_req, res) => res.end(JSON.stringify(noProxy)));
    expect(await createControlClient(port).query.status()).toEqual({
      ...noProxy,
      reverseProxy: null,
    });
  });

  test('command.quit() POSTs /command/quit and returns the ok ack', async () => {
    let hit: { method?: string; url?: string } = {};
    const port = await startServer((req, res) => {
      hit = { method: req.method, url: req.url };
      res.end('{"ok":true}');
    });
    expect(await createControlClient(port).command.quit()).toBe(true);
    expect(hit).toEqual({ method: 'POST', url: '/command/quit' });
  });
});

describe('events()', () => {
  /** A server answering `/events` with `lines`, then holding the stream open (`hold`) or ending it. */
  function eventsServer(lines: unknown[], hold = false): Promise<number> {
    return startServer((req, res) => {
      if (req.url !== '/events') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const line of lines) {
        res.write(`${JSON.stringify(line)}\n`);
      }
      if (!hold) {
        res.end();
      }
    });
  }

  async function collect(iterable: AsyncIterable<SessionEvent>, max = Infinity) {
    const seen: SessionEvent[] = [];
    for await (const event of iterable) {
      seen.push(event);
      if (seen.length >= max) {
        break;
      }
    }
    return seen;
  }

  test('yields each line as an object, and ends when the stream does', async () => {
    const lines = [
      { type: 'snapshot', ...SNAPSHOT },
      { type: 'service-state', service: 'web', status: 'running', ready: true },
      { type: 'session-state', ready: true },
    ];
    const port = await eventsServer(lines);
    expect(await collect(createControlClient(port).events())).toEqual(lines);
  });

  test('ends when the caller aborts', async () => {
    const port = await eventsServer([{ type: 'heartbeat', at: 1 }], true);
    const controller = new AbortController();
    const seen: SessionEvent[] = [];
    for await (const event of createControlClient(port).events({ signal: controller.signal })) {
      seen.push(event);
      controller.abort();
    }
    expect(seen).toEqual([{ type: 'heartbeat', at: 1 }]);
  });

  test('throws when the session sends nothing for the idle timeout', async () => {
    // A session whose loop has stopped keeps its connection open and says nothing.
    const port = await eventsServer([{ type: 'heartbeat', at: 1 }], true);
    await expect(collect(createControlClient(port).events({ idleTimeoutMs: 200 }))).rejects.toThrow(
      /sent nothing for 0\.2s: it looks frozen/,
    );
  });

  test('throws when nothing listens', async () => {
    const port = await startServer((_req, res) => res.end());
    await new Promise<void>((r) => servers.splice(0)[0]!.close(() => r())); // free it
    await expect(collect(createControlClient(port).events())).rejects.toThrow('fetch failed');
  });
});

describe('probeInstance', () => {
  test('maps a live status to InstanceInfo', async () => {
    const port = await startServer((_req, res) => res.end(JSON.stringify(SNAPSHOT)));
    expect(await probeInstance(port)).toEqual({
      pid: SNAPSHOT.pid,
      configPath: SNAPSHOT.configPath,
      profile: 'test',
    });
  });

  test('returns null for a non-stackctl / invalid response', async () => {
    const port = await startServer((_req, res) => res.end('not json'));
    expect(await probeInstance(port)).toBeNull();
  });
});
