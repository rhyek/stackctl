import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Config } from '../../config.js';
import type { Envs } from '../../env.js';
import type { Exec, ExecResult, Stream } from '../../spawn.js';
import { InfraError, type InfraEvent, type ResolvedDockerComposeInfra } from '../types.js';
import {
  DockerComposeProvider,
  classify,
  parsePs,
  selectVolumes,
  stateOf,
  type ComposeConfig,
  type PsRow,
} from './docker-compose.js';

const WS = '/repos/example';
const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ exitCode, stdout: '', stderr });

interface Call {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Arguments after the global flags every Compose invocation starts with. */
const sub = (call: Call) =>
  call.command === 'docker' && call.args[0] === 'compose'
    ? call.args
        .slice(call.args.indexOf(WS) + 1)
        .filter((a, i, all) => a !== '-f' && all[i - 1] !== '-f')
    : call.args;

/**
 * A provider over a scripted Docker. `respond` sees the subcommand arguments (global flags
 * stripped) and returns a result, or nothing for an empty success.
 */
function setup(
  respond: (args: string[], call: Call) => ExecResult | undefined = () => undefined,
  resolved: Partial<ResolvedDockerComposeInfra> = {},
  /** The change feed `watchStates` reads; by default one that never says anything. */
  stream: Stream = () => ({ stop: () => {}, done: new Promise<number>(() => {}) }),
) {
  const calls: Call[] = [];
  const inherited: Call[] = [];
  const exec: Exec = async (command, args, opts) => {
    const call = { command, args, cwd: opts.cwd, env: opts.env };
    calls.push(call);
    // An unscripted `config` is an empty project; everything else unscripted succeeds silently.
    const subArgs = sub(call);
    const result =
      respond(subArgs, call) ?? (subArgs.join(' ') === 'config --format json' ? ok('{}') : ok());
    for (const line of result.stderr.split('\n').filter(Boolean)) {
      opts.onLine?.(line, true);
    }
    return result;
  };
  const provider = new DockerComposeProvider(
    { projectName: 'example-test', readyTimeout: 200, services: {}, ...resolved },
    {
      workspaceDir: WS,
      mode: 'test',
      config: { envMode: 'test' } as Config<string>,
      // Only what the test reads: the variables stackctl sets come from the manager.
      envs: { DB_PORT: '21052' } as Record<string, string> as Envs,
      tokens: {},
      exec,
      spawnInherit: async (command, args, opts) => {
        inherited.push({ command, args, ...opts });
        return 7;
      },
      stream,
      pollIntervalMs: 1,
    },
  );
  return { provider, calls, inherited, subs: () => calls.map(sub) };
}

const servicesThen =
  (rest: (args: string[]) => ExecResult | undefined) =>
  (args: string[]): ExecResult | undefined =>
    args.join(' ') === 'config --services' ? ok('db\nredis\n') : rest(args);

const row = (Service: string, State: string, Health = '', ExitCode = 0): PsRow => ({
  Service,
  State,
  Health,
  ExitCode,
});
/** A row with a container id — what the provider needs to recognise a container it has seen. */
const container = (ID: string, Service: string, State: string, Health = ''): PsRow => ({
  ...row(Service, State, Health),
  ID,
});
const ndjson = (...rows: PsRow[]) => ok(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

describe('the Compose invocation', () => {
  test('always names the project directory and carries the project name and env', async () => {
    const { provider, calls } = setup(servicesThen(() => undefined));
    await provider.listServices();
    expect(calls[0]).toEqual({
      command: 'docker',
      args: ['compose', '--project-directory', WS, 'config', '--services'],
      cwd: WS,
      env: { DB_PORT: '21052', COMPOSE_PROJECT_NAME: 'example-test' },
    });
  });

  test('passes -f only when the config names a file', async () => {
    const { provider, calls } = setup(
      servicesThen(() => undefined),
      {
        file: `${WS}/infra/compose.yaml`,
      },
    );
    await provider.listServices();
    expect(calls[0]!.args).toEqual([
      'compose',
      '--project-directory',
      WS,
      '-f',
      `${WS}/infra/compose.yaml`,
      'config',
      '--services',
    ]);
  });

  test('lists the services Compose reports, sorted — Compose prints them in no stable order', async () => {
    const { provider } = setup((args) =>
      args.join(' ') === 'config --services' ? ok('redis\ninit\ndb\n') : undefined,
    );
    expect(await provider.listServices()).toEqual(['db', 'init', 'redis']);
  });

  test('says so plainly when Docker is not installed', async () => {
    const { provider } = setup(() => fail('spawn docker ENOENT', 127));
    await expect(provider.listServices()).rejects.toThrow(InfraError);
    await expect(provider.listServices()).rejects.toThrow(/Docker[\s\S]*installed/);
  });

  test("surfaces Compose's own message when a command fails", async () => {
    const { provider } = setup(() => fail('no configuration file provided: not found', 14));
    await expect(provider.listServices()).rejects.toThrow(
      /docker compose config --services[\s\S]*no configuration file provided/,
    );
  });
});

describe('parsePs', () => {
  test('reads one JSON object per line', () => {
    expect(
      parsePs(ndjson(row('db', 'running', 'healthy'), row('redis', 'running')).stdout),
    ).toEqual([row('db', 'running', 'healthy'), row('redis', 'running')]);
  });

  test('reads a JSON array, as older Compose prints', () => {
    expect(parsePs(JSON.stringify([row('db', 'exited', '', 1)]))).toEqual([
      row('db', 'exited', '', 1),
    ]);
  });

  test('reads no output, and an empty array, as no containers', () => {
    expect(parsePs('')).toEqual([]);
    expect(parsePs('\n')).toEqual([]);
    expect(parsePs('[]')).toEqual([]);
  });
});

describe('classify', () => {
  test.each([
    [[], 'pending', 'creating'],
    [[row('db', 'running')], 'ready', 'running'],
    [[row('db', 'running', 'healthy')], 'ready', 'healthy'],
    [[row('db', 'running', 'starting')], 'pending', 'waiting for healthy'],
    [[row('db', 'running', 'unhealthy')], 'failed', 'unhealthy'],
    [[row('db', 'exited', '', 0)], 'ready', 'exited (0)'],
    [[row('db', 'exited', '', 3)], 'failed', 'exited (3)'],
    [[row('db', 'dead')], 'failed', 'dead'],
    [[row('db', 'created')], 'pending', 'created'],
    [[row('db', 'restarting')], 'pending', 'restarting'],
    [[row('db', 'paused')], 'pending', 'paused'],
    [[row('db', 'removing')], 'pending', 'removing'],
  ] as const)('%j → %s (%s)', (rows, state, detail) => {
    expect(classify([...rows])).toEqual({ state, detail });
  });

  test('a service with several containers is ready when all are, failed when any is', () => {
    expect(classify([row('web', 'running'), row('web', 'running')]).state).toBe('ready');
    expect(classify([row('web', 'running'), row('web', 'running', 'starting')])).toEqual({
      state: 'pending',
      detail: 'waiting for healthy',
    });
    expect(classify([row('web', 'running', 'starting'), row('web', 'exited', '', 1)])).toEqual({
      state: 'failed',
      detail: 'exited (1)',
    });
  });
});

describe('stateOf', () => {
  test.each([
    [[], 'stopped'],
    [[row('db', 'running')], 'running'],
    [[row('db', 'running', 'healthy')], 'running'],
    [[row('db', 'running', 'starting')], 'starting'],
    [[row('db', 'restarting')], 'starting'],
    [[row('db', 'running', 'unhealthy')], 'stopped'],
    [[row('db', 'exited', '', 0)], 'running'],
    [[row('db', 'exited', '', 3)], 'stopped'],
  ] as const)('%j → %s', (rows, state) => {
    expect(stateOf([...rows])).toBe(state);
  });

  test('reads every target from one `ps`, without the second look `up` gives a new container', async () => {
    const { provider, subs } = setup((args) =>
      args[0] === 'ps'
        ? ndjson(container('a1', 'db', 'running'), row('redis', 'running', 'starting'))
        : undefined,
    );
    expect(await provider.readStates(['db', 'redis', 'mail'])).toEqual(
      new Map([
        ['db', 'running'],
        ['redis', 'starting'],
        ['mail', 'stopped'],
      ]),
    );
    expect(subs()).toEqual([['ps', '--all', '--format', 'json', 'db', 'redis', 'mail']]);
  });
});

describe('watchStates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A provider whose `ps` answers from `states` and whose event streams the test drives. */
  function watched(initial: string | null = 'running') {
    vi.useFakeTimers();
    // The db container's State, or `null` for no container at all.
    let dbState = initial;
    const streams: {
      args: string[];
      emit: (line: string) => void;
      end: () => void;
      stopped: boolean;
    }[] = [];
    const stream: Stream = (_command, args, opts) => {
      let end!: (code: number) => void;
      const entry = {
        args,
        emit: (line: string) => opts.onLine?.(line, false),
        end: () => end(0),
        stopped: false,
      };
      streams.push(entry);
      return {
        stop: () => {
          entry.stopped = true;
        },
        done: new Promise<number>((resolve) => (end = resolve)),
      };
    };
    const { provider, subs } = setup(
      (args) =>
        args[0] === 'ps' ? (dbState === null ? ok() : ndjson(row('db', dbState))) : undefined,
      {},
      stream,
    );
    const reports: string[] = [];
    const watch = provider.watchStates(['db'], (states) => reports.push(states.get('db')!));
    return {
      watch,
      reports,
      streams,
      subs,
      setDb: (state: string | null) => (dbState = state),
    };
  }

  test('reports the states at once, then again after events settle — one read for a burst', async () => {
    const { reports, streams, subs, setDb, watch } = watched();
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toEqual(['running']);
    expect(sub({ command: 'docker', args: streams[0]!.args, cwd: WS, env: {} })).toEqual([
      'events',
      '--json',
      'db',
    ]);
    setDb(null);
    streams[0]!.emit('{"action":"die"}');
    streams[0]!.emit('{"action":"stop"}');
    await vi.advanceTimersByTimeAsync(200);
    expect(reports).toEqual(['running', 'stopped']);
    expect(subs().filter((s) => s[0] === 'ps')).toHaveLength(2);
    watch.stop();
  });

  test('re-reads while a service is starting, and stops once it is running', async () => {
    const { reports, setDb, watch } = watched('restarting');
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toEqual(['starting']);
    setDb('running');
    await vi.advanceTimersByTimeAsync(2000);
    expect(reports).toEqual(['starting', 'running']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports).toEqual(['starting', 'running']);
    watch.stop();
  });

  test('restarts an event stream that ended, and reads again', async () => {
    const { reports, streams, watch } = watched();
    await vi.advanceTimersByTimeAsync(0);
    streams[0]!.end();
    await vi.advanceTimersByTimeAsync(5000);
    expect(streams).toHaveLength(2);
    expect(reports).toEqual(['running', 'running']);
    watch.stop();
  });

  test('reports nothing once stopped, and stops its stream', async () => {
    const { reports, streams, watch } = watched();
    await vi.advanceTimersByTimeAsync(0);
    watch.stop();
    streams[0]!.emit('{"action":"die"}');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports).toEqual(['running']);
    expect(streams[0]!.stopped).toBe(true);
  });
});

