import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AnyServiceConfig } from '../config.js';
import type { ControlClient, SessionStatus } from '../control-client.js';
import type { FoundSession } from '../find-session.js';
import {
  type ServiceCommand,
  type ServiceCommandContext,
  runServiceCommand,
  serviceRefusal,
} from './service.js';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-service-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node .' } }));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const app = (name: string, over: Partial<AnyServiceConfig> = {}) =>
  ({ name, relativeDir: name, absoluteDir: dir, ...over }) as AnyServiceConfig;

const known = () => ({
  services: [app('api'), app('web'), app('worker'), app('docs', { command: null })],
  infra: ['db'],
});

describe('serviceRefusal', () => {
  test('needs at least one service', () => {
    expect(serviceRefusal('restart', [], known())).toBe(
      'service restart needs at least one service: stackctl service restart -s <name>',
    );
  });

  test('turns away infra services and unknown names', () => {
    expect(serviceRefusal('stop', ['api', 'db'], known())).toBe(
      'db is an infra service: service stop takes application services only',
    );
    expect(serviceRefusal('start', ['api', 'ghost', 'nope'], known())).toBe(
      'Unknown services: ghost, nope',
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
    expect(await runServiceCommand('restart', { services: ['api'] }, ctx)).toBe(1);
    expect(out).toEqual([
      'error: No development stackctl session is running (development is the default profile; pass --profile to choose another).',
    ]);
  });

  test('a session that does not answer is not driven', async () => {
    const { ctx, out } = context({ kind: 'unresponsive', pid: 42, port: 14001, reason: 'hung' });
    expect(await runServiceCommand('stop', { services: ['api'] }, ctx)).toBe(1);
    expect(out[0]).toMatch(/^error: a development session is recorded as running \(pid 42\)/);
  });

  test('names are checked before any session is looked for', async () => {
    const find = vi.fn();
    const { ctx } = context({ kind: 'none' });
    expect(await runServiceCommand('start', { services: ['db'] }, { ...ctx, find })).toBe(1);
    expect(find).not.toHaveBeenCalled();
  });

  test('restart acts on each service once, in order, then waits for them, not the infra', async () => {
    const { found, calls } = runningSession({ api: 'running', web: 'running' });
    const { ctx, out, wait } = context(found);
    const code = await runServiceCommand(
      'restart',
      { services: ['web', 'api', 'web'], waitTimeout: 5 },
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
    expect(await runServiceCommand('start', { services: ['api', 'worker'] }, ctx)).toBe(0);
    expect(calls).toEqual(['start api', 'start worker']);
    expect(out).toEqual(['api is already running', 'started worker']);
  });

  test('stop succeeds for a service already stopped, and waits for nothing', async () => {
    const { found } = runningSession({ api: 'running', web: 'stopped' });
    const { ctx, out, wait } = context(found);
    expect(await runServiceCommand('stop', { services: ['api', 'web', 'worker'] }, ctx)).toBe(0);
    expect(out).toEqual(['stopped api', 'web is already stopped', 'worker is already stopped']);
    expect(wait).not.toHaveBeenCalled();
  });

  test('a refused action fails the command; the others still run and are waited on', async () => {
    const { found } = runningSession({ api: 'restarting', web: 'running' }, ['api']);
    const { ctx, out, wait } = context(found);
    expect(await runServiceCommand('start', { services: ['api', 'web'] }, ctx)).toBe(1);
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
      expect(await runServiceCommand(action, { services: ['web'] }, ctx)).toBe(1);
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
    expect(await runServiceCommand('start', { services: ['api'] }, ctx)).toBe(1);
    expect(out.at(-1)).toBe('error: stackctl: not healthy after 5s: api');
  });
});
