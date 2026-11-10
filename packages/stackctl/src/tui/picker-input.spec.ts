import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { defineConfig } from '../config.js';
import { pickerInputOf, planRuns } from './picker-input.js';

let ws: string;

/** A service directory under `ws/apps`, with a `dev` script unless `dev` is false. */
function app(name: string, dev = true): void {
  const dir = path.join(ws, 'apps', name);
  fs.mkdirSync(dir, { recursive: true });
  const scripts = dev ? { dev: 'node server.js' } : { build: 'tsc' };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, scripts }));
}

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-picker-input-'));
  for (const name of ['api', 'web', 'hidden', 'cron', 'codegen']) {
    app(name);
  }
  app('nodev', false);
  defineConfig({
    workspaceDir: ws,
    serviceRootDir: 'apps',
    infra: { 'docker-compose': { services: { db: {}, mail: { port: 3100 } } } },
    services: {
      api: {},
      web: { deps: ['api'] },
      hidden: { selectable: false },
      cron: { autostart: false },
      codegen: { command: null },
      nodev: {},
    },
  } as unknown as Parameters<typeof defineConfig>[0]);
});

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('pickerInputOf', () => {
  test('a row needs selectable and startable; launching needs startable and autostart', () => {
    const input = pickerInputOf([]);
    const flags = Object.fromEntries(
      input.services.map((s) => [s.name, { hasRow: s.hasRow, launches: s.launches }]),
    );
    expect(flags).toEqual({
      api: { hasRow: true, launches: true },
      web: { hasRow: true, launches: true },
      // Not shown, but it runs when something pulls it in.
      hidden: { hasRow: false, launches: true },
      // Shown and pickable; it joins the session left stopped.
      cron: { hasRow: true, launches: false },
      // `command: null` and no dev script: never shown, never started.
      codegen: { hasRow: false, launches: false },
      nodev: { hasRow: false, launches: false },
    });
  });

  test('services come most depended-on first, with their deps and dependents', () => {
    const input = pickerInputOf([]);
    expect(input.services[0]).toEqual({
      name: 'api',
      deps: [],
      dependents: ['web'],
      hasRow: true,
      launches: true,
    });
    expect(input.services.find((s) => s.name === 'web')?.deps).toEqual(['api']);
    expect(input.services.map((s) => s.name).slice(1)).toEqual([
      'codegen',
      'cron',
      'hidden',
      'nodev',
      'web',
    ]);
  });

  test('the infra, the saved names and the workspace come through', () => {
    const input = pickerInputOf(['web', 'cron']);
    expect(input.infra).toEqual(['db', 'mail']);
    expect(input.saved).toEqual(['web', 'cron']);
    expect(input.workspace.name).toBe(path.basename(process.cwd()));
  });

  test('planRuns is the selection plan: the picks and their direct deps', () => {
    expect(planRuns(['web'])).toEqual([
      { name: 'api', why: 'runtime dep of web' },
      { name: 'web', why: null },
    ]);
  });
});