describe('selectVolumes', () => {
  const config: ComposeConfig = {
    services: {
      db: {
        volumes: [
          { type: 'volume', source: 'db-data', target: '/var/lib/postgresql' },
          { type: 'volume', target: '/anonymous' },
          { type: 'bind', source: '/repos/example/initdb', target: '/initdb' },
          { type: 'volume', source: 'shared', target: '/shared' },
          { type: 'volume', source: 'backups', target: '/backups' },
        ],
      },
      redis: { volumes: [{ type: 'volume', source: 'shared', target: '/shared' }] },
      worker: {},
    },
    volumes: {
      'db-data': { name: 'example-test_db-data' },
      shared: { name: 'example-test_shared' },
      backups: { name: 'company-backups', external: true },
    },
  };

  test("removes a target's own named volume, by the name Compose resolved", () => {
    expect(selectVolumes(config, ['db']).remove).toEqual(['example-test_db-data']);
  });

  test('keeps a volume another service also mounts, and an external one, with the reason', () => {
    expect(selectVolumes(config, ['db']).kept).toEqual([
      { name: 'example-test_shared', reason: 'also mounted by redis' },
      { name: 'company-backups', reason: 'external' },
    ]);
  });

  test('removes a shared volume once every service mounting it is a target', () => {
    expect(selectVolumes(config, ['db', 'redis']).remove).toEqual([
      'example-test_db-data',
      'example-test_shared',
    ]);
  });

  test('ignores anonymous volumes and bind mounts, and a service with no volumes', () => {
    expect(selectVolumes(config, ['worker'])).toEqual({ remove: [], kept: [] });
  });
});

