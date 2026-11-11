import { describe, expect, test } from 'vitest';
import type { InfraRunRequest } from '../infra/provider.js';
import type { InfraRunSummary } from '../infra/types.js';
import { type InfraCommand, type InfraCommandManager, runInfraCommand } from './infra.js';

/** A manager that records what it is asked to do; `stop` exits with `stopCode`, `start` with `ok`. */
function recordingManager({ stopCode = 0, ok = true } = {}) {
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
    async down(services = []) {
      calls.push(`down ${JSON.stringify(services)}`);
      return stopCode;
    },
    async destroy(req = {}) {
      calls.push(`destroy ${JSON.stringify(req.services ?? [])}`);
      return summary(req);
    },
  };
  return { manager, calls };
}

const finished: [InfraRunSummary, 'up' | 'destroy'][] = [];
const reporter = {
  onEvent: () => {},
  finish: (summary: InfraRunSummary, action: 'up' | 'destroy') => finished.push([summary, action]),
};

async function run(
  command: InfraCommand,
  services: string[],
  opts?: { stopCode?: number; ok?: boolean },
) {
  const { manager, calls } = recordingManager(opts);
  const code = await runInfraCommand(manager, command, services, reporter);
  return { code, calls };
}

describe('runInfraCommand', () => {
  test('start starts the services, as a start', async () => {
    expect(await run('start', ['db'])).toEqual({ code: 0, calls: ['up ["db"] trigger=start'] });
  });

  test('reset starts them as a reset', async () => {
    expect(await run('reset', ['db'])).toEqual({ code: 0, calls: ['up ["db"] trigger=reset'] });
  });

  test('stop stops them, and exits as the stop did', async () => {
    expect(await run('stop', ['db'], { stopCode: 4 })).toEqual({ code: 4, calls: ['down ["db"]'] });
  });

  test('restart stops them, then starts them as a restart', async () => {
    expect(await run('restart', ['db'])).toEqual({
      code: 0,
      calls: ['down ["db"]', 'up ["db"] trigger=restart'],
    });
  });

  test('a restart whose stop fails starts nothing', async () => {
    expect(await run('restart', ['db'], { stopCode: 2 })).toEqual({
      code: 2,
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
  });

  test('exits 1 when a service did not make it', async () => {
    expect((await run('start', ['db'], { ok: false })).code).toBe(1);
    expect((await run('destroy', ['db'], { ok: false })).code).toBe(1);
  });

  test('reports how a start or a destroy ended', async () => {
    finished.length = 0;
    await run('reset', ['db']);
    await run('destroy', ['db']);
    expect(finished.map(([, action]) => action)).toEqual(['up', 'destroy']);
  });
});
