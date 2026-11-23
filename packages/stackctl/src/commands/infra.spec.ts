import { describe, expect, test } from 'vitest';
import type { InfraRunRequest } from '../infra/provider';
import { InfraError, type InfraRunAction, type InfraRunSummary } from '../infra/types';
import {
  type InfraCommand,
  type InfraCommandManager,
  infraResults,
  infraSelection,
  runInfraCommand,
} from './infra';

/** A manager that records what it is asked to do; `down` succeeds as `stopOk` says, the rest as `ok`. */
function recordingManager({ stopOk = true, ok = true } = {}) {
  const calls: string[] = [];
  const summary = (req: InfraRunRequest): InfraRunSummary => ({
    ok,
    services: (req.services ?? []).map((service) => ({ service, ok })),
  });
  const manager: InfraCommandManager = {
    async up(req = {}) {
      calls.push(`up ${JSON.stringify(req.services ?? [])} trigger=${String(req.trigger)}`);
      return summary(req);
    },
    async down(req = {}) {
      calls.push(`down ${JSON.stringify(req.services ?? [])}`);
      return { ...summary(req), ok: stopOk };
    },
    async destroy(req = {}) {
      calls.push(`destroy ${JSON.stringify(req.services ?? [])}`);
      return summary(req);
    },
  };
  return { manager, calls };
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
    expect(await run('stop', ['db'])).toEqual({ code: 0, calls: ['down ["db"]'] });
    expect(await run('stop', ['db'], { stopOk: false })).toEqual({
      code: 1,
      calls: ['down ["db"]'],
    });
  });

  test('restart stops them, then starts them as a restart', async () => {
    expect(await run('restart', ['db'])).toEqual({
      code: 0,
      calls: ['down ["db"]', 'up ["db"] trigger=restart'],
    });
  });

  test('a restart whose stop fails starts nothing', async () => {
    expect(await run('restart', ['db'], { stopOk: false })).toEqual({
      code: 1,
      calls: ['down ["db"]'],
    });
  });

  test('destroy destroys them', async () => {
    expect(await run('destroy', ['db'])).toEqual({ code: 0, calls: ['destroy ["db"]'] });
  });

  test('with no services named, each passes none on: every enabled service', async () => {
    expect((await run('start', [])).calls).toEqual(['up [] trigger=start']);
    expect((await run('reset', [])).calls).toEqual(['up [] trigger=reset']);
    expect((await run('destroy', [])).calls).toEqual(['destroy []']);
    expect((await run('stop', [])).calls).toEqual(['down []']);
    expect((await run('restart', [])).calls).toEqual(['down []', 'up [] trigger=restart']);
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