describe('lifecycle primitives', () => {
  test('up starts every target in one detached call, then polls ps', async () => {
    let polls = 0;
    const { provider, subs } = setup(
      servicesThen((args) => {
        if (args[0] === 'ps') {
          polls += 1;
          // 1: before `up`, both already running. 2: db still starting. 3: db healthy.
          return polls <= 2
            ? ndjson(
                container('c1', 'db', 'running', 'starting'),
                container('c2', 'redis', 'running'),
              )
            : ndjson(container('c1', 'db', 'running', 'healthy'));
        }
        return undefined;
      }),
    );
    const summary = await provider.up({});
    expect(summary.ok).toBe(true);
    expect(subs()).toEqual([
      ['config', '--services'],
      // one look before the start: what is running, and whose data already exists
      ['ps', '--all', '--format', 'json', 'db', 'redis'],
      ['config', '--format', 'json'],
      ['volume', 'ls', '--format', '{{.Name}}'],
      ['up', '--detach', '--remove-orphans', '--quiet-pull', 'db', 'redis'],
      ['ps', '--all', '--format', 'json', 'db', 'redis'],
      ['ps', '--all', '--format', 'json', 'db'],
    ]);
  });

  test('a container with no healthcheck that this run started must be seen running twice', async () => {
    let polls = 0;
    const events: InfraEvent[] = [];
    const { provider } = setup((args) => {
      if (args.join(' ') === 'config --services') {
        return ok('redis\n');
      }
      if (args[0] === 'ps') {
        polls += 1;
        // Nothing before `up`; then running on every reading after it.
        return polls === 1 ? ok('') : ndjson(container('c9', 'redis', 'running'));
      }
      return undefined;
    });
    expect((await provider.up({ onEvent: (e) => events.push(e) })).ok).toBe(true);
    expect(polls).toBe(3);
    expect(events).toContainEqual({
      type: 'status',
      service: 'redis',
      status: 'starting',
      detail: 'started',
    });
  });

  test('a container that crashes right after starting is not mistaken for ready', async () => {
    let polls = 0;
    const { provider } = setup((args) => {
      if (args.join(' ') === 'config --services') {
        return ok('redis\n');
      }
      if (args[0] === 'ps') {
        polls += 1;
        if (polls === 1) {
          return ok('');
        }
        // Docker still says "running" on the first look after `up`, then catches up.
        return polls === 2
          ? ndjson(container('c9', 'redis', 'running'))
          : ndjson({ ...container('c9', 'redis', 'exited'), ExitCode: 3 });
      }
      return undefined;
    });
    const summary = await provider.up({});
    expect(summary.services[0]).toMatchObject({ service: 'redis', ok: false });
    expect(summary.services[0]!.error).toMatch(/^exited \(3\)/);
  });

  test("ignores one-off `compose run` containers, which ps lists under the service's name", async () => {
    // An open `stackctl infra docker-compose run db psql` inherits db's healthcheck, and with no
    // server inside it never passes — it must not decide whether `db` itself is ready.
    const oneOff = {
      ...container('r1', 'db', 'running', 'unhealthy'),
      Labels: 'com.docker.compose.project=example-test,com.docker.compose.oneoff=True',
    };
    const real = {
      ...container('c1', 'db', 'running', 'healthy'),
      Labels: 'com.docker.compose.oneoff=False,com.docker.compose.project=example-test',
    };
    const { provider } = setup((args) => {
      if (args.join(' ') === 'config --services') {
        return ok('db\n');
      }
      return args[0] === 'ps' ? ndjson(real, oneOff) : undefined;
    });
    expect(await provider.up({})).toEqual({ ok: true, services: [{ service: 'db', ok: true }] });
  });

  test('a container that was already running is ready on the first look', async () => {
    let polls = 0;
    const { provider } = setup((args) => {
      if (args.join(' ') === 'config --services') {
        return ok('redis\n');
      }
      if (args[0] === 'ps') {
        polls += 1;
        return ndjson(container('c9', 'redis', 'running'));
      }
      return undefined;
    });
    expect((await provider.up({})).ok).toBe(true);
    expect(polls).toBe(2);
  });

  test('a failed container reports its state with the tail of its logs', async () => {
    const { provider, subs } = setup(
      servicesThen((args) => {
        if (args[0] === 'ps') {
          return ndjson(row('db', 'exited', '', 1), row('redis', 'running'));
        }
        if (args[0] === 'logs') {
          return ok('FATAL: password authentication failed\n');
        }
        return undefined;
      }),
    );
    const summary = await provider.up({});
    expect(summary.services[0]).toEqual({
      service: 'db',
      ok: false,
      error: 'exited (1)\nFATAL: password authentication failed',
    });
    expect(subs()).toContainEqual(['logs', '--no-color', '--tail', '20', 'db']);
  });

  test('a failed `up` fails every service with what Compose said', async () => {
    const { provider } = setup(
      servicesThen((args) =>
        args[0] === 'up' ? fail('Cannot connect to the Docker daemon') : undefined,
      ),
    );
    const summary = await provider.up({});
    expect(summary.ok).toBe(false);
    expect(summary.services[0]!.error).toMatch(/Cannot connect to the Docker daemon/);
  });

  test("Compose's progress lines are reported as output, not as errors", async () => {
    const events: InfraEvent[] = [];
    const { provider } = setup(
      servicesThen((args) => {
        if (args[0] === 'up') {
          return { exitCode: 0, stdout: '', stderr: ' Container example-test-db-1 Started \n' };
        }
        return args[0] === 'ps' ? ndjson(row('db', 'running'), row('redis', 'running')) : undefined;
      }),
    );
    await provider.up({ onEvent: (e) => events.push(e) });
    expect(events.filter((e) => e.type === 'output')).toEqual([
      { type: 'output', line: 'Container example-test-db-1 Started', isError: false },
    ]);
  });

  test('a full destroy is one `down --volumes --remove-orphans`', async () => {
    const { provider, subs } = setup(servicesThen(() => undefined));
    expect((await provider.destroy({})).ok).toBe(true);
    expect(subs()).toEqual([
      ['config', '--services'],
      ['down', '--volumes', '--remove-orphans'],
    ]);
  });

  test('a named destroy removes the container, then only the volumes that service owns', async () => {
    const config: ComposeConfig = {
      services: {
        db: {
          volumes: [
            { type: 'volume', source: 'db-data' },
            { type: 'volume', source: 'shared' },
          ],
        },
        redis: { volumes: [{ type: 'volume', source: 'shared' }] },
      },
      volumes: {
        'db-data': { name: 'example-test_db-data' },
        shared: { name: 'example-test_shared' },
      },
    };
    const events: InfraEvent[] = [];
    const { provider, calls } = setup(
      servicesThen((args) =>
        args.join(' ') === 'config --format json' ? ok(JSON.stringify(config)) : undefined,
      ),
    );
    await provider.destroy({ services: ['db'], onEvent: (e) => events.push(e) });
    expect(calls.map((c) => (c.args[0] === 'compose' ? sub(c) : c.args))).toEqual([
      ['config', '--services'],
      ['rm', '--stop', '--force', '--volumes', 'db'],
      ['config', '--format', 'json'],
      ['volume', 'rm', 'example-test_db-data'],
    ]);
    // Never the unsafe form: `down <service> --volumes` also deletes siblings' volumes.
    expect(calls.some((c) => c.args.includes('down'))).toBe(false);
    expect(events.filter((e) => e.type === 'output').map((e) => e.line)).toEqual([
      'kept volume example-test_shared: also mounted by redis',
      'removed volume example-test_db-data',
    ]);
  });

  test('a named destroy tolerates a volume that never existed and keeps one still in use', async () => {
    const config: ComposeConfig = {
      services: {
        db: {
          volumes: [
            { type: 'volume', source: 'a' },
            { type: 'volume', source: 'b' },
          ],
        },
      },
      volumes: { a: { name: 'p_a' }, b: { name: 'p_b' } },
    };
    const events: InfraEvent[] = [];
    const { provider } = setup(
      servicesThen((args) => {
        if (args.join(' ') === 'config --format json') {
          return ok(JSON.stringify(config));
        }
        if (args.join(' ') === 'volume rm p_a') {
          return fail('Error response from daemon: get p_a: no such volume');
        }
        if (args.join(' ') === 'volume rm p_b') {
          return fail('Error response from daemon: remove p_b: volume is in use - [9a03]');
        }
        return undefined;
      }),
    );
    const summary = await provider.destroy({ services: ['db'], onEvent: (e) => events.push(e) });
    expect(summary.ok).toBe(true);
    expect(events.filter((e) => e.type === 'output').map((e) => e.line)).toEqual([
      'kept volume p_b: in use by another container',
    ]);
  });

  test('a volume that cannot be removed for any other reason fails the destroy', async () => {
    const config: ComposeConfig = {
      services: { db: { volumes: [{ type: 'volume', source: 'a' }] } },
      volumes: { a: { name: 'p_a' } },
    };
    const { provider } = setup(
      servicesThen((args) => {
        if (args.join(' ') === 'config --format json') {
          return ok(JSON.stringify(config));
        }
        return args[0] === 'volume' ? fail('permission denied') : undefined;
      }),
    );
    const summary = await provider.destroy({ services: ['db'] });
    expect(summary.services[0]!.error).toMatch(/p_a[\s\S]*permission denied/);
  });
});

