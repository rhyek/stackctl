import { describe, expect, test } from 'vitest';
import type { InfraRunRequest, InfraStopRequest } from '../infra/provider';
import { InfraError, type InfraRunAction, type InfraRunSummary } from '../infra/types';
import {
  type InfraCommand,
  type InfraCommandManager,
  infraEntryResults,
  infraResults,
  infraSelection,
  runInfraCommand,
} from './infra';

/**
 * A manager that records what it is asked to do; `down` succeeds as `stopOk` says, the rest as
 * `ok`. With `stopHookError`, `down` stops every service but reports that a stop hook failed.
 */
function recordingManager({
  stopOk = true,
  ok = true,
  stopHookError,
}: { stopOk?: boolean; ok?: boolean; stopHookError?: string } = {}) {
  const calls: string[] = [];
  /** The `data` each call was handed, in call order. */
  const datas: unknown[] = [];
  const summary = (req: InfraRunRequest | InfraStopRequest): InfraRunSummary => ({
    ok,
    services: (req.services ?? []).map((service) =>
      ok ? { service, ok } : { service, ok, error: 'did not come up' },
    ),
  });
  const manager: InfraCommandManager = {
    async up(req = {}) {
      calls.push(`up ${JSON.stringify(req.services ?? [])} trigger=${String(req.trigger)}`);
      datas.push(req.data);
      return summary(req);
    },
    async down(req = {}) {
      calls.push(`down ${JSON.stringify(req.services ?? [])} trigger=${String(req.trigger)}`);
      datas.push(req.data);
      if (stopHookError !== undefined) {
        return {
          ok: false,
          services: (req.services ?? []).map((service) => ({
            service,
            ok: false,
            error: stopHookError,
            hookFailed: true,
          })),
        };
      }
      return stopOk
        ? summary(req)
        : {
            ok: false,
            services: (req.services ?? []).map((service) => ({
              service,
              ok: false,
              error: 'compose down failed',
            })),
          };
    },
    async destroy(req = {}) {
      calls.push(`destroy ${JSON.stringify(req.services ?? [])}`);
      return summary(req);
    },
  };
  return { manager, calls, datas };
}

const finished: [InfraRunSummary, InfraRunAction][] = [];
const reporter = {
  onEvent: () => {},
  finish: (summary: InfraRunSummary, action: InfraRunAction) => finished.push([summary, action]),
};

async function run(
  command: InfraCommand,
  services: string[],
  opts?: { stopOk?: boolean; ok?: boolean; waitTimeoutS?: number },
) {
  const { manager, calls } = recordingManager(opts);
  const code = await runInfraCommand(manager, command, services, reporter, {
    waitTimeoutS: opts?.waitTimeoutS,
  });
  return { code, calls };
}

