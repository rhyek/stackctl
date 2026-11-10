import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type AnyServiceConfig, defineConfig } from '../config.js';
import { buildSessionPlan, waitsFor } from './plan.js';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-plan-'));
  for (const [name, scripts] of Object.entries({
    db: { dev: 'node db.js' },
    api: { dev: 'node api.js', lint: 'oxlint', seed: 'node seed.js' },
    web: { dev: 'node web.js' },
  })) {
    fs.mkdirSync(path.join(root, 'packages', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', name, 'package.json'), JSON.stringify({ name, scripts })); // oxfmt-ignore
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Registers db ← api ← web, with `extra` merged into the config. */
function load(extra: Record<string, unknown> = {}): void {
  defineConfig({
    workspaceDir: root,
    serviceRootDir: 'packages',
    services: {
      db: { port: 5432, healthcheck: '/health' },
      api: { deps: [{ service: 'db', wait: true }] },
      web: { deps: ['api'] },
    },
    ...extra,
  } as unknown as Parameters<typeof defineConfig>[0]);
}

const names = (services: AnyServiceConfig[]) => services.map((s) => s.name);

describe('buildSessionPlan', () => {
  test('runs the selection and its direct deps in display order, marking the selected names', () => {
    load();
    const plan = buildSessionPlan(['web']);
    expect(names(plan.sortedPackages)).toEqual(['api', 'web']);
    expect([...plan.picked]).toEqual(['web']);
    expect(names(buildSessionPlan(['web', 'db']).sortedPackages)).toEqual(['db', 'api', 'web']);
  });

  test('only a `wait` dep holds a service', () => {
    load();
    const plan = buildSessionPlan(['web', 'api']);
    expect(plan.waitsOn).toEqual({ api: ['db'] });
    expect(waitsFor(plan.sortedPackages.find((s) => s.name === 'web')!)).toEqual([]);
  });

  test('carries the healthchecks and the extra commands of the services it runs', () => {
    load();
    const plan = buildSessionPlan(['api']);
    expect(Object.keys(plan.healthchecks)).toEqual(['db']);
    expect(plan.menuCommands).toEqual({ api: ['lint', 'seed'] });
  });

  test("carries the loaded config's env settings, timestamps and the workspace cwd", () => {
    load({ env: { vars: { FOO: 'bar' }, override: ['FOO'] }, logs: { timestamps: false } });
    const plan = buildSessionPlan(['web']);
    expect(plan.envVars).toEqual({ FOO: 'bar' });
    expect(plan.envOverride).toEqual(['FOO']);
    expect(plan.envFiles).toBeDefined();
    expect(plan.logTimestamps).toBe(false);
    expect(plan.cwd).toBe(process.cwd());
    load();
    expect(buildSessionPlan(['web']).logTimestamps).toBe(true);
  });

  test('normalizes the workspace-wide urls, and leaves them out when the config declares none', () => {
    load({ urls: ['http://localhost:9000', [{ label: 'docs', url: 'http://localhost:9001' }]] });
    expect(buildSessionPlan(['web']).topLevelUrls).toEqual([
      [{ url: 'http://localhost:9000' }],
      [{ label: 'docs', url: 'http://localhost:9001' }],
    ]);
    load();
    expect(buildSessionPlan(['web']).topLevelUrls).toBeUndefined();
  });
});