describe('fresh', () => {
  const config: ComposeConfig = {
    services: {
      db: { volumes: [{ type: 'volume', source: 'db-data' }] },
      redis: {},
    },
    volumes: { 'db-data': { name: 'example-test_db-data' } },
  };

  /** Runs `up` over a Docker in the given state; returns the `fresh` each afterReady saw. */
  async function freshSeen(state: { volumes: string[]; containers: string[] }) {
    const seen: Record<string, boolean> = {};
    const note = { enabled: true, afterReady: (ctx: { service: { name: string }; fresh: boolean }) => {
      seen[ctx.service.name] = ctx.fresh;
    } }; // oxfmt-ignore
    let polls = 0;
    const { provider } = setup(
      servicesThen((args) => {
        if (args.join(' ') === 'config --format json') {
          return ok(JSON.stringify(config));
        }
        if (args[0] === 'volume' && args[1] === 'ls') {
          return ok(state.volumes.join('\n'));
        }
        if (args[0] === 'ps') {
          polls += 1;
          // The first reading is the one taken before `up`; after it, everything is running.
          const services = polls === 1 ? state.containers : ['db', 'redis'];
          return ndjson(...services.map((s) => container(`id-${s}`, s, 'running', 'healthy')));
        }
        return undefined;
      }),
      { services: { db: note, redis: note } },
    );
    expect((await provider.up({})).ok).toBe(true);
    return seen;
  }

  test('nothing exists yet: every service is fresh', async () => {
    expect(await freshSeen({ volumes: [], containers: [] })).toEqual({ db: true, redis: true });
  });

  test('a service with a named volume goes by the volume, not the container', async () => {
    // After `infra stop`: the containers are gone and the data is still there.
    expect(await freshSeen({ volumes: ['example-test_db-data'], containers: [] })).toEqual({
      db: false,
      redis: true,
    });
    // A new volume under an old container can't happen, but the rule is the volume either way.
    expect(await freshSeen({ volumes: [], containers: ['db', 'redis'] })).toEqual({
      db: true,
      redis: false,
    });
  });

  test('a service with no named volume is fresh when it had no container', async () => {
    expect(
      await freshSeen({ volumes: ['example-test_db-data'], containers: ['db', 'redis'] }),
    ).toEqual({ db: false, redis: false });
  });

  test("another project's volume of a similar name does not count", async () => {
    expect(await freshSeen({ volumes: ['example-development_db-data'], containers: [] })).toEqual({
      db: true,
      redis: true,
    });
  });
});

