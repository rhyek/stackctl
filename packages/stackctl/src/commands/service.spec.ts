import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AnyServiceConfig } from '../config';
import type { ControlClient, SessionStatus } from '../control-client';
import type { FoundSession } from '../find-session';
import {
  type ServiceCommand,
  type ServiceCommandContext,
  runServiceCommand,
  serviceRefusal,
} from './service';

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
): { found: FoundSession; calls: string[] } {
  const calls: string[] = [];
  const act = (action: ServiceCommand) => async (name: string) => {
    calls.push(`${action} ${name}`);
    return !refuse.includes(name);
  };
  const client = {
    command: { service: { start: act('start'), stop: act('stop'), restart: act('restart') } },
  } as unknown as ControlClient;
  const status = { services, logFile: '/logs/a.log' } as SessionStatus;
  return { found: { kind: 'running', client, status, record: null }, calls };
}

type Wait = NonNullable<ServiceCommandContext['wait']>;

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
      expect.objectContaining({ timeoutMs: 5000, infra: false, logFile: '/logs/a.log' }),
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
      vi.fn<Wait>(async () => 'not healthy after 5s: api'),
    );
    expect(await runServiceCommand('start', { services: ['api'], tags: [] }, ctx)).toBe(1);
    expect(out.at(-1)).toBe('error: stackctl: not healthy after 5s: api');
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
      vi.fn<Wait>(async () => 'not healthy after 5s: worker'),
    );
    ctx.onResults = (r) => (results = r);
    expect(await runServiceCommand('start', { services: ['api', 'worker'], tags: [] }, ctx)).toBe(
      1,
    );
    expect(results).toEqual([
      { service: 'api', status: 'running' },
      { service: 'worker', status: 'failed', error: 'not healthy after 5s: worker' },
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
