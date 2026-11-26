import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { type BuildAddressOptions, type Config, defineConfig } from '../config';
import { createControlClient } from '../control-client';
import type { Envs } from '../env';
import type { Exec } from '../spawn';
import {
  InfraProvider,
  type ProjectCallbacks,
  type ProjectStartCallback,
  type ProviderRuntime,
} from './provider';
import {
  InfraError,
  type InfraCallbackContext,
  type InfraEvent,
  type InfraRunOptions,
  type InfraServiceCallbacks,
  type Readiness,
  type ResolvedInfraService,
} from './types';

/** A stand-in for the resolved config: callbacks only pass it on. */
const CONFIG = { profile: 'test' } as Config<string>;

const READY: Readiness = { state: 'ready', detail: 'running' };
const WAITING: Readiness = { state: 'pending', detail: 'waiting for healthy' };

/** A service's options as a spec writes them: its callbacks, flat, and whether it runs. */
type FakeService = InfraServiceCallbacks & { enabled?: boolean };

/** A spec's service options in the shape the provider reads: the callbacks under `lifecycle`. */
function toServiceConfig(services: Record<string, FakeService>) {
  return Object.fromEntries(
    Object.entries(services).map(([name, { enabled, ...lifecycle }]) => [
      name,
      { enabled, lifecycle },
    ]),
  );
}

interface FakeOptions {
  services?: string[];
  callbacks?: Record<string, FakeService>;
  /** Services as a config resolved them, in place of `callbacks`. */
  resolved?: Record<string, ResolvedInfraService>;
  /** The provider's own hooks. */
  project?: ProjectCallbacks;
  /** What the session aborts at a hard kill: the hooks' commands are killed with it. */
  signal?: AbortSignal;
  failDestroyAll?: string;
  /** Successive readings per service; the last one repeats. Defaults to ready at once. */
  readiness?: Record<string, Readiness[]>;
  readyTimeout?: number;
  failStop?: string;
  /** What {@link FakeProvider.removalRefusals} answers. */
  refusals?: string[];
  exec?: Exec;
  failStart?: string;
  failDestroy?: string;
  /** Services whose data doesn't exist yet. */
  fresh?: string[];
  /** Record the freshness reading in `calls`, to assert where it falls in the order. */
  recordFresh?: boolean;
  connectControl?: ProviderRuntime['connectControl'];
  /** The resolved config the callbacks get; the stand-in by default. */
  config?: Config<string>;
}

/** A provider whose primitives only record that they were called. */
class FakeProvider extends InfraProvider {
  readonly key = 'fake';
  readonly calls: string[] = [];
  private polls = new Map<string, number>();

  constructor(private readonly o: FakeOptions = {}) {
    const runtime: ProviderRuntime = {
      workspaceDir: '/ws',
      profile: 'test',
      config: o.config ?? CONFIG,
      // Only what the test reads: the variables stackctl sets come from the manager.
      envs: { FROM_ENV: 'yes' } as Record<string, string> as Envs,
      tokens: { domain: 'example.test' },
      // The provider's tool records its call; anything else succeeds silently.
      exec:
        o.exec ??
        (async (command, args, opts) => {
          if (command !== 'tool') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          this.calls.push(`tool:${args.join(' ')}@${opts.cwd}`);
          return { exitCode: args[0] === 'boom' ? 2 : 0, stdout: 'tool-out', stderr: '' };
        }),
      spawnInherit: async () => 0,
      stream: () => ({ stop: () => {}, done: new Promise<number>(() => {}) }),
      pollIntervalMs: 1,
      connectControl: o.connectControl,
      signal: o.signal,
    };
    super(
      runtime,
      o.resolved ?? toServiceConfig(o.callbacks ?? {}),
      o.readyTimeout ?? 1000,
      o.project,
    );
  }

  /** Gives services callbacks after construction, once `calls` exists to record into. */
  setCallbacks(services: Record<string, FakeService>): void {
    Object.assign(this.serviceConfig, toServiceConfig(services));
  }

  async listServices() {
    return this.o.services ?? ['db', 'redis'];
  }
  protected async removalRefusals(targets: string[], everything: boolean, action: string) {
    this.calls.push(`check:${action}:${targets.join(',')}${everything ? ':everything' : ''}`);
    return this.o.refusals ?? [];
  }
  protected async stopServices(targets: string[]) {
    this.calls.push(`stop:${targets.join(',')}`);
    if (this.o.failStop) {
      throw new InfraError(this.o.failStop);
    }
  }
  async passthrough() {
    return 0;
  }
  async readStates(targets: string[]) {
    return new Map(targets.map((t) => [t, 'running' as const]));
  }
  protected streamChanges() {
    return { stop: () => {}, done: new Promise<number>(() => {}) };
  }
  protected override extraEnv() {
    return { TOOL_PROJECT: 'ws-test' };
  }
  protected async destroyServices(targets: string[]) {
    this.calls.push(`destroyServices:${targets.join(',')}`);
    if (this.o.failDestroy) {
      throw new InfraError(this.o.failDestroy);
    }
  }
  protected async destroyAll() {
    this.calls.push('destroyAll');
    if (this.o.failDestroyAll) {
      throw new InfraError(this.o.failDestroyAll);
    }
  }
  protected async readFresh(targets: string[]) {
    if (this.o.recordFresh) {
      this.calls.push(`readFresh:${targets.join(',')}`);
    }
    return new Set(this.o.fresh ?? []);
  }
  protected async startServices(targets: string[]) {
    this.calls.push(`start:${targets.join(',')}`);
    if (this.o.failStart) {
      throw new InfraError(this.o.failStart);
    }
  }
  protected async readStatuses(targets: string[]) {
    const out = new Map<string, Readiness>();
    for (const service of targets) {
      const readings = this.o.readiness?.[service] ?? [READY];
      const n = this.polls.get(service) ?? 0;
      this.polls.set(service, n + 1);
      out.set(service, readings[Math.min(n, readings.length - 1)]!);
    }
    return out;
  }
  protected async failureDetail(service: string) {
    return `log tail of ${service}`;
  }
  protected toolCommand(args: string[]): [string, string[]] {
    return ['tool', args];
  }
  protected toolContext(run: ToolHelper) {
    return { tool: run };
  }
}

type ToolHelper = (args: string[], opts?: InfraRunOptions) => Promise<{ stdout: string }>;

/** Callbacks for `service` that record their name and the `trigger` they saw into `calls`. */
function recording(calls: string[], service: string): InfraServiceCallbacks {
  const record = (name: string) => async (ctx: InfraCallbackContext) => {
    calls.push(`${name}:${service}:trigger=${ctx.trigger}`);
  };
  return {
    beforeDestroy: record('beforeDestroy'),
    afterDestroy: record('afterDestroy'),
    beforeStart: record('beforeStart'),
    afterStart: record('afterStart'),
    afterReady: record('afterReady'),
    beforeStop: record('beforeStop'),
    afterStop: record('afterStop'),
  };
}

/**
 * A provider whose own hooks, every one, record `project:<hook>:trigger=<trigger>` into its
 * `calls`, then run the one `o` gives, if any. `datas` collects the `data` each was handed.
 */
function withProjectHooks(o: FakeOptions = {}) {
  const datas: Record<string, unknown>[] = [];
  const record =
    <C extends { trigger: string; data: Record<string, unknown> }>(
      name: string,
      then?: (ctx: C) => void | Promise<void>,
    ) =>
    async (ctx: C) => {
      provider.calls.push(`project:${name}:trigger=${ctx.trigger}`);
      datas.push(ctx.data);
      await then?.(ctx);
    };
  const provider: FakeProvider = new FakeProvider({
    ...o,
    project: {
      beforeStart: record('beforeStart', o.project?.beforeStart),
      beforeStop: record('beforeStop', o.project?.beforeStop),
      afterStop: record('afterStop', o.project?.afterStop),
      afterStart: record('afterStart', o.project?.afterStart),
      afterReady: record('afterReady', o.project?.afterReady),
      beforeDestroy: record('beforeDestroy', o.project?.beforeDestroy),
      afterDestroy: record('afterDestroy', o.project?.afterDestroy),
    },
  });
  return { provider, calls: provider.calls, datas };
}