describe('down, the passthrough, and the compose helper', () => {
  test('down hands the terminal to `docker compose down`, and never asks for volumes', async () => {
    const { provider, inherited } = setup();
    expect(await provider.down(['db'])).toBe(7);
    expect(inherited).toEqual([
      {
        command: 'docker',
        args: ['compose', '--project-directory', WS, 'down', 'db'],
        cwd: WS,
        env: { DB_PORT: '21052', COMPOSE_PROJECT_NAME: 'example-test' },
      },
    ]);
    await provider.down([]);
    expect(inherited.flatMap((c) => c.args)).not.toContain('--volumes');
  });

  test('the passthrough runs where the user is standing, with the arguments untouched', async () => {
    const { provider, inherited } = setup();
    const args = ['build', '-m', '2g', '--', 'db'];
    expect(await provider.passthrough(args, `${WS}/packages/backend`)).toBe(7);
    expect(inherited[0]).toEqual({
      command: 'docker',
      args: ['compose', '--project-directory', WS, ...args],
      cwd: `${WS}/packages/backend`,
      env: { DB_PORT: '21052', COMPOSE_PROJECT_NAME: 'example-test' },
    });
  });

  test("a callback's compose helper targets the same project, with output as service events", async () => {
    const events: InfraEvent[] = [];
    const { provider, calls } = setup(
      servicesThen((args) => {
        if (args[0] === 'ps') {
          return ndjson(row('db', 'running'), row('redis', 'running'));
        }
        return args[0] === 'exec' ? fail('psql: could not connect', 2) : undefined;
      }),
      {
        services: {
          db: {
            enabled: true,
            afterReady: async ({ compose, envs }) => {
              expect(envs.COMPOSE_PROJECT_NAME).toBe('example-test');
              await compose(['exec', '-T', 'db', 'psql', '-c', 'SELECT 1']);
            },
          },
        },
      },
    );
    const summary = await provider.up({ onEvent: (e) => events.push(e) });
    const exec = calls.find((c) => sub(c)[0] === 'exec')!;
    expect(exec.args.slice(0, 3)).toEqual(['compose', '--project-directory', WS]);
    expect(exec.env.COMPOSE_PROJECT_NAME).toBe('example-test');
    expect(summary.services[0]!.error).toBe(
      'afterReady failed: `docker compose exec -T db psql -c SELECT 1` exited with code 2',
    );
    expect(events).toContainEqual({
      type: 'output',
      service: 'db',
      line: 'psql: could not connect',
      isError: true,
    });
  });
});