describe('runInfraCommand', () => {
  test('start starts the services, as a start', async () => {
    expect(await run('start', ['db'])).toEqual({ code: 0, calls: ['up ["db"] trigger=start'] });
  });

  test('reset starts them as a reset', async () => {
    expect(await run('reset', ['db'])).toEqual({ code: 0, calls: ['up ["db"] trigger=reset'] });
  });

  test('stop exits 0 when every service stopped, 1 when one failed', async () => {
    expect(await run('stop', ['db'])).toEqual({ code: 0, calls: ['down ["db"] trigger=stop'] });
    expect(await run('stop', ['db'], { stopOk: false })).toEqual({
      code: 1,
      calls: ['down ["db"] trigger=stop'],
    });
  });

  test('restart stops them, then starts them, both as a restart', async () => {
    expect(await run('restart', ['db'])).toEqual({
      code: 0,
      calls: ['down ["db"] trigger=restart', 'up ["db"] trigger=restart'],
    });
  });

  test('restart hands one data to the stop and the start', async () => {
    const { manager, datas } = recordingManager();
    await runInfraCommand(manager, 'restart', ['db'], reporter);
    expect(datas).toHaveLength(2);
    expect(datas[0]).toEqual({});
    expect(datas[1]).toBe(datas[0]);
    // A new one for the next command.
    await runInfraCommand(manager, 'restart', ['db'], reporter);
    expect(datas[2]).not.toBe(datas[0]);
  });

  test('a restart whose stop fails starts nothing', async () => {
    expect(await run('restart', ['db'], { stopOk: false })).toEqual({
      code: 1,
      calls: ['down ["db"] trigger=restart'],
    });
  });

  test("a stop whose hook failed exits 1, reporting the stop's result", async () => {
    const seen: [InfraRunSummary, InfraRunAction][] = [];
    const { manager } = recordingManager({ stopHookError: 'beforeStop failed: boom' });
    const code = await runInfraCommand(manager, 'stop', ['db'], {
      onEvent: () => {},
      finish: (summary, action) => seen.push([summary, action]),
    });
    expect(code).toBe(1);
    expect(seen).toEqual([
      [
        {
          ok: false,
          services: [
            { service: 'db', ok: false, error: 'beforeStop failed: boom', hookFailed: true },
          ],
        },
        'down',
      ],
    ]);
  });

  test("a restart whose stop hook failed still starts the services, then exits 1 with the hook's error", async () => {
    const seen: [InfraRunSummary, InfraRunAction][] = [];
    const { manager, calls } = recordingManager({ stopHookError: 'beforeStop failed: boom' });
    const code = await runInfraCommand(manager, 'restart', ['db'], {
      onEvent: () => {},
      finish: (summary, action) => seen.push([summary, action]),
    });
    expect(code).toBe(1);
    expect(calls).toEqual(['down ["db"] trigger=restart', 'up ["db"] trigger=restart']);
    expect(seen).toEqual([
      [
        {
          ok: false,
          services: [
            { service: 'db', ok: false, error: 'beforeStop failed: boom', hookFailed: true },
          ],
        },
        'up',
      ],
    ]);
  });

  test('a restart whose stop hook failed and whose start failed too reports both errors', async () => {
    const seen: InfraRunSummary[] = [];
    const { manager } = recordingManager({ stopHookError: 'beforeStop failed: boom', ok: false });
    const code = await runInfraCommand(manager, 'restart', ['db'], {
      onEvent: () => {},
      finish: (summary) => seen.push(summary),
    });
    expect(code).toBe(1);
    expect(seen).toEqual([
      {
        ok: false,
        services: [{ service: 'db', ok: false, error: 'did not come up\nbeforeStop failed: boom' }],
      },
    ]);
  });

  test('destroy destroys them', async () => {
    expect(await run('destroy', ['db'])).toEqual({ code: 0, calls: ['destroy ["db"]'] });
  });

  test('with no services named, each passes none on: every enabled service', async () => {
    expect((await run('start', [])).calls).toEqual(['up [] trigger=start']);
    expect((await run('reset', [])).calls).toEqual(['up [] trigger=reset']);
    expect((await run('destroy', [])).calls).toEqual(['destroy []']);
    expect((await run('stop', [])).calls).toEqual(['down [] trigger=stop']);
    expect((await run('restart', [])).calls).toEqual([
      'down [] trigger=restart',
      'up [] trigger=restart',
    ]);
  });

  test('--wait-timeout reaches the run as milliseconds', async () => {
    const { manager } = recordingManager();
    let seen: number | undefined;
    manager.up = async (req) => {
      seen = req?.readyTimeoutMs;
      return { ok: true, services: [] };
    };
    await runInfraCommand(manager, 'start', [], reporter, { waitTimeoutS: 2 });
    expect(seen).toBe(2000);
  });

  test('exits 1 when a service did not make it', async () => {
    expect((await run('start', ['db'], { ok: false })).code).toBe(1);
    expect((await run('destroy', ['db'], { ok: false })).code).toBe(1);
  });

  test('reports how a start or a destroy ended', async () => {
    finished.length = 0;
    await run('reset', ['db']);
    await run('destroy', ['db']);
    await run('stop', ['db']);
    expect(finished.map(([, action]) => action)).toEqual(['up', 'destroy', 'down']);
  });
});

describe('infraSelection', () => {
  const configured = [
    { name: 'db', enabled: true, tags: ['data'] },
    { name: 'cache', enabled: true, tags: ['data', 'fast'] },
    { name: 'search', enabled: false, tags: ['data', 'slow'] },
    { name: 'mail', enabled: true, tags: [] },
  ];

  test('a tag is the configured infra services that have it', () => {
    expect(infraSelection([], ['fast'], configured)).toEqual(['cache']);
    expect(infraSelection(['mail'], ['fast'], configured)).toEqual(['cache', 'mail']);
  });

  test('a disabled service matched by a tag is left out; named, it stays', () => {
    expect(infraSelection([], ['data'], configured)).toEqual(['db', 'cache']);
    expect(infraSelection(['search'], ['data'], configured)).toEqual(['db', 'cache', 'search']);
  });

  test('a tag that matches nothing enabled throws, and never returns []', () => {
    // `[]` is every enabled service, and for `destroy` the whole project.
    expect(() => infraSelection([], ['slow'], configured)).toThrow(
      new InfraError('no enabled infra service is tagged slow'),
    );
    expect(() => infraSelection([], ['slow'], configured)).toThrow(InfraError);
  });

  test('an unknown tag throws, naming it', () => {
    expect(() => infraSelection([], ['nope'], configured)).toThrow(
      new InfraError('No infra service has the tag: nope'),
    );
    expect(() => infraSelection([], ['nope'], configured)).toThrow(InfraError);
  });

  test('a name the config does not list is passed on, for the provider to check', () => {
    expect(infraSelection(['redis'], ['fast'], configured)).toEqual(['cache', 'redis']);
    expect(infraSelection(['redis'], [], configured)).toEqual(['redis']);
  });

  test('no names and no tags is []', () => {
    expect(infraSelection([], [], configured)).toEqual([]);
  });
});