describe('InfraProvider.up', () => {
  test('runs beforeStart, starts every service in one call, then afterReady', async () => {
    const provider = new FakeProvider();
    provider.setCallbacks({ db: recording(provider.calls, 'db') });
    const summary = await provider.up({});
    expect(provider.calls).toEqual([
      'beforeStart:db:trigger=start',
      'start:db,redis',
      'afterStart:db:trigger=start',
      'afterReady:db:trigger=start',
    ]);
    expect(summary).toEqual({
      ok: true,
      services: [
        { service: 'db', ok: true },
        { service: 'redis', ok: true },
      ],
    });
  });

  test.each(['session', 'restart'] as const)(
    'a %s destroys nothing, and its callbacks see it as their trigger',
    async (trigger) => {
      const provider = new FakeProvider();
      provider.setCallbacks({ db: recording(provider.calls, 'db') });
      await provider.up({ trigger });
      expect(provider.calls).toEqual([
        `beforeStart:db:trigger=${trigger}`,
        'start:db,redis',
        `afterStart:db:trigger=${trigger}`,
        `afterReady:db:trigger=${trigger}`,
      ]);
    },
  );

  test('a reset with nothing named destroys the whole project, between beforeDestroy and afterDestroy', async () => {
    const provider = new FakeProvider();
    provider.setCallbacks({ db: recording(provider.calls, 'db') });
    await provider.up({ trigger: 'reset' });
    expect(provider.calls).toEqual([
      'check:reset:db,redis:everything',
      'beforeDestroy:db:trigger=reset',
      'destroyAll',
      'afterDestroy:db:trigger=reset',
      'beforeStart:db:trigger=reset',
      'start:db,redis',
      'afterStart:db:trigger=reset',
      'afterReady:db:trigger=reset',
    ]);
  });

  test('a reset with nothing named runs every hook for every enabled service, trigger reset', async () => {
    const provider = new FakeProvider();
    provider.setCallbacks({
      db: recording(provider.calls, 'db'),
      redis: recording(provider.calls, 'redis'),
    });
    await provider.up({ trigger: 'reset' });
    const hooks = provider.calls.filter((c) => c.includes(':trigger='));
    expect(hooks.sort()).toEqual(
      [
        'beforeDestroy:db:trigger=reset',
        'beforeDestroy:redis:trigger=reset',
        'afterDestroy:db:trigger=reset',
        'afterDestroy:redis:trigger=reset',
        'beforeStart:db:trigger=reset',
        'beforeStart:redis:trigger=reset',
        'afterStart:db:trigger=reset',
        'afterStart:redis:trigger=reset',
        'afterReady:db:trigger=reset',
        'afterReady:redis:trigger=reset',
      ].sort(),
    );
  });

  test('a refused reset runs no hook and removes nothing', async () => {
    const provider = new FakeProvider({ refusals: ["can't reset db: volume x is external"] });
    provider.setCallbacks({ db: recording(provider.calls, 'db') });
    await expect(provider.up({ trigger: 'reset' })).rejects.toThrow(
      "can't reset db: volume x is external",
    );
    expect(provider.calls).toEqual(['check:reset:db,redis:everything']);
  });

  test('a start checks nothing', async () => {
    const provider = new FakeProvider({ refusals: ['never asked'] });
    expect((await provider.up({})).ok).toBe(true);
    expect(provider.calls).toEqual(['start:db,redis']);
  });

  test('every callback of a run shares one `data`, and the next run starts empty', async () => {
    const seen: string[] = [];
    const note = (phase: string) => async (ctx: InfraCallbackContext) => {
      seen.push(`${phase}:${ctx.service.name}:${JSON.stringify(ctx.data)}`);
      ctx.data[`${phase}:${ctx.service.name}`] = true;
    };
    const provider = new FakeProvider({
      project: {
        beforeStart: async (ctx) => {
          seen.push(`project:${JSON.stringify(ctx.data)}`);
          ctx.data.project = true;
        },
      },
      callbacks: {
        db: { beforeDestroy: note('beforeDestroy'), afterReady: note('afterReady') },
        redis: { beforeStart: note('beforeStart') },
      },
    });
    await provider.up({ trigger: 'reset', services: ['db', 'redis'] });
    expect(seen).toEqual([
      'beforeDestroy:db:{}',
      'project:{"beforeDestroy:db":true}',
      'beforeStart:redis:{"beforeDestroy:db":true,"project":true}',
      'afterReady:db:{"beforeDestroy:db":true,"project":true,"beforeStart:redis":true}',
    ]);
    seen.length = 0;
    await provider.up({});
    expect(seen).toEqual([
      'project:{}',
      'beforeStart:redis:{"project":true}',
      'afterReady:db:{"project":true,"beforeStart:redis":true}',
    ]);
  });

  test('a run handed `data` carries on with it', async () => {
    const data: Record<string, unknown> = { fromSession: 1 };
    let seen: unknown;
    const provider = new FakeProvider({
      callbacks: { db: { beforeStart: async (ctx) => void (seen = ctx.data) } },
    });
    await provider.up({ trigger: 'session', data });
    expect(seen).toBe(data);
  });

  test('a reset with services named destroys only those', async () => {
    const provider = new FakeProvider();
    await provider.up({ trigger: 'reset', services: ['redis'] });
    expect(provider.calls).toEqual(['check:reset:redis', 'destroyServices:redis', 'start:redis']);
  });

  test('a beforeDestroy failure under a reset destroys and starts nothing', async () => {
    const provider = new FakeProvider({
      callbacks: {
        db: {
          beforeDestroy: async () => {
            throw new Error('api still connected');
          },
        },
      },
    });
    const summary = await provider.up({ trigger: 'reset' });
    expect(provider.calls).toEqual(['check:reset:db,redis:everything']);
    expect(summary).toEqual({
      ok: false,
      services: [
        { service: 'db', ok: false, error: 'beforeDestroy failed: api still connected' },
        { service: 'redis', ok: false, error: 'not destroyed: db failed in beforeDestroy' },
      ],
    });
  });

  test('a beforeStart failure starts nothing and fails every target', async () => {
    const provider = new FakeProvider({
      callbacks: {
        db: {
          beforeStart: async () => {
            throw new Error('disk full');
          },
        },
      },
    });
    const summary = await provider.up({});
    expect(provider.calls).toEqual([]);
    expect(summary.ok).toBe(false);
    expect(summary.services[0]).toEqual({
      service: 'db',
      ok: false,
      error: 'beforeStart failed: disk full',
    });
    expect(summary.services[1]).toMatchObject({ service: 'redis', ok: false });
    expect(summary.services[1]!.error).toMatch(/not started.*db.*beforeStart/);
  });

  test('an afterDestroy failure under a reset starts nothing: every service is left destroyed, the culprit with its error, the rest not started', async () => {
    const provider = new FakeProvider({
      callbacks: {
        db: {
          afterDestroy: async () => {
            throw new Error('rm: permission denied');
          },
        },
      },
    });
    const events: InfraEvent[] = [];
    const summary = await provider.up({ trigger: 'reset', onEvent: (e) => events.push(e) });
    expect(provider.calls).toEqual(['check:reset:db,redis:everything', 'destroyAll']);
    const culprit = 'afterDestroy failed: rm: permission denied';
    const notStarted = 'not started: db failed in afterDestroy';
    expect(summary).toEqual({
      ok: false,
      services: [
        { service: 'db', ok: false, error: culprit, hookFailed: true, reached: 'destroyed' },
        { service: 'redis', ok: false, error: notStarted, reached: 'destroyed' },
      ],
    });
    expect(events.filter((e) => e.type === 'status' && e.status === 'destroyed')).toEqual([
      { type: 'status', service: 'db', status: 'destroyed', detail: culprit },
      { type: 'status', service: 'redis', status: 'destroyed', detail: notStarted },
    ]);
    expect(events.some((e) => e.type === 'status' && e.status === 'failed')).toBe(false);
  });

  test('a failed start fails every target with the provider message', async () => {
    const provider = new FakeProvider({ failStart: 'cannot connect to the Docker daemon' });
    const summary = await provider.up({});
    expect(summary.services.map((s) => s.error)).toEqual([
      'cannot connect to the Docker daemon',
      'cannot connect to the Docker daemon',
    ]);
  });

  test('a failed destroy aborts before anything starts', async () => {
    const provider = new FakeProvider({ failDestroy: 'rm failed' });
    const summary = await provider.up({ trigger: 'reset', services: ['db'] });
    expect(provider.calls).toEqual(['check:reset:db', 'destroyServices:db']);
    expect(summary).toEqual({
      ok: false,
      services: [{ service: 'db', ok: false, error: 'rm failed' }],
    });
  });

  test('one service failing does not stop another from finishing', async () => {
    const calls: string[] = [];
    const provider = new FakeProvider({
      callbacks: { redis: recording(calls, 'redis') },
      readiness: { db: [WAITING, { state: 'failed', detail: 'exited (1)' }] },
    });
    const summary = await provider.up({});
    expect(calls).toContain('afterReady:redis:trigger=start');
    expect(summary).toEqual({
      ok: false,
      services: [
        { service: 'db', ok: false, error: 'exited (1)\nlog tail of db' },
        { service: 'redis', ok: true },
      ],
    });
  });

  test('an afterReady that throws fails only its own service', async () => {
    const provider = new FakeProvider({
      callbacks: {
        db: {
          afterReady: async () => {
            throw new Error('migration 0002 failed');
          },
        },
      },
    });
    const summary = await provider.up({});
    expect(summary.services).toEqual([
      { service: 'db', ok: false, error: 'afterReady failed: migration 0002 failed' },
      { service: 'redis', ok: true },
    ]);
  });

  test('waits through pending readings, then times out naming the service and what it saw', async () => {
    const slow = new FakeProvider({ readiness: { db: [WAITING, WAITING, READY] } });
    expect((await slow.up({})).ok).toBe(true);

    const stuck = new FakeProvider({ readiness: { db: [WAITING] }, readyTimeout: 20 });
    const summary = await stuck.up({});
    expect(summary.services[0]!.ok).toBe(false);
    expect(summary.services[0]!.error).toBe('not ready after 0s (waiting for healthy)');
    expect(summary.services[1]).toEqual({ service: 'redis', ok: true });
  });

  test("readyTimeoutMs overrides the provider's readyTimeout", async () => {
    const stuck = new FakeProvider({ readiness: { db: [WAITING] }, readyTimeout: 10_000 });
    const summary = await stuck.up({ services: ['db'], readyTimeoutMs: 100 });
    expect(summary.services[0]!.error).toBe('not ready after 0.1s (waiting for healthy)');
  });

  test('rejects a named service, or a callback key, the provider does not have', async () => {
    await expect(new FakeProvider().up({ services: ['cache'] })).rejects.toThrow(
      /unknown infra service "cache"[\s\S]*db, redis/,
    );
    const misconfigured = new FakeProvider({ callbacks: { postgres: {} } });
    await expect(misconfigured.up({})).rejects.toThrow(InfraError);
    await expect(misconfigured.up({})).rejects.toThrow(/"postgres"[\s\S]*db, redis/);
    expect(misconfigured.calls).toEqual([]);
  });

  test('reports the targets, each status change, and the final status', async () => {
    const events: InfraEvent[] = [];
    await new FakeProvider({ services: ['db'], readiness: { db: [WAITING, READY] } }).up({
      onEvent: (e) => events.push(e),
    });
    expect(events).toEqual([
      { type: 'targets', provider: 'fake', action: 'up', services: ['db'] },
      { type: 'status', service: 'db', status: 'pending' },
      { type: 'status', service: 'db', status: 'starting' },
      { type: 'status', service: 'db', status: 'starting', detail: 'waiting for healthy' },
      { type: 'status', service: 'db', status: 'ready' },
    ]);
  });
});

