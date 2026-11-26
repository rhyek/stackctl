import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { composeProjectName } from './project-name';

describe('composeProjectName', () => {
  test('defaults to the workspace directory name and the profile', () => {
    expect(
      composeProjectName({ envs: {}, workspaceDir: '/repos/example', profile: 'development' }),
    ).toBe('example-development');
    expect(composeProjectName({ envs: {}, workspaceDir: '/repos/example', profile: 'test' })).toBe(
      'example-test',
    );
  });

  test("normalizes to Compose's naming rule: lowercase, [a-z0-9_-] only", () => {
    expect(
      composeProjectName({ envs: {}, workspaceDir: '/repos/My App.v2', profile: 'development' }),
    ).toBe('my-app-v2-development');
  });

  test('strips leading characters that are not a letter or digit', () => {
    expect(composeProjectName({ envs: {}, workspaceDir: '/repos/_scratch', profile: 'test' })).toBe(
      'scratch-test',
    );
    expect(composeProjectName({ envs: {}, workspaceDir: '/repos/.hidden', profile: 'test' })).toBe(
      'hidden-test',
    );
  });

  test('normalizes a dotted profile name', () => {
    expect(
      composeProjectName({ envs: {}, workspaceDir: '/repos/example', profile: 'e2e.ci' }),
    ).toBe('example-e2e-ci');
  });

  test('COMPOSE_PROJECT_NAME from the resolved environment wins, untouched', () => {
    expect(
      composeProjectName({
        envs: { COMPOSE_PROJECT_NAME: 'custom_name' },
        workspaceDir: '/repos/example',
        profile: 'development',
      }),
    ).toBe('custom_name');
  });

  test('an empty COMPOSE_PROJECT_NAME is ignored', () => {
    expect(
      composeProjectName({
        envs: { COMPOSE_PROJECT_NAME: '' },
        workspaceDir: '/repos/example',
        profile: 'development',
      }),
    ).toBe('example-development');
  });
});

describe("composeProjectName: the compose file's `name:`", () => {
  let root: string;
  let ws: string;
  const services = 'services:\n  db:\n    image: postgres:18.6\n';
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const name = (opts: { envs?: Record<string, string>; file?: string } = {}) =>
    composeProjectName({
      envs: opts.envs ?? {},
      workspaceDir: ws,
      profile: 'development',
      file: opts.file && path.join(ws, opts.file),
    });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'stackctl-project-name-'));
    ws = path.join(root, 'example');
    mkdirSync(ws);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('is used as it is, with no profile suffix', () => {
    write('example/compose.yaml', `name: shop\n${services}`);
    expect(name()).toBe('shop');
  });

  test('COMPOSE_PROJECT_NAME still wins over it', () => {
    write('example/compose.yaml', `name: shop\n${services}`);
    expect(name({ envs: { COMPOSE_PROJECT_NAME: 'custom' } })).toBe('custom');
  });

  test('a file with no name, or an empty one, leaves the derived name', () => {
    write('example/compose.yaml', services);
    expect(name()).toBe('example-development');
    write('example/compose.yaml', `name: ''\n${services}`);
    expect(name()).toBe('example-development');
  });

  test("is normalized as Compose normalizes a file's name", () => {
    write('example/compose.yaml', `name: '_My Shop.v2'\n${services}`);
    expect(name()).toBe('myshopv2');
  });

  test("the override file's name wins over the main file's", () => {
    write('example/docker-compose.yml', `name: shop\n${services}`);
    write('example/docker-compose.override.yml', 'name: shop-local\n');
    expect(name()).toBe('shop-local');
  });

  test("Compose's preferred file name is the one read", () => {
    write('example/compose.yaml', `name: preferred\n${services}`);
    write('example/docker-compose.yaml', `name: other\n${services}`);
    expect(name()).toBe('preferred');
  });

  test('is found in a directory above the workspace, as Compose finds the file', () => {
    write('compose.yaml', `name: parent\n${services}`);
    expect(name()).toBe('parent');
  });

  test('with `file`, only that file is read, without an override file', () => {
    write('example/compose.yaml', `name: discovered\n${services}`);
    write('example/compose.override.yaml', 'name: override\n');
    write('example/infra/stack.yaml', `name: configured\n${services}`);
    expect(name({ file: 'infra/stack.yaml' })).toBe('configured');
    write('example/infra/stack.yaml', services);
    expect(name({ file: 'infra/stack.yaml' })).toBe('example-development');
  });

  test('with COMPOSE_FILE, those files are read, the last name winning', () => {
    write('example/compose.yaml', `name: discovered\n${services}`);
    write('example/a.yaml', `name: first\n${services}`);
    write('example/b.yaml', 'name: second\n');
    expect(name({ envs: { COMPOSE_FILE: `a.yaml${path.delimiter}b.yaml` } })).toBe('second');
    expect(name({ envs: { COMPOSE_FILE: 'b.yaml;a.yaml', COMPOSE_PATH_SEPARATOR: ';' } })).toBe(
      'first',
    );
  });

  test('an empty COMPOSE_FILE is read as Compose reads it: the directory, which names nothing', () => {
    write('example/compose.yaml', `name: discovered\n${services}`);
    expect(name({ envs: { COMPOSE_FILE: '' } })).toBe('example-development');
  });

  test('is interpolated from the environment', () => {
    write('example/compose.yaml', `name: \${SHOP:-shop}-$STAGE\n${services}`);
    expect(name({ envs: { STAGE: 'dev' } })).toBe('shop-dev');
    expect(name({ envs: { SHOP: 'store', STAGE: 'dev' } })).toBe('store-dev');
  });

  test("follows Compose's interpolation forms", () => {
    const cases: [string, Record<string, string>, string][] = [
      ['${A}', { A: 'x' }, 'x'],
      ['${A:-d}', { A: '' }, 'd'],
      ['${A-d}', { A: '' }, 'example-development'],
      ['${A-d}', {}, 'd'],
      ['${A:+r}', { A: 'x' }, 'r'],
      ['${A:+r}', { A: '' }, 'example-development'],
      ['${A+r}', { A: '' }, 'r'],
      ['${A:-${B:-nested}}', {}, 'nested'],
      ['a$$b', {}, 'ab'],
      ['a$-b', {}, 'a-b'],
      ['${UNSET}', {}, 'example-development'],
      ['${A:?required}', { A: 'x' }, 'x'],
      ['${A?required}', { A: '' }, 'example-development'],
    ];
    for (const [template, envs, expected] of cases) {
      write('example/compose.yaml', `name: '${template}'\n${services}`);
      expect(name({ envs }), template).toBe(expected);
    }
  });

  test("a name Compose can't interpolate names nothing; Compose reports it", () => {
    for (const template of ['${SHOP:?set SHOP}', '${SHOP?set SHOP}', '${SHOP', 'a-${1X}']) {
      write('example/compose.yaml', `name: '${template}'\n${services}`);
      expect(name(), template).toBe('example-development');
    }
  });

  test('is read through an alias or a merge key, as Compose reads it', () => {
    write('example/compose.yaml', `x-name: &n shop\nname: *n\n${services}`);
    expect(name()).toBe('shop');
    write('example/compose.yaml', `x-base: &base\n  name: merged\n<<: *base\n${services}`);
    expect(name()).toBe('merged');
  });

  test("a file that can't be parsed names nothing; Compose reports it", () => {
    write('example/compose.yaml', 'name: [shop\n');
    expect(name()).toBe('example-development');
  });
});