describe('infraResults', () => {
  const summary: InfraRunSummary = {
    ok: false,
    services: [
      { service: 'db', ok: true },
      { service: 'cache', ok: false, error: 'not ready after 5s' },
    ],
  };

  test("a service that made it is in the state the run's action names; one that didn't, failed", () => {
    expect(infraResults(summary, 'up')).toEqual([
      { service: 'db', status: 'ready' },
      { service: 'cache', status: 'failed', error: 'not ready after 5s' },
    ]);
    expect(infraResults(summary, 'down').map((r) => r.status)).toEqual(['stopped', 'failed']);
    expect(infraResults(summary, 'destroy').map((r) => r.status)).toEqual(['destroyed', 'failed']);
  });

  test('a service that reached the state but whose hook failed is in that state, with the error', () => {
    const hook: InfraRunSummary = {
      ok: false,
      services: [{ service: 'db', ok: false, error: 'beforeStop failed: boom', hookFailed: true }],
    };
    expect(infraResults(hook, 'down')).toEqual([
      { service: 'db', status: 'stopped', error: 'beforeStop failed: boom' },
    ]);
    // A restart's: started again after its stop hook failed.
    expect(infraResults(hook, 'up')).toEqual([
      { service: 'db', status: 'ready', error: 'beforeStop failed: boom' },
    ]);
  });

  test('a reset that stopped after its destroy reports each service destroyed, not ready', () => {
    const reset: InfraRunSummary = {
      ok: false,
      services: [
        {
          service: 'db',
          ok: false,
          error: 'afterDestroy failed: boom',
          hookFailed: true,
          reached: 'destroyed',
        },
        {
          service: 'redis',
          ok: false,
          error: 'not started: db failed in afterDestroy',
          reached: 'destroyed',
        },
      ],
    };
    expect(infraResults(reset, 'up')).toEqual([
      { service: 'db', status: 'destroyed', error: 'afterDestroy failed: boom' },
      { service: 'redis', status: 'destroyed', error: 'not started: db failed in afterDestroy' },
    ]);
  });

  test("the event log's line keeps each state, and a hook's error apart from a failure", () => {
    expect(
      infraEntryResults(
        {
          ok: false,
          services: [
            { service: 'db', ok: false, error: 'beforeStop failed: boom', hookFailed: true },
            { service: 'redis', ok: false, error: 'compose down failed' },
            { service: 'mail', ok: true },
          ],
        },
        'down',
      ),
    ).toEqual({
      services: ['db', 'redis', 'mail'],
      results: { db: 'stopped', redis: 'failed', mail: 'stopped' },
      hookErrors: { db: 'beforeStop failed: boom' },
    });
    const clean = infraEntryResults({ ok: true, services: [{ service: 'db', ok: true }] }, 'up');
    expect(clean).not.toHaveProperty('hookErrors');
    expect(clean).not.toHaveProperty('notStarted');
  });

  test("after a reset stopped by one service's afterDestroy, the event log has its hook's error, and the others as not started", () => {
    expect(
      infraEntryResults(
        {
          ok: false,
          services: [
            {
              service: 'db',
              ok: false,
              error: 'afterDestroy failed: boom',
              hookFailed: true,
              reached: 'destroyed',
            },
            {
              service: 'redis',
              ok: false,
              error: 'not started: db failed in afterDestroy',
              reached: 'destroyed',
            },
          ],
        },
        'up',
      ),
    ).toEqual({
      services: ['db', 'redis'],
      results: { db: 'destroyed', redis: 'destroyed' },
      hookErrors: { db: 'afterDestroy failed: boom' },
      notStarted: { redis: 'not started: db failed in afterDestroy' },
    });
  });

  test('a restart whose stop failed reports how the stop ended', async () => {
    const seen: InfraRunAction[] = [];
    const { manager } = recordingManager({ stopOk: false });
    await runInfraCommand(manager, 'restart', ['db'], {
      onEvent: () => {},
      finish: (_summary, action) => seen.push(action),
    });
    expect(seen).toEqual(['down']);
  });
});
