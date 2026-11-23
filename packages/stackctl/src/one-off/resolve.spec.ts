import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { defineConfig } from '../config';
import { PACKAGE_PALETTE } from '../log-colors';
import { UnknownTagError } from '../tags';
import { TargetNotFoundError } from '../target';
import { type OneOffAsk, ScriptNotFoundError, resolveOneOffMany } from './resolve';

let tmp: string;
let root: string;

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-many-')));
  root = path.join(tmp, 'ws');
  for (const [name, port] of [
    ['api', '3001'],
    ['web', '3002'],
    ['worker', '3003'],
  ] as const) {
    write(`apps/${name}/.env`, `PORT=${port}\n`);
    // `worker` has no `build` script.
    const scripts = name === 'worker' ? { dev: 'true' } : { dev: 'true', build: 'true' };
    write(`apps/${name}/package.json`, JSON.stringify({ name, scripts }));
  }
  write('tools/package.json', JSON.stringify({ name: 'tools', scripts: { build: 'true' } }));
  defineConfig({
    workspaceDir: root,
    services: {
      api: { dir: 'apps/api', tags: ['backend'], color: '#123456' },
      web: { dir: 'apps/web', tags: ['frontend'] },
      worker: { dir: 'apps/worker', tags: ['backend'] },
    },
  });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const exec: OneOffAsk = { kind: 'exec', command: ['echo', 'hi'] };
const build: OneOffAsk = { kind: 'run', script: 'build', args: [] };

function many(targets: string[], tags: string[], request: OneOffAsk = exec, base = root) {
  return resolveOneOffMany({ targets, tags, base, root, ...request });
}

describe('resolveOneOffMany', () => {
  test('names and tags are one list: services in config order, then directories', () => {
    const list = many(['./tools', 'web'], ['backend']);
    expect(list.map((m) => m.label)).toEqual(['api', 'web', 'worker', 'tools']);
  });

  test('one target spelled twice runs once', () => {
    const list = many(['api', './apps/api'], ['backend']);
    expect(list.map((m) => m.label)).toEqual(['api', 'worker']);
  });

  test('a directory that is no service is labelled by its path from the root', () => {
    const [tools] = many(['./tools'], []);
    expect(tools).toMatchObject({ label: 'tools', where: { dir: 'tools' } });
    expect(tools!.color).toBeUndefined();
    expect(tools!.spec?.cwd).toBe(path.join(root, 'tools'));
  });

  test('a service is labelled by its name, in its color or the palette position', () => {
    const list = many([], ['backend', 'frontend']);
    expect(list.map((m) => m.where)).toEqual([
      { service: 'api' },
      { service: 'web' },
      { service: 'worker' },
    ]);
    expect(list.map((m) => m.color)).toEqual(['#123456', PACKAGE_PALETTE[1], PACKAGE_PALETTE[2]]);
  });

  test('run: a tag-matched service without the script is skipped; named, it throws', () => {
    const skipped = many([], ['backend'], build);
    expect(skipped.map((m) => [m.label, m.spec === null])).toEqual([
      ['api', false],
      ['worker', true],
    ]);
    expect(() => many(['worker'], ['backend'], build)).toThrow(
      new ScriptNotFoundError(
        `No "build" script or make target found in ${path.join(root, 'apps/worker')}`,
      ),
    );
  });

  test('run: a script no target has throws, naming them', () => {
    expect(() => many([], ['backend'], { kind: 'run', script: 'nope', args: [] })).toThrow(
      new ScriptNotFoundError('No "nope" script or make target found in any of: api, worker'),
    );
  });

  test('exec: every target gets the command, in its own directory, with its own environment', () => {
    const [api, web] = many(['api', 'web'], []);
    expect(api!.spec).toMatchObject({
      cwd: path.join(root, 'apps/api'),
      command: 'echo',
      args: ['hi'],
    });
    expect(web!.spec?.cwd).toBe(path.join(root, 'apps/web'));
    expect(api!.spec?.env.PORT).toBe('3001');
    expect(web!.spec?.env.PORT).toBe('3002');
  });

  test('an unknown tag and an unknown target each throw their own error', () => {
    expect(() => many([], ['nope'])).toThrow(UnknownTagError);
    expect(() => many(['./missing'], [])).toThrow(TargetNotFoundError);
  });

  test('an empty value is refused, not taken for the base directory', () => {
    expect(() => many([''], [], exec, path.join(root, 'tools'))).toThrow(
      new TargetNotFoundError('"" is neither a service nor a directory in this workspace'),
    );
  });

  test('a tagged service whose directory is missing resolves like a named one', () => {
    defineConfig({
      workspaceDir: root,
      services: {
        api: { dir: 'apps/api', tags: ['backend'] },
        ghost: { dir: 'apps/ghost', tags: ['backend'] },
      },
    });
    const tagged = many([], ['backend']).find((m) => m.label === 'ghost');
    const [named] = many(['ghost'], []);
    // The same command in the same place; only the palette position differs.
    expect({ ...tagged, color: undefined }).toEqual({ ...named, color: undefined });
    expect(tagged?.spec?.cwd).toBe(path.join(root, 'apps/ghost'));
  });

  test('the root as a directory is labelled .', () => {
    const [atRoot] = many(['.'], []);
    expect(atRoot).toMatchObject({ label: '.', where: { dir: '.' } });
    expect(atRoot!.spec?.cwd).toBe(root);
  });

  test('two spellings of one directory run once', () => {
    const list = many(['./tools', 'tools/../tools'], []);
    expect(list.map((m) => m.label)).toEqual(['tools']);
  });

  test('run: a tag-only service without the script is skipped beside a named one that has it', () => {
    const list = many(['api'], ['backend'], build);
    expect(list.map((m) => [m.label, m.spec === null])).toEqual([
      ['api', false],
      ['worker', true],
    ]);
  });
});
