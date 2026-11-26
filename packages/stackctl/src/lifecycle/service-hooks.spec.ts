import { expect, test, vi } from 'vitest';
import { type Config, defineConfig } from '../config';
import type { ExecOptions } from '../spawn';
import { createServiceHooks } from './service-hooks';
import type { ServiceStartContext } from './service-types';

test("run builds the service's context", async () => {
  let seen: ServiceStartContext | undefined;
  let urlsSaw: { service: unknown; buildAddress: unknown } | undefined;
  const config = defineConfig({
    workspaceDir: '/ws',
    serviceRootDir: 'packages',
    tokens: { domain: 'example.com', scheme: 'https' },
    services: {
      api: {
        port: 21001,
        tokens: { region: 'us-east', scheme: 'http' },
        urls: (ctx) => {
          urlsSaw = ctx;
          return [];
        },
        lifecycle: {
          beforeStart: async (ctx) => {
            seen = ctx;
            ctx.log('migrating');
            await ctx.exec('echo', ['hi']);
          },
        },
      },
    },
  }) as unknown as Config<string>;
  const write = vi.fn();
  const cwds: string[] = [];
  const exec = async (_c: string, _a: string[], opts: ExecOptions) => {
    cwds.push(opts.cwd);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const hooks = createServiceHooks({
    config,
    envFor: () => ({ GREETING: 'hello' }),
    write,
    exec,
  });
  const data = {};
  expect(await hooks.run('api', 'beforeStart', 'session', data)).toBe('done');
  expect(seen!.trigger).toBe('session');
  expect(seen!.service.name).toBe('api');
  expect(seen!.service.port).toBe(21001);
  expect(seen!.buildAddress()).toBe('http://localhost:21001');
  // What its `urls` callbacks got, the same objects.
  expect(seen!.service).toBe(urlsSaw!.service);
  expect(seen!.buildAddress).toBe(urlsSaw!.buildAddress);
  expect(seen!.tokens).toEqual({ domain: 'example.com', scheme: 'http', region: 'us-east' });
  expect(seen!.envs).toEqual({ GREETING: 'hello' });
  expect(seen!.data).toBe(data);
  expect(seen!.workspaceDir).toBe('/ws');
  expect(cwds).toEqual(['/ws/packages/api']);
  expect(write).toHaveBeenCalledWith('api', 'migrating', false);
});

test("has is true only for a hook the service defines; run of any other is 'none'", async () => {
  const config = defineConfig({
    workspaceDir: '/ws',
    serviceRootDir: 'packages',
    services: { api: { lifecycle: { afterStart: () => {} } }, web: {} },
  }) as unknown as Config<string>;
  const hooks = createServiceHooks({ config, envFor: () => ({}), write: () => {} });
  expect(hooks.has('web', 'beforeStart')).toBe(false);
  expect(hooks.has('api', 'beforeStart')).toBe(false);
  expect(hooks.has('api', 'afterStart')).toBe(true);
  expect(hooks.has('nope', 'afterStart')).toBe(false);
  expect(await hooks.run('web', 'beforeStart', 'start', {})).toBe('none');
});

test('run reports a hook that throws, and an environment that fails to build, as an error', async () => {
  const config = defineConfig({
    workspaceDir: '/ws',
    serviceRootDir: 'packages',
    services: {
      api: {
        lifecycle: {
          beforeStart: () => {
            throw new Error('boom');
          },
        },
      },
    },
  }) as unknown as Config<string>;
  const hooks = createServiceHooks({ config, envFor: () => ({}), write: () => {} });
  expect(await hooks.run('api', 'beforeStart', 'start', {})).toEqual({ error: 'boom' });
  const broken = createServiceHooks({
    config,
    envFor: () => {
      throw new Error('cannot read .env');
    },
    write: () => {},
  });
  expect(await broken.run('api', 'beforeStart', 'start', {})).toEqual({
    error: 'cannot read .env',
  });
});

test("the signal a hook's commands are asked to end by aborts with its budget; the one that kills them, with the hooks' signal", async () => {
  const config = defineConfig({
    workspaceDir: '/ws',
    serviceRootDir: 'packages',
    services: {
      api: {
        lifecycle: {
          beforeStop: async (ctx) => {
            await ctx.exec('deregister');
          },
        },
      },
    },
  }) as unknown as Config<string>;
  const seen: ExecOptions[] = [];
  const exec = async (_c: string, _a: string[], opts: ExecOptions) => {
    seen.push(opts);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const hardKill = new AbortController();
  const hooks = createServiceHooks({ config, envFor: () => ({}), write: () => {}, exec, signal: hardKill.signal }); // oxfmt-ignore
  const budget = new AbortController();
  expect(await hooks.run('api', 'beforeStop', 'quit', {}, budget.signal)).toBe('done');
  expect(await hooks.run('api', 'beforeStop', 'quit', {})).toBe('done');
  const [withBudget, without] = seen as [ExecOptions, ExecOptions];
  expect(without.abandon).toBeUndefined();
  budget.abort();
  expect(withBudget.abandon!.aborted).toBe(true);
  // The budget's end only asks: the kill is the hooks' signal's.
  expect(withBudget.signal!.aborted).toBe(false);
  hardKill.abort();
  expect([withBudget.signal!.aborted, without.signal!.aborted]).toEqual([true, true]);
});

test("commandsEnded resolves once every command the service's hooks started has ended, an abandoned hook's included", async () => {
  const config = defineConfig({
    workspaceDir: '/ws',
    serviceRootDir: 'packages',
    services: {
      api: {
        lifecycle: {
          afterReady: async (ctx) => {
            await ctx.exec('register');
          },
        },
      },
      web: {},
    },
  }) as unknown as Config<string>;
  let end!: () => void;
  const exec = () =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      end = () => resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
  const hooks = createServiceHooks({ config, envFor: () => ({}), write: () => {}, exec });
  // None runs: at once.
  await hooks.commandsEnded('api');
  const budget = new AbortController();
  const running = hooks.run('api', 'afterReady', 'start', {}, budget.signal);
  await vi.waitFor(() => expect(end).toBeDefined());
  budget.abort();
  expect(await running).toBe('abandoned');
  let ended = false;
  void hooks.commandsEnded('api').then(() => (ended = true));
  await hooks.commandsEnded('web');
  await new Promise((resolve) => setImmediate(resolve));
  expect(ended).toBe(false);
  end();
  await hooks.commandsEnded('api');
});
