import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AnyServiceConfig } from './config.js';
import { TargetNotFoundError, resolveTarget } from './target.js';

let tmp: string;
let root: string;
let services: AnyServiceConfig[];

function svc(name: string, rel: string): AnyServiceConfig {
  return {
    name,
    relativeDir: rel,
    absoluteDir: path.join(root, rel),
  } as AnyServiceConfig;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-target-')));
  root = path.join(tmp, 'ws');
  for (const d of [
    'apps/api/src',
    'apps/api/docs/x',
    'apps/api-v2/x',
    'scripts',
    'api',
    '../outside',
  ]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'scripts', 'run.sh'), '');
  services = [svc('api', 'apps/api'), svc('api-docs', 'apps/api/docs')];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ctx = (base = root) => ({ root, services, base });

describe('resolveTarget', () => {
  test('a service name', () => {
    const t = resolveTarget('api', ctx());
    expect(t).toMatchObject({ kind: 'service', dir: path.join(root, 'apps/api') });
    expect(t.kind === 'service' && t.service.name).toBe('api');
  });

  test('a service name from inside another directory', () => {
    expect(resolveTarget('api', ctx(path.join(root, 'scripts'))).kind).toBe('service');
  });

  test.each([
    ['apps/api', 'api', 'apps/api'],
    ['apps/api/src', 'api', 'apps/api'],
    ['apps/api/docs/x', 'api-docs', 'apps/api/docs'],
    ['apps/api/docs', 'api-docs', 'apps/api/docs'],
  ])('the path %s is the service %s, in its own directory', (spec, name, dir) => {
    const t = resolveTarget(spec, ctx());
    expect(t.kind).toBe('service');
    expect(t.kind === 'service' && t.service.name).toBe(name);
    expect(t.dir).toBe(path.join(root, dir));
  });

  test('an absolute path', () => {
    const t = resolveTarget(path.join(root, 'apps/api'), ctx());
    expect(t.kind === 'service' && t.service.name).toBe('api');
  });

  test('a path is resolved against base', () => {
    const t = resolveTarget('src', ctx(path.join(root, 'apps/api')));
    expect(t.kind === 'service' && t.service.name).toBe('api');
    expect(t.dir).toBe(path.join(root, 'apps/api'));
  });

  test('a prefix that is no path boundary does not claim the directory', () => {
    const t = resolveTarget('apps/api-v2/x', ctx());
    expect(t).toEqual({
      kind: 'directory',
      dir: path.join(root, 'apps/api-v2/x'),
      relativeDir: path.join('apps', 'api-v2', 'x'),
    });
  });

  test('./name is the directory, not the service of that name', () => {
    expect(resolveTarget('./api', ctx())).toEqual({
      kind: 'directory',
      dir: path.join(root, 'api'),
      relativeDir: 'api',
    });
  });

  test('a plain directory', () => {
    expect(resolveTarget('scripts', ctx())).toEqual({
      kind: 'directory',
      dir: path.join(root, 'scripts'),
      relativeDir: 'scripts',
    });
  });

  test('. from the root is the root', () => {
    expect(resolveTarget('.', ctx())).toEqual({ kind: 'root', dir: root });
  });

  test('no target is . from where it was run', () => {
    const base = path.join(root, 'scripts');
    expect(resolveTarget(undefined, ctx(base))).toEqual(resolveTarget('.', ctx(base)));
    expect(resolveTarget(undefined, ctx(base)).kind).toBe('directory');
    expect(resolveTarget(undefined, ctx()).kind).toBe('root');
  });

  test('a missing target', () => {
    expect(() => resolveTarget('missing', ctx())).toThrow(
      new TargetNotFoundError('"missing" is neither a service nor a directory in this workspace'),
    );
    expect(() => resolveTarget('missing', ctx())).toThrow(TargetNotFoundError);
  });

  test('a directory outside the root', () => {
    expect(() => resolveTarget('../outside', ctx())).toThrow(
      '"../outside" is neither a service nor a directory in this workspace',
    );
  });

  test('a file is no target', () => {
    expect(() => resolveTarget('scripts/run.sh', ctx())).toThrow(
      '"scripts/run.sh" is neither a service nor a directory in this workspace',
    );
  });

  test('resolves a target reached through a symlink', () => {
    const link = path.join(tmp, 'link');
    fs.symlinkSync(path.join(root, 'apps/api'), link);
    expect(fs.realpathSync(link)).not.toBe(link);
    const t = resolveTarget(link, ctx());
    expect(t.kind === 'service' && t.service.name).toBe('api');
    expect(t.dir).toBe(path.join(root, 'apps/api'));
  });

  test('resolves a service whose directory is reached through a symlink', () => {
    const link = path.join(tmp, 'svc-link');
    fs.symlinkSync(path.join(root, 'apps/api'), link);
    services = [{ name: 'api', relativeDir: 'apps/api', absoluteDir: link } as AnyServiceConfig];
    const t = resolveTarget('apps/api/src', ctx());
    expect(t.kind === 'service' && t.service.name).toBe('api');
    expect(t.dir).toBe(path.join(root, 'apps/api'));
  });

  test('a symlink inside the workspace pointing outside it is outside', () => {
    fs.symlinkSync(path.join(tmp, 'outside'), path.join(root, 'escape'));
    expect(() => resolveTarget('escape', ctx())).toThrow(TargetNotFoundError);
  });
});

describe('resolveTarget on a case-insensitive file system', () => {
  test('a path typed in another case is still the service', (ctx2) => {
    // Only where the file system folds case (macOS's default): elsewhere `APPS/API` is no path.
    if (!fs.existsSync(path.join(root, 'APPS', 'API'))) {
      ctx2.skip();
    }
    const t = resolveTarget('APPS/API/src', ctx());
    expect(t.kind).toBe('service');
    expect(t.kind === 'service' && t.service.name).toBe('api');
    expect(t.dir).toBe(path.join(root, 'apps/api'));
  });

  test('a root typed in another case still holds its services', (ctx2) => {
    const upper = path.join(tmp, 'WS');
    if (!fs.existsSync(upper)) {
      ctx2.skip();
    }
    const t = resolveTarget('apps/api', { root: upper, services, base: upper });
    expect(t.kind).toBe('service');
    expect(t.dir).toBe(path.join(root, 'apps/api'));
  });
});
