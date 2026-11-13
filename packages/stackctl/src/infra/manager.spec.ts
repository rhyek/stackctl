import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { defineConfig } from '../config.js';
import { type Exec, execLines } from '../spawn.js';
import { InfraManager } from './manager.js';
import { type InfraInput, InfraError } from './types.js';

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-infra-manager-'));
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

/** A Docker that knows two services, which are running as soon as they are asked about. */
function scriptedDocker() {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const exec: Exec = async (_command, args, opts) => {
    calls.push({ args, env: opts.env });
    const sub = args.slice(3).join(' ');
    if (sub === 'config --services') {
      return { exitCode: 0, stdout: 'db\nredis\n', stderr: '' };
    }
    if (sub.startsWith('ps ')) {
      const rows = args.slice(7).map((Service) => JSON.stringify({ Service, State: 'running' }));
      return { exitCode: 0, stdout: rows.join('\n'), stderr: '' };
    }
    if (sub === 'config --format json') {
      return { exitCode: 0, stdout: '{}', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

const configWith = (infra: InfraInput<{ region: string }>) =>
  defineConfig({
    workspaceDir: ws,
    serviceRootDir: 'packages',
    tokens: { region: 'eu' },
    infra,
    services: { web: {} },
  });

describe('InfraManager', () => {
  test('is null for a config with no infra', async () => {
    const config = defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      services: { web: {} },
    });
    expect(await InfraManager.fromConfig(config)).toBeNull();
  });

  test("runs Compose with the mode's workspace env and the mode's project name", async () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'DB_PORT=21051\n');
    const { exec, calls } = scriptedDocker();
    const manager = (await InfraManager.fromConfig(configWith({ 'docker-compose': {} }), {
      exec,
    }))!;
    expect((await manager.up()).ok).toBe(true);
    expect(calls[0]!.env).toMatchObject({
      DB_PORT: '21051',
      COMPOSE_PROJECT_NAME: `${path.basename(ws).toLowerCase()}-development`,
    });
  });

  // The TUI builds its manager with signal handlers already installed: a read that doesn't
  // return, on the event loop's thread, would leave it unable to stop until it did.
  test("reads the workspace's .env files without blocking its own thread", async () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'DB_PORT=21051\n');
    const config = configWith({ 'docker-compose': {} });
    const isEnvFile = (p: unknown) => typeof p === 'string' && path.basename(p).startsWith('.env');
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const existsSync = vi.spyOn(fs, 'existsSync');
    const { exec, calls } = scriptedDocker();
    const manager = (await InfraManager.fromConfig(config, { exec }))!;
    expect(readFileSync.mock.calls.filter(([p]) => isEnvFile(p))).toEqual([]);
    expect(existsSync.mock.calls.filter(([p]) => isEnvFile(p))).toEqual([]);
    expect((await manager.up()).ok).toBe(true);
    expect(calls[0]!.env).toMatchObject({ DB_PORT: '21051' });
  });

  test("runs Compose with the config's own vars, under the workspace env files", async () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'DB_PORT=21051\nDATA_DIR=from-file\n');
    const { exec, calls } = scriptedDocker();
    const config = defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      env: { vars: { DATA_DIR: '/srv/data', CACHE_DIR: '/srv/cache' } },
      infra: { 'docker-compose': {} },
      services: { web: {} },
    });
    const manager = (await InfraManager.fromConfig(config, { exec }))!;
    expect((await manager.up()).ok).toBe(true);
    expect(calls[0]!.env).toMatchObject({
      DB_PORT: '21051',
      DATA_DIR: 'from-file',
      CACHE_DIR: '/srv/cache',
    });
  });

  test("runs Compose and its callbacks with the config's additional .env files", async () => {
    fs.writeFileSync(path.join(ws, '.env.development.pre'), 'DB_PORT=21051\n');
    fs.writeFileSync(path.join(ws, '.env.development.pre.local'), 'DB_PORT=21061\n');
    fs.writeFileSync(path.join(ws, '.env.development'), 'DB_URL=postgres://localhost:${DB_PORT}\n');
    const { exec, calls } = scriptedDocker();
    let seen: unknown;
    const config = defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      env: {
        additionalFiles: ({ mode }) => [
          { file: `.env.${mode}.pre`, before: 'mode' },
          { file: `.env.${mode}.pre.local`, before: 'mode' },
        ],
      },
      infra: {
        'docker-compose': {
          services: {
            db: {
              afterReady: ({ envs }) => {
                seen = envs.DB_URL;
              },
            },
          },
        },
      },
      services: { web: {} },
    });
    const manager = (await InfraManager.fromConfig(config, { exec }))!;
    expect((await manager.up({ services: ['db'] })).ok).toBe(true);
    // What Compose interpolates `${DB_PORT}` in the compose file with.
    expect(calls[0]!.env).toMatchObject({ DB_PORT: '21061', DB_URL: 'postgres://localhost:21061' });
    expect(seen).toBe('postgres://localhost:21061');
  });

  test("a callback's exec runs the command with the workspace env, in the workspace, for real", async () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'DB_PORT=21051\nSHARED=from-file\n');
    fs.mkdirSync(path.join(ws, 'libs', 'db'), { recursive: true });
    const docker = scriptedDocker();
    // Docker is scripted; anything else a callback runs is run.
    const exec: Exec = (command, args, opts) =>
      command === 'docker' ? docker.exec(command, args, opts) : execLines(command, args, opts);
    const printed: string[] = [];
    const print = 'console.log([process.cwd(), process.env.DB_PORT, process.env.SHARED, process.env.COMPOSE_PROJECT_NAME, process.env.STACKCTL_MODE].join(" "))'; // oxfmt-ignore
    const config = configWith({
      'docker-compose': {
        services: {
          db: {
            afterReady: async ({ exec }) => {
              printed.push((await exec(process.execPath, ['-e', print])).stdout.trim());
              const there = { cwd: 'libs/db', env: { SHARED: 'from-call' } };
              printed.push((await exec(process.execPath, ['-e', print], there)).stdout.trim());
            },
          },
        },
      },
    });
    const manager = (await InfraManager.fromConfig(config, { exec }))!;
    expect((await manager.up({ services: ['db'] })).ok).toBe(true);
    const project = `${path.basename(ws).toLowerCase()}-development`;
    const real = fs.realpathSync(ws);
    expect(printed).toEqual([
      `${real} 21051 from-file ${project} development`,
      `${path.join(real, 'libs', 'db')} 21051 from-call ${project} development`,
    ]);
  });

  test('hands callbacks the config tokens, and brings up only the services named', async () => {
    const { exec, calls } = scriptedDocker();
    let seen: unknown;
    const manager = (await InfraManager.fromConfig(
      configWith({
        'docker-compose': {
          services: {
            db: {
              afterReady: ({ tokens, mode }) => {
                seen = { tokens, mode };
              },
            },
          },
        },
      }),
      { exec },
    ))!;
    const summary = await manager.up({ services: ['db'] });
    expect(summary).toEqual({ ok: true, services: [{ service: 'db', ok: true }] });
    expect(seen).toEqual({ tokens: { region: 'eu' }, mode: 'development' });
    expect(calls.map((c) => c.args.slice(3).join(' '))).toContain(
      'up --detach --remove-orphans --quiet-pull db',
    );
  });

  test("hands every callback the session's mode and the resolved config", async () => {
    // What `--mode test` sets before the config loads.
    process.env.STACKCTL_MODE = 'test';
    try {
      const { exec } = scriptedDocker();
      const seen: Record<string, { mode: string; config: unknown }> = {};
      const config = configWith({
        'docker-compose': {
          services: {
            db: {
              beforeStart: ({ mode, config }) => {
                seen.beforeStart = { mode, config };
              },
              afterReady: ({ mode, config }) => {
                seen.afterReady = { mode, config };
              },
            },
          },
        },
      });
      const manager = (await InfraManager.fromConfig(config, { exec }))!;
      expect((await manager.up({ services: ['db'] })).ok).toBe(true);
      for (const hook of ['beforeStart', 'afterReady']) {
        expect(seen[hook]!.mode).toBe('test');
        // The loaded config itself, not a copy — the one `show-config` prints.
        expect(seen[hook]!.config).toBe(config);
        expect(config.envMode).toBe('test');
      }
    } finally {
      delete process.env.STACKCTL_MODE;
    }
  });

  test('rejects a service no provider has, listing the real ones', async () => {
    const { exec } = scriptedDocker();
    const manager = (await InfraManager.fromConfig(configWith({ 'docker-compose': {} }), {
      exec,
    }))!;
    await expect(manager.up({ services: ['cache'] })).rejects.toThrow(InfraError);
    await expect(manager.destroy({ services: ['cache'] })).rejects.toThrow(
      /"cache"[\s\S]*db, redis/,
    );
    await expect(manager.down(['cache'])).rejects.toThrow(/"cache"/);
  });

  test('down goes to the provider with the names, and reports its exit code', async () => {
    const { exec } = scriptedDocker();
    const inherited: string[][] = [];
    const manager = (await InfraManager.fromConfig(configWith({ 'docker-compose': {} }), {
      exec,
      spawnInherit: async (_command, args) => {
        inherited.push(args.slice(3));
        return 3;
      },
    }))!;
    expect(await manager.down(['db'])).toBe(3);
    expect(await manager.down()).toBe(3);
    expect(inherited).toEqual([['down', 'db'], ['down']]);
  });

  test('the passthrough rejects a provider the config does not declare', async () => {
    const manager = (await InfraManager.fromConfig(
      configWith({ 'docker-compose': {} }),
      scriptedDocker(),
    ))!;
    await expect(manager.passthrough('podman', ['ps'], ws)).rejects.toThrow(/no `podman` provider/);
  });
});