describe("the provider's own beforeStart", () => {
  test.each(['start', 'session', 'restart'] as const)(
    "runs once on a %s, before every service's beforeStart and the start",
    async (trigger) => {
      const { provider, calls } = withProjectHooks();
      provider.setCallbacks({ db: recording(calls, 'db'), redis: recording(calls, 'redis') });
      await provider.up({ trigger });
      expect(calls.slice(0, 1)).toEqual([`project:beforeStart:trigger=${trigger}`]);
      expect(calls.filter((c) => c.startsWith('project:beforeStart:'))).toHaveLength(1);
      expect(calls.indexOf('start:db,redis')).toBeGreaterThan(
        Math.max(calls.indexOf(`beforeStart:db:trigger=${trigger}`), calls.indexOf(`beforeStart:redis:trigger=${trigger}`)), // oxfmt-ignore
      );
    },
  );

  test('runs once when services are named too', async () => {
    const { provider, calls } = withProjectHooks();
    await provider.up({ services: ['redis'] });
    expect(calls).toEqual([
      'project:beforeStart:trigger=start',
      'start:redis',
      'project:afterStart:trigger=start',
      'project:afterReady:trigger=start',
    ]);
  });

  test('a failure starts nothing, runs no service callback, and fails every target', async () => {
    const { provider, calls } = withProjectHooks({
      project: {
        beforeStart: async () => {
          throw new Error('network in use');
        },
      },
    });
    provider.setCallbacks({ db: recording(calls, 'db') });
    const summary = await provider.up({});
    expect(calls).toEqual(['project:beforeStart:trigger=start']);
    expect(summary).toEqual({
      ok: false,
      services: [
        { service: 'db', ok: false, error: 'fake beforeStart failed: network in use' },
        { service: 'redis', ok: false, error: 'fake beforeStart failed: network in use' },
      ],
    });
  });

  test('does not run on a stop or a destroy', async () => {
    const { provider, calls } = withProjectHooks();
    await provider.down({});
    await provider.destroy({});
    expect(calls.filter((c) => c.startsWith('project:beforeStart:'))).toEqual([]);
  });

  test("gets the run's context and the provider's tool; its output is the run's own", async () => {
    const events: InfraEvent[] = [];
    let ctx: Parameters<ProjectStartCallback>[0] | undefined;
    const provider = new FakeProvider({
      project: {
        beforeStart: async (c) => {
          ctx = c;
          c.log('adopting the network');
          await (c as unknown as { tool: ToolHelper }).tool(['network', 'ls']);
        },
      },
    });
    await provider.up({ onEvent: (e) => events.push(e) });
    expect(ctx).toMatchObject({
      profile: 'test',
      trigger: 'start',
      workspaceDir: '/ws',
      tokens: { domain: 'example.test' },
      envs: { FROM_ENV: 'yes', TOOL_PROJECT: 'ws-test' },
      data: {},
    });
    expect(ctx).not.toHaveProperty('service');
    expect(ctx).not.toHaveProperty('control');
    expect(provider.calls[0]).toBe('tool:network ls@/ws');
    expect(events).toContainEqual({ type: 'output', line: 'adopting the network', isError: false });
  });
});

