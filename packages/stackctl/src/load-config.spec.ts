import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  findConfigPath,
  formatConfigLoadFailure,
  MIN_NODE,
  NoProjectConfigError,
} from './load-config.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-load-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('loadConfig', () => {
  test('throws NoProjectConfigError when no stackctl.config file exists', async () => {
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(NoProjectConfigError);
  });

  test("defineConfig defaults workspaceDir to the config's directory, whatever the cwd", async () => {
    // From source, so the test needs no build.
    const pkgIndex = path.resolve(import.meta.dirname, 'index.ts');
    fs.writeFileSync(
      path.join(dir, 'stackctl.config.mjs'),
      `import { defineConfig } from ${JSON.stringify(pkgIndex)};\n` +
        `export default defineConfig({ serviceRootDir: 'packages', apiPort: 4099, services: { svc: {} } });\n`,
    );
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-elsewhere-'));
    const previous = process.cwd();
    process.chdir(elsewhere);
    try {
      const [svc] = await loadConfig(dir);
      expect(svc?.absoluteDir).toBe(path.join(fs.realpathSync(dir), 'packages', 'svc'));
    } finally {
      process.chdir(previous);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('imports the config module and returns its resolved packages', async () => {
    // A compiled ESM config file (avoids relying on native TS in the test).
    const pkgIndex = path.resolve('packages/stackctl/dist/index.js');
    fs.writeFileSync(
      path.join(dir, 'stackctl.config.mjs'),
      `import { defineConfig } from ${JSON.stringify(pkgIndex)};\n` +
        `export default defineConfig({ serviceRootDir: 'packages', apiPort: 4099, services: { svc: {} } });\n`,
    );
    const packages = await loadConfig(dir);
    expect(packages.map((p: (typeof packages)[0]) => p.name)).toContain('svc');
  });
});

describe('loadConfig failure modes', () => {
  test('rejects with the underlying error — not NoProjectConfigError — when the config throws', async () => {
    fs.writeFileSync(path.join(dir, 'stackctl.config.mjs'), `throw new Error('boom in config');\n`);
    const err = await loadConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoProjectConfigError);
    expect((err as Error).message).toContain('boom in config');
  });
});

describe('formatConfigLoadFailure', () => {
  test('names the config file and includes the underlying error', () => {
    const msg = formatConfigLoadFailure('/w/stackctl.config.ts', new Error('Unexpected token'));
    expect(msg).toContain('Failed to load /w/stackctl.config.ts');
    expect(msg).toContain('Unexpected token');
  });

  test('adds the Node-version hint when Node cannot import TypeScript', () => {
    const err = Object.assign(new TypeError('Unknown file extension ".ts"'), {
      code: 'ERR_UNKNOWN_FILE_EXTENSION',
    });
    const msg = formatConfigLoadFailure('/w/stackctl.config.ts', err, 'v22.17.1');
    expect(msg).toContain('Unknown file extension ".ts"');
    expect(msg).toContain('v22.17.1');
    expect(msg).toContain(`>=${MIN_NODE}`);
  });

  test('omits the Node hint for unrelated failures', () => {
    const msg = formatConfigLoadFailure('/w/stackctl.config.ts', new Error('boom'), 'v22.17.1');
    expect(msg).not.toContain(MIN_NODE);
  });

  test('stringifies a non-Error throw', () => {
    expect(formatConfigLoadFailure('/w/stackctl.config.ts', 'just a string')).toContain(
      'just a string',
    );
  });
});

describe('findConfigPath', () => {
  test('returns null when nothing matches', () => {
    expect(findConfigPath(dir)).toBeNull();
  });

  test('discovers stackctl.config.ts', () => {
    const p = path.join(dir, 'stackctl.config.ts');
    fs.writeFileSync(p, 'export default {};\n');
    expect(findConfigPath(dir)).toBe(p);
  });
});
