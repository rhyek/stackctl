import { describe, expect, test } from 'vitest';
import { relaunchArgv } from './relaunch.js';

describe('relaunchArgv', () => {
  test('adds the cap ahead of the flags and arguments stackctl was started with', () => {
    expect(
      relaunchArgv(
        '/bin/node',
        ['--import', 'hook.js'],
        ['/bin/node', '/pkg/dist/cli.js', '-s', 'api'],
        undefined,
      ),
    ).toEqual([
      '/bin/node',
      '--max-semi-space-size=2',
      '--import',
      'hook.js',
      '/pkg/dist/cli.js',
      '-s',
      'api',
    ]);
  });

  test('leaves a process that already has a cap as it is', () => {
    expect(
      relaunchArgv('/bin/node', ['--max-semi-space-size=2'], ['/bin/node', 'cli.js'], undefined),
    ).toBeNull();
    expect(
      relaunchArgv('/bin/node', [], ['/bin/node', 'cli.js'], '--max-semi-space-size=16'),
    ).toBeNull();
  });
});