describe("the provider's hooks around the services' own", () => {
  const boom = () => {
    throw new Error('boom');
  };
  /** Each service's final status events, in the order they came. */
  const finals = (events: InfraEvent[]) =>
    events.filter(
      (e) => e.type === 'status' && ['ready', 'destroyed', 'failed'].includes(e.status),
    );

  test("a start: provider beforeStart, services' beforeStart, start, services' afterStart, provider afterStart, each afterReady, provider afterReady last", async () => {
    const { provider, calls } = withProjectHooks();
    provider.setCallbacks({ db: recording(calls, 'db'), redis: recording(calls, 'redis') });
    expect((await provider.up({})).ok).toBe(true);
    expect(calls).toEqual([
      'project:beforeStart:trigger=start',
      'beforeStart:db:trigger=start',
      'beforeStart:redis:trigger=start',
      'start:db,redis',
      'afterStart:db:trigger=start',
      'afterStart:redis:trigger=start',
      'project:afterStart:trigger=start',
      'afterReady:db:trigger=start',
      'afterReady:redis:trigger=start',
      'project:afterReady:trigger=start',
    ]);
  });

  test("the provider's afterReady runs only when every target is ready, after their own afterReady", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { provider, calls } = withProjectHooks({
      readiness: { redis: [WAITING, WAITING, READY] },
    });
    provider.setCallbacks({
      db: {
        afterReady: async () => {
          await gate;
          calls.push('afterReady:db:done');
        },
      },
      redis: recording(calls, 'redis'),
    });
    const events: InfraEvent[] = [];
    const running = provider.up({ onEvent: (e) => events.push(e) });
    await vi.waitFor(() => expect(calls).toContain('afterReady:redis:trigger=start'));
    // Every reading is ready, but db's own afterReady hasn't finished: no service is final yet,
    // and redis, its own part done, says what it is waiting for.
    expect(calls).not.toContain('project:afterReady:trigger=start');
    expect(finals(events)).toEqual([]);
    await vi.waitFor(() =>
      expect(events.at(-1)).toEqual({
        type: 'status',
        service: 'redis',
        status: 'starting',
        detail: 'ready, waiting for the other services',
      }),
    );
    release();
    expect((await running).ok).toBe(true);
    expect(calls.slice(-2)).toEqual(['afterReady:db:done', 'project:afterReady:trigger=start']);
    // db settled last: nothing was left for it to wait for.
    expect(
      events.filter(
        (e) => e.type === 'status' && e.service === 'db' && e.detail?.includes('waiting'),
      ),
    ).toEqual([]);
    expect(finals(events)).toEqual([
      { type: 'status', service: 'db', status: 'ready' },
      { type: 'status', service: 'redis', status: 'ready' },
    ]);
  });

  test("the provider's afterReady doesn't run when a service failed; the ones that got ready stay ready", async () => {
    const { provider, calls } = withProjectHooks({
      readiness: { db: [{ state: 'failed', detail: 'exited (1)' }] },
    });
    const summary = await provider.up({});
    expect(calls).not.toContain('project:afterReady:trigger=start');
    expect(summary.services).toEqual([
      { service: 'db', ok: false, error: 'exited (1)\nlog tail of db' },
      { service: 'redis', ok: true },
    ]);
  });

  test.each([
    {
      why: 'its own afterReady throws',
      o: {},
      db: { afterReady: () => Promise.reject(new Error('migration 0002 failed')) },
      error: 'afterReady failed: migration 0002 failed',
    },
    {
      why: 'it times out',
      o: { readiness: { db: [WAITING] }, readyTimeout: 30 },
      db: {},
      error: 'not ready after 0s (waiting for healthy)',
    },
  ])(
    "with the provider's afterReady, a service that failed because $why fails alone: the provider's doesn't run, the other ends ready",
    async ({ o, db, error }) => {
      const { provider, calls } = withProjectHooks(o);
      provider.setCallbacks({ db, redis: recording(calls, 'redis') });
      const events: InfraEvent[] = [];
      const summary = await provider.up({ onEvent: (e) => events.push(e) });
      expect(calls).not.toContain('project:afterReady:trigger=start');
      expect(summary.services).toEqual([
        { service: 'db', ok: false, error },
        { service: 'redis', ok: true },
      ]);
      expect(finals(events).filter((e) => e.type === 'status' && e.service === 'db')).toEqual([
        { type: 'status', service: 'db', status: 'failed', detail: error },
      ]);
    },
  );

  test("once a service has failed, the others aren't held for the provider's afterReady: each is ready as soon as it is", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { provider, calls } = withProjectHooks({
      services: ['db', 'redis', 'cache'],
      readiness: { db: [{ state: 'failed', detail: 'exited (1)' }] },
    });
    provider.setCallbacks({
      cache: {
        afterReady: async () => {
          calls.push('afterReady:cache:started');
          await gate;
        },
      },
    });
    const events: InfraEvent[] = [];
    const running = provider.up({ onEvent: (e) => events.push(e) });
    await vi.waitFor(() => expect(calls).toContain('afterReady:cache:started'));
    // db failed, so the provider's afterReady can't run: redis is ready while cache is still busy.
    expect(finals(events)).toContainEqual({ type: 'status', service: 'redis', status: 'ready' });
    release();
    await running;
    expect(calls).not.toContain('project:afterReady:trigger=start');
    expect(
      events.filter((e) => e.type === 'status' && e.detail?.includes('waiting for the other')),
    ).toEqual([]);
  });

  test("while the provider's afterStart runs, each service's step names it; a service's own afterStart failure is reported before it", async () => {
    let seen: InfraEvent[] = [];
    const events: InfraEvent[] = [];
    const { provider } = withProjectHooks({
      project: { afterStart: () => void (seen = [...events]) },
    });
    provider.setCallbacks({ db: { afterStart: boom } });
    await provider.up({ onEvent: (e) => events.push(e) });
    expect(seen.filter((e) => e.type === 'status').slice(-2)).toEqual([
      { type: 'status', service: 'db', status: 'failed', detail: 'afterStart failed: boom' },
      { type: 'status', service: 'redis', status: 'starting', detail: 'fake afterStart' },
    ]);
  });

  test("while a hook runs, the service's step names it: its afterStart, the provider's, its afterReady, then the provider's afterReady", async () => {
    const { provider } = withProjectHooks({ services: ['db'] });
    provider.setCallbacks({ db: recording([], 'db') });
    const events: InfraEvent[] = [];
    await provider.up({ onEvent: (e) => events.push(e) });
    expect(events.filter((e) => e.type === 'status')).toEqual([
      { type: 'status', service: 'db', status: 'pending' },
      { type: 'status', service: 'db', status: 'starting' },
      { type: 'status', service: 'db', status: 'starting', detail: 'afterStart' },
      { type: 'status', service: 'db', status: 'starting', detail: 'fake afterStart' },
      { type: 'status', service: 'db', status: 'starting', detail: 'afterReady' },
      { type: 'status', service: 'db', status: 'starting', detail: 'fake afterReady' },
      { type: 'status', service: 'db', status: 'ready' },
    ]);
  });

  test("a destroy: provider beforeDestroy, services' beforeDestroy, the removal, services' afterDestroy, provider afterDestroy", async () => {
    const { provider, calls } = withProjectHooks();
    provider.setCallbacks({ db: recording(calls, 'db'), redis: recording(calls, 'redis') });
    expect((await provider.destroy({})).ok).toBe(true);
    expect(calls).toEqual([
      'check:destroy:db,redis:everything',
      'project:beforeDestroy:trigger=destroy',
      'beforeDestroy:db:trigger=destroy',
      'beforeDestroy:redis:trigger=destroy',
      'destroyAll',
      'afterDestroy:db:trigger=destroy',
      'afterDestroy:redis:trigger=destroy',
      'project:afterDestroy:trigger=destroy',
    ]);
  });

  test('a reset runs the destroy order then the start order, sharing one data, and no stop hook', async () => {
    const { provider, calls, datas } = withProjectHooks({ services: ['db'] });
    let servicesData: unknown;
    provider.setCallbacks({
      db: {
        ...recording(calls, 'db'),
        afterStart: async (ctx) => {
          calls.push(`afterStart:db:trigger=${ctx.trigger}`);
          servicesData = ctx.data;
        },
      },
    });
    expect((await provider.up({ trigger: 'reset' })).ok).toBe(true);
    expect(calls).toEqual([
      'check:reset:db:everything',
      'project:beforeDestroy:trigger=reset',
      'beforeDestroy:db:trigger=reset',
      'destroyAll',
      'afterDestroy:db:trigger=reset',
      'project:afterDestroy:trigger=reset',
      'project:beforeStart:trigger=reset',
      'beforeStart:db:trigger=reset',
      'start:db',
      'afterStart:db:trigger=reset',
      'project:afterStart:trigger=reset',
      'afterReady:db:trigger=reset',
      'project:afterReady:trigger=reset',
    ]);
    expect(datas).toHaveLength(5);
    expect(new Set([...datas, servicesData]).size).toBe(1);
  });

  test("a throw in an infra service's afterStart fails that service", async () => {
    const { provider, calls } = withProjectHooks();
    provider.setCallbacks({
      db: { ...recording(calls, 'db'), afterStart: boom },
      redis: recording(calls, 'redis'),
    });
    const events: InfraEvent[] = [];
    const summary = await provider.up({ onEvent: (e) => events.push(e) });
    expect(summary.services).toEqual([
      { service: 'db', ok: false, error: 'afterStart failed: boom' },
      { service: 'redis', ok: true },
    ]);
    // Nothing waits on db, its afterReady doesn't run, and so neither does the provider's.
    expect(calls.slice(calls.indexOf('start:db,redis'))).toEqual([
      'start:db,redis',
      'afterStart:redis:trigger=start',
      'project:afterStart:trigger=start',
      'afterReady:redis:trigger=start',
    ]);
    expect(finals(events)).toEqual([
      { type: 'status', service: 'db', status: 'failed', detail: 'afterStart failed: boom' },
      { type: 'status', service: 'redis', status: 'ready' },
    ]);
  });

  test.each(['afterStart', 'afterReady'] as const)(
    'a throw in the provider\'s %s fails every target with "fake <hook> failed: boom"',
    async (hook) => {
      const { provider, calls } = withProjectHooks({ project: { [hook]: boom } });
      provider.setCallbacks({ db: recording(calls, 'db') });
      const events: InfraEvent[] = [];
      const summary = await provider.up({ onEvent: (e) => events.push(e) });
      const error = `fake ${hook} failed: boom`;
      expect(summary).toEqual({
        ok: false,
        services: [
          { service: 'db', ok: false, error },
          { service: 'redis', ok: false, error },
        ],
      });
      // One final status per service: failed.
      expect(finals(events)).toEqual([
        { type: 'status', service: 'db', status: 'failed', detail: error },
        { type: 'status', service: 'redis', status: 'failed', detail: error },
      ]);
      // A failed afterStart leaves nothing to wait for: no afterReady runs.
      expect(calls.filter((c) => c.includes('afterReady'))).toEqual(
        hook === 'afterStart'
          ? []
          : ['afterReady:db:trigger=start', 'project:afterReady:trigger=start'],
      );
    },
  );

  test("a service whose own afterDestroy failed and the provider's too has both in its result and its line, in the order they ran", async () => {
    const { provider } = withProjectHooks({
      project: {
        afterDestroy: () => {
          throw new Error('project-wide');
        },
      },
    });
    provider.setCallbacks({ db: { afterDestroy: boom } });
    const events: InfraEvent[] = [];
    const summary = await provider.destroy({ onEvent: (e) => events.push(e) });
    const both = 'afterDestroy failed: boom\nfake afterDestroy failed: project-wide';
    const project = 'fake afterDestroy failed: project-wide';
    expect(summary.services).toEqual([
      { service: 'db', ok: false, error: both, hookFailed: true },
      { service: 'redis', ok: false, error: project, hookFailed: true },
    ]);
    // One final status per service, saying what its result says.
    expect(finals(events)).toEqual([
      { type: 'status', service: 'db', status: 'destroyed', detail: both },
      { type: 'status', service: 'redis', status: 'destroyed', detail: project },
    ]);
  });

  test("when a service's own afterStart failed and the provider's afterStart fails too, both are on screen; its line and result say its own", async () => {
    const { provider } = withProjectHooks({
      services: ['db'],
      project: {
        afterStart: () => {
          throw new Error('project-wide');
        },
      },
    });
    provider.setCallbacks({ db: { afterStart: boom } });
    const events: InfraEvent[] = [];
    const summary = await provider.up({ onEvent: (e) => events.push(e) });
    expect(summary.services).toEqual([
      { service: 'db', ok: false, error: 'afterStart failed: boom' },
    ]);
    expect(finals(events)).toEqual([
      { type: 'status', service: 'db', status: 'failed', detail: 'afterStart failed: boom' },
    ]);
    // The provider's failure is the run's own error line, as a provider stop hook's is.
    expect(events.filter((e) => e.type === 'output')).toEqual([
      { type: 'output', line: 'fake afterStart failed: project-wide', isError: true },
    ]);
  });

  test.each(['destroy', 'reset'] as const)(
    "a provider beforeDestroy that throws removes nothing and runs no service's callback (%s)",
    async (trigger) => {
      const { provider, calls } = withProjectHooks({ project: { beforeDestroy: boom } });
      provider.setCallbacks({ db: recording(calls, 'db') });
      const summary =
        trigger === 'destroy' ? await provider.destroy({}) : await provider.up({ trigger });
      expect(calls).toEqual([
        `check:${trigger}:db,redis:everything`,
        `project:beforeDestroy:trigger=${trigger}`,
      ]);
      const error = 'fake beforeDestroy failed: boom';
      expect(summary.services).toEqual([
        { service: 'db', ok: false, error },
        { service: 'redis', ok: false, error },
      ]);
    },
  );

  test.each(['destroy', 'reset'] as const)(
    'a provider afterDestroy that throws: every target is destroyed with its message, the result failed, and a reset stops before the start (%s)',
    async (trigger) => {
      const { provider, calls } = withProjectHooks({ project: { afterDestroy: boom } });
      provider.setCallbacks({ db: recording(calls, 'db') });
      const summary =
        trigger === 'destroy' ? await provider.destroy({}) : await provider.up({ trigger });
      expect(calls.slice(-3)).toEqual([
        'destroyAll',
        `afterDestroy:db:trigger=${trigger}`,
        `project:afterDestroy:trigger=${trigger}`,
      ]);
      const error = 'fake afterDestroy failed: boom';
      const reached = trigger === 'reset' ? { reached: 'destroyed' } : {};
      expect(summary.services).toEqual([
        { service: 'db', ok: false, error, hookFailed: true, ...reached },
        { service: 'redis', ok: false, error, hookFailed: true, ...reached },
      ]);
    },
  );

  test.each([
    {
      run: 'up',
      calls: [
        'project:beforeStart:trigger=start',
        'project:afterStart:trigger=start',
        'project:afterReady:trigger=start',
      ],
    },
    {
      run: 'reset',
      calls: [
        'project:beforeDestroy:trigger=reset',
        'project:afterDestroy:trigger=reset',
        'project:beforeStart:trigger=reset',
        'project:afterStart:trigger=reset',
        'project:afterReady:trigger=reset',
      ],
    },
    {
      run: 'destroy',
      calls: [
        'check:destroy::everything',
        'project:beforeDestroy:trigger=destroy',
        'destroyAll',
        'project:afterDestroy:trigger=destroy',
      ],
    },
  ] as const)("the provider's hooks run with no service enabled ($run)", async ({ run, calls }) => {
    const quiet = withProjectHooks({ services: ['db'], callbacks: { db: { enabled: false } } });
    const summary =
      run === 'destroy'
        ? await quiet.provider.destroy({})
        : await quiet.provider.up({ trigger: run === 'reset' ? 'reset' : 'start' });
    expect(summary).toEqual({ ok: true, services: [] });
    expect(quiet.calls).toEqual(calls);
  });

  test.each([
    { hook: 'beforeStart', run: 'up', last: 'project:beforeStart:trigger=start' },
    { hook: 'afterStart', run: 'up', last: 'project:afterStart:trigger=start' },
    { hook: 'afterReady', run: 'up', last: 'project:afterReady:trigger=start' },
    { hook: 'beforeDestroy', run: 'destroy', last: 'project:beforeDestroy:trigger=destroy' },
    { hook: 'afterDestroy', run: 'destroy', last: 'project:afterDestroy:trigger=destroy' },
    { hook: 'afterDestroy', run: 'reset', last: 'project:afterDestroy:trigger=reset' },
  ] as const)(
    'with no service enabled, a failing provider $hook rejects the $run and runs nothing after it',
    async ({ hook, run, last }) => {
      const failing = withProjectHooks({
        services: ['db'],
        callbacks: { db: { enabled: false } },
        project: { [hook]: boom },
      });
      const running =
        run === 'destroy'
          ? failing.provider.destroy({})
          : failing.provider.up({ trigger: run === 'reset' ? 'reset' : 'start' });
      await expect(running).rejects.toThrow(new InfraError(`fake ${hook} failed: boom`));
      expect(failing.calls.at(-1)).toBe(last);
    },
  );
});

