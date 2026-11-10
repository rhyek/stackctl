import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { defineConfig } from '../config.js';
import type { Exec } from './exec.js';
import { InfraFailedError, runSessionInfra } from './session.js';

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-infra-session-'));
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

/** A Docker with a `db` service in whatever state `dbState` says. */
function docker(dbState: { State: string; ExitCode?: number }): Exec {
  return async (_command, args) => {
    const sub = args.slice(3).join(' ');
    if (sub === 'config --services') {
      return { exitCode: 0, stdout: 'db\n', stderr: '' };
    }
    if (sub.startsWith('ps ')) {
      return { exitCode: 0, stdout: JSON.stringify({ Service: 'db', ...dbState }), stderr: '' };
    }
    if (sub === 'config --format json') {
      return { exitCode: 0, stdout: '{}', stderr: '' };
    }
    if (sub.startsWith('logs ')) {
      return { exitCode: 0, stdout: 'FATAL: bad config\n', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('runSessionInfra', () => {
  test('is undefined when the config declares no infra', async () => {
    defineConfig({ workspaceDir: ws, serviceRootDir: 'packages', services: { web: {} } });
    expect(await runSessionInfra()).toBeUndefined();
  });

  test('brings everything up and returns the services; what it printed goes out as events', async () => {
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      infra: {
        'docker-compose': {
          services: { db: { afterReady: ({ log }) => log('2 migrations applied') } },
        },
      },
      services: { web: {} },
    });
    const seen: string[] = [];
    const printed: string[] = [];
    const infra = await runSessionInfra(
      (e) => {
        seen.push(e.type);
        if (e.type === 'output') {
          printed.push(`${String(e.service)}: ${e.line}`);
        }
      },
      {
        exec: docker({ State: 'running' }),
      },
    );
    expect(infra).toEqual({
      services: [{ provider: 'docker-compose', name: 'db' }],
      watch: expect.any(Function),
      readMemory: expect.any(Function),
    });
    expect(printed).toEqual(['db: 2 migrations applied']);
    expect(seen).toContain('targets');
  });

  test("carries a service's resolved urls, for the footer", async () => {
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: 'example.test', scheme: 'http', port: 4000 },
        routes: [{ subdomain: 'db', service: 'db' }],
      },
      infra: { 'docker-compose': { services: { db: { port: 5432, urls: [''] } } } },
      services: { web: {} },
    });
    const infra = await runSessionInfra(undefined, { exec: docker({ State: 'running' }) });
    expect(infra?.services).toEqual([
      { provider: 'docker-compose', name: 'db', urls: ['http://db.example.test:4000'] },
    ]);
  });

  test('throws when a service does not come up, naming it and why', async () => {
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      infra: { 'docker-compose': {} },
      services: { web: {} },
    });
    const failure = await runSessionInfra(undefined, {
      exec: docker({ State: 'exited', ExitCode: 1 }),
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(InfraFailedError);
    expect((failure as InfraFailedError).message).toBe('db: exited (1)\nFATAL: bad config');
  });

  test("a failed callback's error carries what the callback printed, so the reason is visible", async () => {
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      infra: {
        'docker-compose': {
          services: {
            db: {
              afterReady: ({ log }) => {
                log('applying 0002_add_index');
                log('ERROR: relation "todos" does not exist');
                throw new Error('`migrate` exited with code 1');
              },
            },
          },
        },
      },
      services: { web: {} },
    });
    const failure = await runSessionInfra(undefined, { exec: docker({ State: 'running' }) }).catch(
      (err: unknown) => err,
    );
    expect((failure as InfraFailedError).message).toBe(
      [
        'db: afterReady failed: `migrate` exited with code 1',
        '    applying 0002_add_index',
        '    ERROR: relation "todos" does not exist',
      ].join('\n'),
    );
  });

  test('keeps only the tail of a long output', async () => {
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      infra: {
        'docker-compose': {
          services: {
            db: {
              afterReady: ({ log }) => {
                for (let i = 1; i <= 40; i++) {
                  log(`line ${String(i)}`);
                }
                throw new Error('boom');
              },
            },
          },
        },
      },
      services: { web: {} },
    });
    const failure = await runSessionInfra(undefined, { exec: docker({ State: 'running' }) }).catch(
      (err: unknown) => err,
    );
    const lines = (failure as InfraFailedError).message.split('\n');
    expect(lines).toHaveLength(1 + 15);
    expect(lines[1]).toBe('    line 26');
    expect(lines.at(-1)).toBe('    line 40');
  });
});
