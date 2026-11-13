import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { findProgram } from './in-place.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-in-place-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Makes `dir/name`, executable or not. */
function file(dir: string, name: string, executable = true): string {
  fs.mkdirSync(dir, { recursive: true });
  const at = path.join(dir, name);
  fs.writeFileSync(at, '#!/bin/sh\n', { mode: executable ? 0o755 : 0o644 });
  return at;
}

describe('findProgram', () => {
  test('the first executable file of that name on PATH', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    file(a, 'tool', false);
    const found = file(b, 'tool');
    file(path.join(tmp, 'c'), 'tool');
    expect(findProgram('tool', tmp, [a, b, path.join(tmp, 'c')].join(path.delimiter))).toBe(found);
  });

  test('skips a directory of that name', () => {
    fs.mkdirSync(path.join(tmp, 'a', 'tool'), { recursive: true });
    const found = file(path.join(tmp, 'b'), 'tool');
    const pathVar = [path.join(tmp, 'a'), path.join(tmp, 'b')].join(path.delimiter);
    expect(findProgram('tool', tmp, pathVar)).toBe(found);
  });

  test('a path with a slash is resolved against the directory, not looked up', () => {
    const found = file(path.join(tmp, 'bin'), 'tool');
    expect(findProgram('./bin/tool', tmp, '/nonexistent')).toBe(found);
    expect(findProgram('./bin/missing', tmp, path.join(tmp, 'bin'))).toBeNull();
  });

  test('an empty PATH entry is the directory itself', () => {
    const found = file(tmp, 'tool');
    expect(findProgram('tool', tmp, `${path.delimiter}/nonexistent`)).toBe(found);
  });

  test('null when nothing is found', () => {
    expect(findProgram('stackctl-no-such-command', tmp, process.env.PATH)).toBeNull();
    expect(findProgram('tool', tmp, undefined)).toBeNull();
  });
});

describe('execInPlace', () => {
  test('becomes the command: the same pid, in its directory, with exactly its environment', () => {
    const work = path.join(tmp, 'work');
    fs.mkdirSync(work);
    const module = pathToFileURL(path.join(import.meta.dirname, 'in-place.ts')).href;
    const spec = {
      command: 'sh',
      args: ['-c', 'echo "$$|$PWD|$ONLY_HERE|${NOT_GIVEN-unset}"'],
      cwd: work,
      env: { PATH: process.env.PATH, ONLY_HERE: 'yes' },
    };
    // The node process prints its own pid, then becomes `sh`, which prints its.
    const js = `console.log(process.pid); const { execInPlace } = await import(${JSON.stringify(module)}); await execInPlace(${JSON.stringify(spec)}); console.log('still here');`; // oxfmt-ignore
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', js], {
      env: { ...process.env, NOT_GIVEN: 'leaked' },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const [pid, line] = result.stdout.trim().split('\n');
    expect(line).toBe(`${pid!}|${work}|yes|unset`);
  });

  test('the command gets SIGPIPE at its default, as a spawned child does: no "Broken pipe"', () => {
    const module = pathToFileURL(path.join(import.meta.dirname, 'in-place.ts')).href;
    const spec = { command: 'sh', args: ['-c', 'yes | head -1'], cwd: tmp, env: { PATH: process.env.PATH } }; // oxfmt-ignore
    const js = `const { execInPlace } = await import(${JSON.stringify(module)}); await execInPlace(${JSON.stringify(spec)});`; // oxfmt-ignore
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', js], {
      encoding: 'utf8',
    });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: 'y\n',
      stderr: '',
    });
  });

  test('returns when the program is not found, so the caller runs it as a child', () => {
    const module = pathToFileURL(path.join(import.meta.dirname, 'in-place.ts')).href;
    const spec = { command: 'stackctl-no-such-command', args: [], cwd: tmp, env: { PATH: '/nonexistent' } }; // oxfmt-ignore
    const js = `const { execInPlace } = await import(${JSON.stringify(module)}); await execInPlace(${JSON.stringify(spec)}); console.log('returned', process.cwd());`; // oxfmt-ignore
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', js], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
    });
    expect(result.stdout.trim()).toBe(`returned ${fs.realpathSync(os.tmpdir())}`);
  });
});