describe('fresh', () => {
  test('afterReady is told whether this run created its service’s data', async () => {
    const seen: Record<string, boolean> = {};
    const note = (ctx: { service: { name: string }; fresh: boolean }) => {
      seen[ctx.service.name] = ctx.fresh;
    };
    await new FakeProvider({
      fresh: ['db'],
      callbacks: { db: { afterReady: note }, redis: { afterReady: note } },
    }).up({});
    expect(seen).toEqual({ db: true, redis: false });
  });

  test('is read after any destroy and before the start — a reset makes a service fresh', async () => {
    const provider = new FakeProvider({ recordFresh: true });
    await provider.up({ trigger: 'reset', services: ['db'] });
    expect(provider.calls).toEqual([
      'check:reset:db',
      'destroyServices:db',
      'readFresh:db',
      'start:db',
    ]);
  });
});

describe('InfraProvider callback context: buildAddress', () => {
  test("is the one the service's urls got: its origin, each option replacing a part", async () => {
    let seen: ((opts?: BuildAddressOptions) => string) | undefined;
    const config = defineConfig({
      workspaceDir: os.tmpdir(),
      serviceRootDir: 'apps',
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: 'example.test', scheme: 'https' },
        routes: [{ subdomain: 'mail', service: 'mail' }],
      },
      infra: {
        'docker-compose': {
          services: {
            mail: {
              port: 8025,
              lifecycle: {
                afterReady: (ctx) => {
                  seen = ctx.buildAddress;
                },
              },
            },
          },
        },
      },
      services: { web: {} },
    });
    // Compose's callbacks, which this provider-neutral fake runs with the base context alone.
    const services = config.infra!['docker-compose']!.services as Record<string, ResolvedInfraService>; // oxfmt-ignore
    await new FakeProvider({ config, services: ['mail'], resolved: services }).up({});
    expect(seen?.()).toBe('https://mail.example.test');
    expect(seen?.({ path: '/inbox' })).toBe('https://mail.example.test/inbox');
    expect(seen?.({ subdomain: null })).toBe('https://example.test');
  });

  test("falls back to the config's proxy for callbacks the config didn't resolve, localhost without one", async () => {
    const seen: string[] = [];
    const record = (ctx: InfraCallbackContext) => {
      seen.push(ctx.buildAddress());
    };
    await new FakeProvider({ services: ['db'], callbacks: { db: { afterReady: record } } }).up({});
    const config = { ...CONFIG, reverseProxy: { port: 4000, publicAddress: { domain: 'localhost', domains: ['localhost'], scheme: 'http', port: 4000 }, routes: [], tls: false } } as Config<string>; // oxfmt-ignore
    await new FakeProvider({ config, services: ['db'], callbacks: { db: { afterReady: record } } }).up({}); // oxfmt-ignore
    expect(seen).toEqual(['http://localhost', 'http://localhost:4000']);
  });
});

