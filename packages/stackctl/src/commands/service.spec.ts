import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AnyServiceConfig } from '../config';
import type { ControlClient, SessionStatus } from '../control-client';
import type { FoundSession } from '../find-session';
import {
  type ServiceCommand,
  type ServiceCommandContext,
  runServiceCommand,
  serviceRefusal,
} from './service';

// Its spies are put back after each test, whatever config the suite runs under.
afterEach(() => {
  vi.restoreAllMocks();
});

/** The workspace root: each service in `apps/<name>`, with a dev script. */
let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-service-'));
  for (const name of ['api', 'web', 'worker', 'docs']) {
    fs.mkdirSync(path.join(dir, 'apps', name, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'apps', name, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node .' } }),
    );
  }
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const app = (name: string, over: Partial<AnyServiceConfig> = {}) =>
  ({
    name,
    dir: `apps/${name}`,
    resolvedDir: path.join(dir, 'apps', name),
    tags: [],
    ...over,
  }) as AnyServiceConfig;

const known = () => ({
  services: [
    app('api', { tags: ['backend'] }),
    app('web'),
    app('worker', { tags: ['backend'] }),
    app('docs', { command: null, tags: ['backend', 'static'] }),
  ],
  infra: ['db'],
});

describe('serviceRefusal', () => {
  test('needs at least one service', () => {
    expect(serviceRefusal('restart', [], known())).toBe(
      'service restart needs at least one service: stackctl service restart -s <name>, or -t <tag>',
    );
  });

  test('turns away infra services', () => {
    expect(serviceRefusal('stop', ['api', 'db'], known())).toBe(
      'db is an infra service: service stop takes application services only',
    );
  });

  test('a service with no dev command may be stopped, not started or restarted', () => {
    expect(serviceRefusal('stop', ['docs'], known())).toBeUndefined();
    expect(serviceRefusal('start', ['docs'], known())).toBe(
      "docs has no dev command, so can't be started",
    );
    expect(serviceRefusal('restart', ['docs'], known())).toBe(
      "docs has no dev command, so can't be restarted",
    );
  });

  test('a wait timeout must be a number of seconds above 0', () => {
    expect(serviceRefusal('start', ['api'], known(), Number.NaN)).toBe(
      '--wait-timeout takes a number of seconds above 0.',
    );
    expect(serviceRefusal('start', ['api'], known(), 5)).toBeUndefined();
  });
});

/** A running session whose services start out as `services`, and what was asked of it. */
function runningSession(
  services: SessionStatus['services'],
  refuse: string[] = [],
  errors: SessionStatus['errors'] = {},
  serviceHooks: SessionStatus['serviceHooks'] = {},
  /** What the session reports once the command has acted; what it reported before unless given. */
  after?: Partial<SessionStatus>,
): { found: FoundSession & { kind: 'running' }; calls: string[] } {
  const calls: string[] = [];
  const act = (action: ServiceCommand) => async (name: string) => {
    calls.push(`${action} ${name}`);
    return !refuse.includes(name);
  };
  const status = { services, errors, serviceHooks, logFile: '/logs/a.log' } as unknown as SessionStatus; // oxfmt-ignore
  const client = {
    command: { service: { start: act('start'), stop: act('stop'), restart: act('restart') } },
    query: { status: async () => ({ ...status, ...after }) },
  } as unknown as ControlClient;
  return { found: { kind: 'running', client, status, record: null }, calls };
}

type Wait = NonNullable<ServiceCommandContext['wait']>;

const ADVICE =
  'Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session';

function context(found: FoundSession, wait = vi.fn<Wait>(async () => undefined)) {
  const out: string[] = [];
  const ctx: ServiceCommandContext = {
    root: dir,
    base: dir,
    target: { profile: 'development', source: 'default' },
    ...known(),
    find: async () => found,
    wait,
    log: (line) => out.push(line),
    error: (line) => out.push(`error: ${line}`),
  };
  return { ctx, out, wait };
}

describe('runServiceCommand', () => {
  test('with no session of the profile, it fails and says which profile', async () => {
    const { ctx, out } = context({ kind: 'none' });
    expect(await runServiceCommand('restart', { services: ['api'], tags: [] }, ctx)).toBe(1);
    expect(out).toEqual([
      'error: No development stackctl session is running (development is the default profile; pass --profile to choose another).',
    ]);
  });

  test('a session that does not answer is not driven', async () => {
    const { ctx, out } = context({ kind: 'unresponsive', pid: 42, port: 14001, reason: 'hung' });
    expect(await runServiceCommand('stop', { services: ['api'], tags: [] }, ctx)).toBe(1);
    expect(out[0]).toMatch(/^error: a development session is recorded as running \(pid 42\)/);
  });

  test('names are checked before any session is looked for', async () => {
    const find = vi.fn();
    const { ctx } = context({ kind: 'none' });
    expect(await runServiceCommand('start', { services: ['db'], tags: [] }, { ...ctx, find })).toBe(
      1,
    );
    expect(find).not.toHaveBeenCalled();
  });

  test('restart acts on each service once, in order, then waits for them, not the infra', async () => {
    const { found, calls } = runningSession({ api: 'running', web: 'running' });
    const { ctx, out, wait } = context(found);
    const code = await runServiceCommand(
      'restart',
      { services: ['web', 'api', 'web'], tags: [], waitTimeout: 5 },
      ctx,
    );
    expect(code).toBe(0);
    expect(calls).toEqual(['restart web', 'restart api']);
    expect(out).toEqual(['restarting web', 'restarting api']);
    expect(wait).toHaveBeenCalledWith(
      expect.anything(),
      ['web', 'api'],
      expect.objectContaining({
        timeoutMs: 5000,
        infra: false,
        session: false,
        logFile: '/logs/a.log',
      }),
    );
  });

  test('start adds a service the session was started without, and says which already ran', async () => {
    const { found, calls } = runningSession({ api: 'running' });
    const { ctx, out } = context(found);
    expect(await runServiceCommand('start', { services: ['api', 'worker'], tags: [] }, ctx)).toBe(
      0,
    );
    expect(calls).toEqual(['start api', 'start worker']);
    expect(out).toEqual(['api is already running', 'started worker']);
  });

  test('stop succeeds for a service already stopped, and waits for nothing', async () => {
    const { found } = runningSession({ api: 'running', web: 'stopped' });
    const { ctx, out, wait } = context(found);
    expect(
      await runServiceCommand('stop', { services: ['api', 'web', 'worker'], tags: [] }, ctx),
    ).toBe(0);
    expect(out).toEqual(['stopped api', 'web is already stopped', 'worker is already stopped']);
    expect(wait).not.toHaveBeenCalled();
  });

  test('a refused action fails the command; the others still run and are waited on', async () => {
    const { found } = runningSession({ api: 'restarting', web: 'running' }, ['api']);
    const { ctx, out, wait } = context(found);
    expect(await runServiceCommand('start', { services: ['api', 'web'], tags: [] }, ctx)).toBe(1);
    expect(out).toEqual([
      "error: couldn't start api: it is restarting, or the session is shutting down",
      'web is already running',
    ]);
    expect(wait).toHaveBeenCalledWith(expect.anything(), ['web'], expect.anything());
  });

  test.each([
    { state: 'stopped', hook: 'beforeStop' },
    { state: 'stopped', hook: 'afterStop' },
    { state: 'restarting', hook: 'beforeStop' },
  ] as const)(
    'a stop of a $state service whose $hook still runs says it abandoned that hook and stopped it',
    async ({ state, hook }) => {
      const { found, calls } = runningSession({ api: state }, [], {}, { api: hook });
      const { ctx, out } = context(found);
      expect(await runServiceCommand('stop', { services: ['api'], tags: [] }, ctx)).toBe(0);
      expect(calls).toEqual(['stop api']);
      expect(out).toEqual([`stopped api: its ${hook} was still running, and was abandoned`]);
    },
  );

  test('a stop the session gives no answer to says it stopped answering', async () => {
    const { found } = runningSession({ api: 'running' }, ['api']);
    const { ctx, out } = context(found);
    expect(await runServiceCommand('stop', { services: ['api'], tags: [] }, ctx)).toBe(1);
    expect(out).toEqual([
      "error: couldn't stop api: the session stopped answering; it may be shutting down",
    ]);
  });

  test('a stop whose hook is slow keeps waiting, names the hook and how to abandon it once, and succeeds when the stop is done', async () => {
    const { found } = runningSession({ api: 'running' }, [], {}, {}, { serviceHooks: { api: 'beforeStop' } }); // oxfmt-ignore
    let finish!: (ok: boolean) => void;
    found.client.command.service.stop = () => new Promise<boolean>((resolve) => (finish = resolve));
    const { ctx, out } = context(found);
    const running = runServiceCommand('stop', { services: ['api'], tags: [] }, { ...ctx, pollMs: 2 }); // oxfmt-ignore
    const told =
      "api's beforeStop is still running: the stop goes on once it has finished. " +
      'To abandon the hook, stop the service again: stackctl service stop -s api';
    await vi.waitFor(() => expect(out).toEqual([told]));
    // Several more polls: said once.
    await new Promise((resolve) => setTimeout(resolve, 20));
    finish(true);
    expect(await running).toBe(0);
    expect(out).toEqual([told, 'stopped api']);
  });

  test('a stop is given up on only once the session has stopped answering its status too', async () => {
    const { found } = runningSession({ api: 'running' });
    found.client.command.service.stop = (_name, opts) =>
      new Promise<boolean>((resolve) => opts!.signal!.addEventListener('abort', () => resolve(false))); // oxfmt-ignore
    let asked = 0;
    found.client.query.status = async () => (asked++, null);
    const { ctx, out } = context(found);
    expect(await runServiceCommand('stop', { services: ['api'], tags: [] }, { ...ctx, pollMs: 1 })).toBe(1); // oxfmt-ignore
    expect(asked).toBe(5);
    expect(out).toEqual([
      "error: couldn't stop api: the session stopped answering; it may be shutting down",
    ]);
  });

  test("a start whose beforeStart failed says it failed to start, with the hook's error, and is not waited on", async () => {
    const { found } = runningSession(
      { api: 'stopped' },
      [],
      {},
      {},
      {
        services: { api: 'stopped' },
        errors: { api: 'beforeStart failed: boom' },
      },
    );
    let results: unknown;
    const { ctx, out, wait } = context(found);
    ctx.onResults = (r) => (results = r);
    expect(await runServiceCommand('start', { services: ['api'], tags: [] }, ctx)).toBe(1);
    const why = `api failed to start: beforeStart failed: boom. ${ADVICE}.`;
    expect(out).toEqual([`error: ${why}`]);
    expect(wait).not.toHaveBeenCalled();
    expect(results).toEqual([{ service: 'api', status: 'failed', error: why }]);
  });

  test('--wait-timeout bounds the whole command: a start still queued when it is up fails then, naming the hook it waits for', async () => {
    const { found } = runningSession({ api: 'stopped' }, [], {}, { api: 'beforeStop' });
    // Queued behind the stop hook: no answer until the caller stops waiting.
    found.client.command.service.start = (_name, opts) =>
      new Promise<boolean>((resolve) => opts!.signal!.addEventListener('abort', () => resolve(false))); // oxfmt-ignore
    let results: unknown;
    const { ctx, out, wait } = context(found);
    ctx.onResults = (r) => (results = r);
    const began = Date.now();
    expect(await runServiceCommand('start', { services: ['api'], tags: [], waitTimeout: 0.05 }, ctx)).toBe(1); // oxfmt-ignore
    expect(Date.now() - began).toBeLessThan(1_000);
    const why = 'not ready after 0.05s: api (its beforeStop is still running)';
    expect(out).toEqual(["waiting for api's beforeStop to finish", `error: stackctl: ${why}`]);
    // The result carries the reason as a wait's does: without the command's own prefix.
    expect(results).toEqual([{ service: 'api', status: 'failed', error: why }]);
    expect(wait).not.toHaveBeenCalled();
  });

  test('the wait for ready gets what is left of --wait-timeout once the start has answered, not the whole of it again', async () => {
    const { found } = runningSession({ api: 'stopped' });
    found.client.command.service.start = () =>
      new Promise<boolean>((resolve) => setTimeout(resolve, 300, true));
    const { ctx, wait } = context(found);
    const began = Date.now();
    expect(await runServiceCommand('start', { services: ['api'], tags: [], waitTimeout: 5 }, ctx)).toBe(0); // oxfmt-ignore
    // The deadline was set when the command began, not once the start had answered.
    expect(wait.mock.calls[0]![2].deadline).toBeLessThanOrEqual(began + 5_000 + 150);
  });

  test('a start or restart of a service waiting for its deps fails with that reason', async () => {
    for (const action of ['start', 'restart'] as const) {
      const { found } = runningSession({ api: 'running', web: 'waiting' }, ['web']);
      const { ctx, out } = context(found);
      expect(await runServiceCommand(action, { services: ['web'], tags: [] }, ctx)).toBe(1);
      expect(out).toEqual([
        `error: couldn't ${action} web: it is waiting for its dependencies, and starts once they're ready`,
      ]);
    }
  });

  test('services that never get ready fail the command with why', async () => {
    const { found } = runningSession({ api: 'stopped' });
    const { ctx, out } = context(
      found,
      vi.fn<Wait>(async () => 'not ready after 5s: api'),
    );
    expect(await runServiceCommand('start', { services: ['api'], tags: [] }, ctx)).toBe(1);
    expect(out.at(-1)).toBe('error: stackctl: not ready after 5s: api');
  });

  test("service start of a service failed by its hook fails at once, with the hook's message", async () => {
    const { found, calls } = runningSession({ api: 'failed' }, [], {
      api: 'afterReady failed: boom',
    });
    let results: unknown;
    const { ctx, out, wait } = context(found);
    ctx.onResults = (r) => (results = r);
    expect(await runServiceCommand('start', { services: ['api'], tags: [] }, ctx)).toBe(1);
    expect(out).toEqual([
      'error: api is running, but failed: afterReady failed: boom. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session.',
    ]);
    expect(calls).toEqual([]);
    expect(wait).not.toHaveBeenCalled();
    expect(results).toEqual([
      {
        service: 'api',
        status: 'failed',
        error:
          'api is running, but failed: afterReady failed: boom. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session.',
      },
    ]);
  });

  /** A session whose `/events` sends `snapshot`, then nothing until the waiter lets go. */
  const eventsSending = (snapshot: Record<string, unknown>) =>
    async function* (opts: { signal?: AbortSignal } = {}) {
      yield { type: 'snapshot', infra: null, ...snapshot };
      await new Promise<void>((resolve) =>
        opts.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
    };

  test('service start of a service that waits for one failed by its hook fails at once, naming both', async () => {
    // `web` isn't in the session yet: the start adds it, and it waits for `api`, which failed.
    const { found, calls } = runningSession({ api: 'failed' }, [], {
      api: 'afterReady failed: boom',
    });
    const blocked = 'waiting for api, which failed: afterReady failed: boom. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session'; // oxfmt-ignore
    if (found.kind === 'running') {
      Object.assign(found.client, {
        events: eventsSending({
          services: { api: 'failed', web: 'waiting' },
          ready: { api: false, web: false },
          errors: { api: 'afterReady failed: boom', web: blocked },
        }),
        query: { status: async () => ({ ready: { api: false, web: false } }) },
      });
    }
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, out } = context(found);
    ctx.wait = undefined;
    const started = Date.now();
    expect(await runServiceCommand('start', { services: ['web'], tags: [] }, ctx)).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls).toEqual(['start web']);
    expect(out).toEqual(['started web', `error: stackctl: web is ${blocked}. See /logs/a.log`]);
  });

  test('service start of a service already waiting for one failed by its hook says so', async () => {
    const blocked = 'waiting for api, which failed: afterReady failed: boom. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session'; // oxfmt-ignore
    const { found } = runningSession({ api: 'failed', web: 'waiting' }, ['web'], {
      api: 'afterReady failed: boom',
      web: blocked,
    });
    const { ctx, out } = context(found);
    expect(await runServiceCommand('start', { services: ['web'], tags: [] }, ctx)).toBe(1);
    expect(out).toEqual([`error: couldn't start web: it is ${blocked}`]);
  });

  test('a verdict fails only the services that are not ready', async () => {
    const { found } = runningSession({ api: 'stopped', worker: 'stopped' });
    if (found.kind === 'running') {
      Object.assign(found.client, {
        query: { status: async () => ({ ready: { api: true, worker: false } }) },
      });
    }
    let results: unknown;
    const { ctx } = context(
      found,
      vi.fn<Wait>(async () => 'not ready after 5s: worker'),
    );
    ctx.onResults = (r) => (results = r);
    expect(await runServiceCommand('start', { services: ['api', 'worker'], tags: [] }, ctx)).toBe(
      1,
    );
    expect(results).toEqual([
      { service: 'api', status: 'running' },
      { service: 'worker', status: 'failed', error: 'not ready after 5s: worker' },
    ]);
  });

  test('a name that is neither a service nor a directory is refused, the first one given', async () => {
    const { ctx, out } = context({ kind: 'none' });
    expect(await runServiceCommand('start', { services: ['api', 'ghost', 'nope'], tags: [] }, ctx)).toBe(1); // oxfmt-ignore
    expect(out).toEqual(['error: "ghost" is neither a service nor a directory in this workspace']);
  });

  test('-s takes a path inside a service', async () => {
    const { found, calls } = runningSession({ api: 'running' });
    const { ctx } = context(found);
    expect(await runServiceCommand('restart', { services: ['./apps/api'], tags: [] }, ctx)).toBe(0); // oxfmt-ignore
    expect(calls).toEqual(['restart api']);
  });

  test("an infra service's name is still refused as one", async () => {
    const { ctx, out } = context({ kind: 'none' });
    expect(await runServiceCommand('restart', { services: ['db'], tags: [] }, ctx)).toBe(1);
    expect(out).toEqual([
      'error: db is an infra service: service restart takes application services only',
    ]);
  });

  test('-t picks the services with the tag', async () => {
    const { found, calls } = runningSession({ api: 'running', worker: 'running' });
    const { ctx } = context(found);
    expect(await runServiceCommand('restart', { services: [], tags: ['backend'] }, ctx)).toBe(0);
    expect(calls).toEqual(['restart api', 'restart worker']);
  });

  test('a service matched only by a tag, with no dev command, is left out of start', async () => {
    const { found, calls } = runningSession({});
    const { ctx, out } = context(found);
    expect(await runServiceCommand('start', { services: [], tags: ['backend'] }, ctx)).toBe(0);
    expect(calls).toEqual(['start api', 'start worker']);
    expect(out).toEqual(['started api', 'started worker']);
  });

  test('the same service named with -s is refused', async () => {
    const { ctx, out } = context({ kind: 'none' });
    expect(await runServiceCommand('start', { services: ['docs'], tags: ['backend'] }, ctx)).toBe(1); // oxfmt-ignore
    expect(out).toEqual(["error: docs has no dev command, so can't be started"]);
  });

  test('a tag whose services all lack a dev command is an error', async () => {
    const { ctx, out } = context({ kind: 'none' });
    expect(await runServiceCommand('restart', { services: [], tags: ['static'] }, ctx)).toBe(1);
    expect(out).toEqual(['error: no service tagged static has a dev command']);
  });

  test('an unknown tag is an error', async () => {
    const { ctx, out } = context({ kind: 'none' });
    expect(await runServiceCommand('stop', { services: [], tags: ['nope'] }, ctx)).toBe(1);
    expect(out).toEqual(['error: No service has the tag: nope']);
  });

  test('neither -s nor -t is refused', async () => {
    const { ctx, out } = context({ kind: 'none' });
    expect(await runServiceCommand('stop', { services: [], tags: [] }, ctx)).toBe(1);
    expect(out).toEqual([
      'error: service stop needs at least one service: stackctl service stop -s <name>, or -t <tag>',
    ]);
  });
});