describe('InfraProvider callback context', () => {
  test('carries the service, profile, workspace, tokens and the provider-extended env', async () => {
    let seen: InfraCallbackContext | undefined;
    await new FakeProvider({
      callbacks: {
        db: {
          afterReady: (ctx) => {
            seen = ctx;
          },
        },
      },
    }).up({});
    expect(seen).toMatchObject({
      // A service the config resolved nothing for (the fake's callbacks alone): its name, unrouted.
      service: { name: 'db', kind: 'infra', route: null },
      profile: 'test',
      config: CONFIG,
      trigger: 'start',
      workspaceDir: '/ws',
      tokens: { domain: 'example.test' },
      envs: { FROM_ENV: 'yes', TOOL_PROJECT: 'ws-test' },
    });
  });

  test('hands every callback of a run the same `control`, looked up once, when the first one starts', async () => {
    const client = createControlClient(1);
    const lookups: string[] = [];
    const seen: unknown[] = [];
    const record = (ctx: InfraCallbackContext) => {
      seen.push(ctx.control);
    };
    const provider = new FakeProvider({
      callbacks: {
        db: { beforeStart: record, afterReady: record },
        redis: { afterReady: record },
      },
      connectControl: async () => {
        lookups.push('lookup');
        return client;
      },
    });
    await provider.up({});
    expect(lookups).toEqual(['lookup']);
    expect(seen).toEqual([client, client, client]);
  });

  test('a run with no callbacks never looks for a session', async () => {
    let looked = false;
    await new FakeProvider({
      connectControl: async () => {
        looked = true;
        return undefined;
      },
    }).up({ trigger: 'reset' });
    expect(looked).toBe(false);
  });

  test('`control` is undefined without a session, and when the lookup fails', async () => {
    const seen: unknown[] = [];
    const callbacks = {
      db: { afterDestroy: (ctx: InfraCallbackContext) => void seen.push(ctx.control) },
    };
    await new FakeProvider({ callbacks }).destroy({ services: ['db'] });
    const failing = new FakeProvider({
      callbacks,
      connectControl: () => Promise.reject(new Error('down')),
    });
    expect((await failing.destroy({ services: ['db'] })).ok).toBe(true);
    expect(seen).toEqual([undefined, undefined]);
  });

  test('exec resolves cwd against the workspace, merges env, and streams output as events', async () => {
    const seen: { command: string; args: string[]; cwd: string; env: Record<string, string> }[] =
      [];
    const fakeExec: Exec = async (command, args, opts) => {
      seen.push({ command, args, cwd: opts.cwd, env: opts.env });
      opts.onLine?.('2 migrations applied', false);
      return { exitCode: 0, stdout: '2 migrations applied\n', stderr: '' };
    };
    const events: InfraEvent[] = [];
    await new FakeProvider({
      exec: fakeExec,
      callbacks: {
        db: {
          afterReady: async ({ exec, log }) => {
            const result = await exec('migrate', ['deploy'], {
              cwd: 'packages/db',
              env: { A: '1' },
            });
            await exec('seed');
            log(`got: ${result.stdout.trim()}`);
          },
        },
      },
    }).up({ onEvent: (e) => events.push(e) });
    expect(seen).toEqual([
      {
        command: 'migrate',
        args: ['deploy'],
        cwd: path.resolve('/ws', 'packages/db'),
        env: { FROM_ENV: 'yes', TOOL_PROJECT: 'ws-test', A: '1' },
      },
      { command: 'seed', args: [], cwd: '/ws', env: { FROM_ENV: 'yes', TOOL_PROJECT: 'ws-test' } },
    ]);
    expect(events.filter((e) => e.type === 'output')).toEqual([
      { type: 'output', service: 'db', line: '2 migrations applied', isError: false },
      { type: 'output', service: 'db', line: '2 migrations applied', isError: false },
      { type: 'output', service: 'db', line: 'got: 2 migrations applied', isError: false },
    ]);
  });

  test('a failing command rejects with the command and its exit code, unless reject is false', async () => {
    const fakeExec: Exec = async () => ({ exitCode: 4, stdout: '', stderr: 'nope' });
    let tolerated: number | undefined;
    const summary = await new FakeProvider({
      exec: fakeExec,
      callbacks: {
        db: {
          afterReady: async ({ exec }) => {
            tolerated = (await exec('probe', [], { reject: false })).exitCode;
            await exec('migrate', ['deploy']);
          },
        },
      },
    }).up({});
    expect(tolerated).toBe(4);
    expect(summary.services[0]).toEqual({
      service: 'db',
      ok: false,
      error: 'afterReady failed: `migrate deploy` exited with code 4',
    });
    expect(summary.services[1]!.ok).toBe(true);
  });

  test("the tool keeps the provider's variables whatever env a callback passes; exec doesn't", async () => {
    const seen: { command: string; env: Record<string, string> }[] = [];
    await new FakeProvider({
      exec: async (command, _args, opts) => {
        seen.push({ command, env: opts.env });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      callbacks: {
        db: {
          afterReady: async (ctx) => {
            const { tool } = ctx as typeof ctx & { tool: ToolHelper };
            const env = { TOOL_PROJECT: 'other', A: '1' };
            await tool(['up'], { env });
            await ctx.exec('script', [], { env });
          },
        },
      },
    }).up({});
    expect(seen).toEqual([
      { command: 'tool', env: { FROM_ENV: 'yes', TOOL_PROJECT: 'ws-test', A: '1' } },
      { command: 'script', env: { FROM_ENV: 'yes', TOOL_PROJECT: 'other', A: '1' } },
    ]);
  });

  test("a callback gets the provider's tool helper, which rejects on a non-zero exit too", async () => {
    const provider = new FakeProvider({
      callbacks: {
        db: {
          afterReady: async (ctx) => {
            // The base context is provider-neutral; the provider adds its own helper to it.
            const { tool } = ctx as typeof ctx & { tool: ToolHelper };
            expect((await tool(['exec', 'db', 'true'])).stdout).toBe('tool-out');
            await tool(['boom']);
          },
        },
      },
    });
    const summary = await provider.up({});
    expect(provider.calls).toContain('tool:exec db true@/ws');
    expect(summary.services[0]!.error).toMatch(/afterReady failed: `.*boom` exited with code 2/);
  });
});

describe('InfraProvider.destroy', () => {
  test('with no services destroys everything; the callbacks around it see the destroy', async () => {
    const provider = new FakeProvider();
    provider.setCallbacks({ db: recording(provider.calls, 'db') });
    const events: InfraEvent[] = [];
    const summary = await provider.destroy({ onEvent: (e) => events.push(e) });
    expect(provider.calls).toEqual([
      'check:destroy:db,redis:everything',
      'beforeDestroy:db:trigger=destroy',
      'destroyAll',
      'afterDestroy:db:trigger=destroy',
    ]);
    expect(summary.ok).toBe(true);
    expect(events[0]).toEqual({
      type: 'targets',
      provider: 'fake',
      action: 'destroy',
      services: ['db', 'redis'],
    });
    expect(events.at(-1)).toEqual({ type: 'status', service: 'redis', status: 'destroyed' });
  });

  test('with services named destroys only those', async () => {
    const provider = new FakeProvider();
    await provider.destroy({ services: ['db'] });
    expect(provider.calls).toEqual(['check:destroy:db', 'destroyServices:db']);
  });

  test('a refused destroy runs no hook and removes nothing', async () => {
    const provider = new FakeProvider({ refusals: ["can't destroy db: volume x is in use"] });
    provider.setCallbacks({ db: recording(provider.calls, 'db') });
    await expect(provider.destroy({ services: ['db'] })).rejects.toThrow(
      "can't destroy db: volume x is in use",
    );
    expect(provider.calls).toEqual(['check:destroy:db']);
  });

  test('a beforeDestroy that throws removes nothing and fails every target', async () => {
    const provider = new FakeProvider({
      callbacks: {
        db: {
          beforeDestroy: async () => {
            throw new Error('api still connected');
          },
        },
      },
    });
    const summary = await provider.destroy({});
    expect(provider.calls).toEqual(['check:destroy:db,redis:everything']);
    expect(summary).toEqual({
      ok: false,
      services: [
        { service: 'db', ok: false, error: 'beforeDestroy failed: api still connected' },
        { service: 'redis', ok: false, error: 'not destroyed: db failed in beforeDestroy' },
      ],
    });
  });

  test('an afterDestroy that throws: the service is destroyed, its result failed with the message', async () => {
    const events: InfraEvent[] = [];
    const summary = await new FakeProvider({
      callbacks: {
        db: {
          afterDestroy: async () => {
            throw new Error('rm: permission denied');
          },
        },
      },
    }).destroy({ onEvent: (e) => events.push(e) });
    const error = 'afterDestroy failed: rm: permission denied';
    expect(summary).toEqual({
      ok: false,
      services: [
        { service: 'db', ok: false, error, hookFailed: true },
        { service: 'redis', ok: true },
      ],
    });
    expect(events.filter((e) => e.type === 'status' && e.service === 'db')).toEqual([
      { type: 'status', service: 'db', status: 'destroying' },
      { type: 'status', service: 'db', status: 'destroyed', detail: error },
    ]);
  });
});

describe('a disabled service', () => {
  const withDisabledRedis = (calls: string[] = []) =>
    new FakeProvider({
      callbacks: { redis: { ...recording(calls, 'redis'), enabled: false } },
    });

  test('is left out of "all services": not started, and its callbacks do not run', async () => {
    const calls: string[] = [];
    const provider = withDisabledRedis(calls);
    const summary = await provider.up({});
    expect(provider.calls).toEqual(['start:db']);
    expect(calls).toEqual([]);
    expect(summary).toEqual({ ok: true, services: [{ service: 'db', ok: true }] });
  });

  test('cannot be brought up by name: the error says it is disabled, and for which profile', async () => {
    const provider = withDisabledRedis();
    await expect(provider.up({ services: ['redis'] })).rejects.toThrow(InfraError);
    await expect(provider.up({ services: ['redis'] })).rejects.toThrow(
      /"redis"[\s\S]*disabled[\s\S]*"test"[\s\S]*enabled/,
    );
    expect(provider.calls).toEqual([]);
  });

  test('cannot be stopped by name: the error says it is disabled, and nothing is stopped', async () => {
    const provider = withDisabledRedis();
    await expect(provider.down({ services: ['redis'] })).rejects.toThrow(
      /"redis"[\s\S]*disabled[\s\S]*"test"/,
    );
    expect(provider.calls).toEqual([]);
  });

  test('is left alone by a stop with nothing named: not stopped, and its stop hooks do not run', async () => {
    const calls: string[] = [];
    const provider = withDisabledRedis(calls);
    await provider.down({});
    expect(provider.calls).toEqual(['stop:db']);
    expect(calls).toEqual([]);
  });

  test('can still be destroyed by name, to clean up after a profile where it ran', async () => {
    const provider = withDisabledRedis();
    expect((await provider.destroy({ services: ['redis'] })).ok).toBe(true);
    expect(provider.calls).toEqual(['check:destroy:redis', 'destroyServices:redis']);
  });

  test('goes with the project in a reset with nothing named, which starts only the enabled', async () => {
    const provider = withDisabledRedis();
    expect((await provider.up({ trigger: 'reset' })).ok).toBe(true);
    expect(provider.calls).toEqual(['check:reset:db:everything', 'destroyAll', 'start:db']);
  });

  test('a full destroy takes the whole project but runs afterDestroy only for enabled services', async () => {
    const calls: string[] = [];
    const provider = withDisabledRedis(calls);
    const summary = await provider.destroy({});
    expect(provider.calls).toEqual(['check:destroy:db:everything', 'destroyAll']);
    expect(calls).toEqual([]);
    expect(summary.services).toEqual([{ service: 'db', ok: true }]);
  });
});

describe('no services to act on', () => {
  const allDisabled = (o: { failDestroyAll?: string } = {}) =>
    new FakeProvider({ services: ['db'], callbacks: { db: { enabled: false } }, ...o });

  test('up starts nothing — and a reset destroys nothing — and succeeds', async () => {
    const provider = allDisabled();
    const events: InfraEvent[] = [];
    expect(await provider.up({ onEvent: (e) => events.push(e) })).toEqual({
      ok: true,
      services: [],
    });
    expect(await provider.up({ trigger: 'reset' })).toEqual({ ok: true, services: [] });
    expect(provider.calls).toEqual([]);
    expect(events).toEqual([{ type: 'targets', provider: 'fake', action: 'up', services: [] }]);
  });

  test('a failure with no service to report it on is not swallowed', async () => {
    const provider = allDisabled({ failDestroyAll: 'cannot connect to the Docker daemon' });
    await expect(provider.destroy({})).rejects.toThrow(/cannot connect to the Docker daemon/);
  });
});

describe('InfraProvider.down', () => {
  test('with nothing named stops every service, by name', async () => {
    const provider = new FakeProvider();
    await provider.down({});
    expect(provider.calls).toEqual(['stop:db,redis']);
  });

  test('reports each target stopping, then stopped', async () => {
    const provider = new FakeProvider();
    const events: InfraEvent[] = [];
    const summary = await provider.down({ services: ['db'], onEvent: (e) => events.push(e) });
    expect(summary).toEqual({ ok: true, services: [{ service: 'db', ok: true }] });
    expect(events).toEqual([
      { type: 'targets', provider: 'fake', action: 'down', services: ['db'] },
      { type: 'status', service: 'db', status: 'stopping' },
      { type: 'status', service: 'db', status: 'stopped' },
    ]);
  });

  test('a stop that fails fails every target, and runs no afterStop', async () => {
    const { provider, calls } = withProjectHooks({ failStop: 'compose down failed' });
    provider.setCallbacks({ db: recording(calls, 'db') });
    const summary = await provider.down({});
    expect(summary.ok).toBe(false);
    expect(summary.services.map((s) => s.error)).toEqual([
      'compose down failed',
      'compose down failed',
    ]);
    expect(calls).toEqual([
      'project:beforeStop:trigger=stop',
      'beforeStop:db:trigger=stop',
      'stop:db,redis',
    ]);
  });

  test("a stop that fails after a stop hook did: the result names the stop's error and the hook's", async () => {
    const { provider } = withProjectHooks({
      failStop: 'compose down failed',
      project: {
        beforeStop: () => {
          throw new Error('webhook endpoint unreachable');
        },
      },
    });
    provider.setCallbacks({
      db: {
        beforeStop: () => {
          throw new Error('boom');
        },
      },
    });
    expect(await provider.down({})).toEqual({
      ok: false,
      services: [
        {
          service: 'db',
          ok: false,
          error:
            'compose down failed\nfake beforeStop failed: webhook endpoint unreachable\nbeforeStop failed: boom',
        },
        {
          service: 'redis',
          ok: false,
          error: 'compose down failed\nfake beforeStop failed: webhook endpoint unreachable',
        },
      ],
    });
  });

  test("down runs the provider's beforeStop, each service's beforeStop, the stop, each service's afterStop, the provider's afterStop", async () => {
    const { provider, calls } = withProjectHooks();
    provider.setCallbacks({ db: recording(calls, 'db'), redis: recording(calls, 'redis') });
    expect((await provider.down({})).ok).toBe(true);
    expect(calls).toEqual([
      'project:beforeStop:trigger=stop',
      'beforeStop:db:trigger=stop',
      'beforeStop:redis:trigger=stop',
      'stop:db,redis',
      'afterStop:db:trigger=stop',
      'afterStop:redis:trigger=stop',
      'project:afterStop:trigger=stop',
    ]);
  });

  test("a restart's stop and start share one data, with trigger restart", async () => {
    const provider = new FakeProvider({ services: ['db'] });
    let read: unknown;
    provider.setCallbacks({
      db: {
        beforeStop: ({ data, trigger }) => {
          data.note = `left by beforeStop on ${trigger}`;
        },
        afterReady: ({ data, trigger }) => {
          read = `${String(data.note)}, read by afterReady on ${trigger}`;
        },
      },
    });
    const data: Record<string, unknown> = {};
    await provider.down({ trigger: 'restart', data });
    await provider.up({ trigger: 'restart', data });
    expect(read).toBe('left by beforeStop on restart, read by afterReady on restart');
  });

  test.each(['beforeStop', 'afterStop'] as const)(
    'a stop hook that throws: the stop goes ahead; the service is stopped, its result failed with the message, and the message is an error line under its label (%s)',
    async (hook) => {
      const provider = new FakeProvider();
      const events: InfraEvent[] = [];
      provider.setCallbacks({
        db: {
          [hook]: () => {
            throw new Error('boom');
          },
        },
      });
      const summary = await provider.down({ onEvent: (e) => events.push(e) });
      expect(provider.calls).toContain('stop:db,redis');
      expect(summary).toEqual({
        ok: false,
        services: [
          { service: 'db', ok: false, error: `${hook} failed: boom`, hookFailed: true },
          { service: 'redis', ok: true },
        ],
      });
      // One final status per service: stopped, with what failed.
      expect(events.filter((e) => e.type === 'status' && e.service === 'db')).toEqual([
        { type: 'status', service: 'db', status: 'stopping' },
        { type: 'status', service: 'db', status: 'stopped', detail: `${hook} failed: boom` },
      ]);
      expect(events.filter((e) => e.type === 'output')).toEqual([
        { type: 'output', service: 'db', line: `${hook} failed: boom`, isError: true },
      ]);
    },
  );

  test("a service's afterStop still runs after its own beforeStop threw", async () => {
    const provider = new FakeProvider({ services: ['db'] });
    provider.setCallbacks({
      db: {
        ...recording(provider.calls, 'db'),
        beforeStop: () => {
          throw new Error('boom');
        },
      },
    });
    await provider.down({});
    expect(provider.calls).toEqual(['stop:db', 'afterStop:db:trigger=stop']);
  });

  test("a provider stop hook that throws: the stop goes ahead, every service's result is failed with the message, an untagged error line", async () => {
    const { provider, calls } = withProjectHooks({
      project: {
        beforeStop: () => {
          throw new Error('webhook endpoint unreachable');
        },
      },
    });
    provider.setCallbacks({ db: recording(calls, 'db') });
    const events: InfraEvent[] = [];
    const summary = await provider.down({ onEvent: (e) => events.push(e) });
    expect(events.filter((e) => e.type === 'output')).toEqual([
      {
        type: 'output',
        line: 'fake beforeStop failed: webhook endpoint unreachable',
        isError: true,
      },
    ]);
    expect(calls).toEqual([
      'project:beforeStop:trigger=stop',
      'beforeStop:db:trigger=stop',
      'stop:db,redis',
      'afterStop:db:trigger=stop',
      'project:afterStop:trigger=stop',
    ]);
    expect(summary).toEqual({
      ok: false,
      services: [
        {
          service: 'db',
          ok: false,
          error: 'fake beforeStop failed: webhook endpoint unreachable',
          hookFailed: true,
        },
        {
          service: 'redis',
          ok: false,
          error: 'fake beforeStop failed: webhook endpoint unreachable',
          hookFailed: true,
        },
      ],
    });
  });

  test("every stop hook failure is in a service's result, in the order the hooks ran: the provider's both, and its own", async () => {
    const { provider } = withProjectHooks({
      project: {
        beforeStop: () => {
          throw new Error('early');
        },
        afterStop: () => {
          throw new Error('later');
        },
      },
    });
    provider.setCallbacks({
      db: {
        beforeStop: () => {
          throw new Error('boom');
        },
      },
    });
    const summary = await provider.down({});
    expect(summary.services).toEqual([
      {
        service: 'db',
        ok: false,
        error:
          'fake beforeStop failed: early\nbeforeStop failed: boom\nfake afterStop failed: later',
        hookFailed: true,
      },
      {
        service: 'redis',
        ok: false,
        error: 'fake beforeStop failed: early\nfake afterStop failed: later',
        hookFailed: true,
      },
    ]);
  });

  test("the provider's stop hooks run with no service enabled; a failure then rejects, having no service to fail", async () => {
    const quiet = withProjectHooks({ services: ['db'], callbacks: { db: { enabled: false } } });
    expect(await quiet.provider.down({})).toEqual({ ok: true, services: [] });
    expect(quiet.calls).toEqual([
      'project:beforeStop:trigger=stop',
      'project:afterStop:trigger=stop',
    ]);

    const failing = withProjectHooks({
      services: ['db'],
      callbacks: { db: { enabled: false } },
      project: {
        beforeStop: () => {
          throw new Error('webhook endpoint unreachable');
        },
        afterStop: () => {
          throw new Error('later');
        },
      },
    });
    await expect(failing.provider.down({})).rejects.toThrow(
      new InfraError(
        'fake beforeStop failed: webhook endpoint unreachable\nfake afterStop failed: later',
      ),
    );
    // The stop goes ahead: there is none to do, but its afterStop still runs.
    expect(failing.calls).toEqual([
      'project:beforeStop:trigger=stop',
      'project:afterStop:trigger=stop',
    ]);
  });
});

describe("the runtime's signal", () => {
  /** An `exec` whose commands run until their signal aborts, recording each signal. */
  function untilAborted() {
    const signals: (AbortSignal | undefined)[] = [];
    const exec: Exec = (_command, _args, opts) => {
      signals.push(opts.signal);
      return new Promise((resolve) => {
        opts.signal?.addEventListener('abort', () =>
          resolve({ exitCode: 137, stdout: '', stderr: '' }),
        );
      });
    };
    return { exec, signals };
  }

  test.each([
    { hook: 'beforeStart', via: 'exec', run: 'up' },
    { hook: 'beforeStart', via: "the provider's tool (compose)", run: 'up' },
    { hook: 'beforeStop', via: 'exec', run: 'down' },
    { hook: 'afterStop', via: "the provider's tool (compose)", run: 'down' },
  ] as const)(
    "kills the command that $hook runs through $via once it aborts: the session's hard kill",
    async ({ hook, via, run }) => {
      const hardKill = new AbortController();
      const { exec, signals } = untilAborted();
      const provider = new FakeProvider({ services: ['db'], signal: hardKill.signal, exec });
      const command = async (ctx: InfraCallbackContext) => {
        await (via === 'exec'
          ? ctx.exec('pnpm', ['migrate'], { reject: false })
          : (ctx as unknown as { tool: ToolHelper }).tool(['exec', 'db', 'psql'], {
              reject: false,
            }));
      };
      provider.setCallbacks({ db: { [hook]: command } });
      const running = run === 'up' ? provider.up({}) : provider.down({});
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[0]!.aborted).toBe(false);
      hardKill.abort();
      expect(signals[0]!.aborted).toBe(true);
      expect((await running).ok).toBe(true);
    },
  );
});
