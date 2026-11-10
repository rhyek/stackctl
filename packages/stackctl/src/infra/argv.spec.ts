import { describe, expect, test } from 'vitest';
import { findPassthrough, passthroughArgs } from './argv.js';

const argv = (...rest: string[]) => ['node', 'cli', ...rest];

describe('findPassthrough', () => {
  test('finds the provider word that follows `infra`', () => {
    expect(findPassthrough(argv('infra', 'docker-compose', 'ps'))).toBe(3);
  });

  test("skips infra's own mode flag, in every spelling", () => {
    expect(findPassthrough(argv('infra', '-m', 'test', 'docker-compose', 'ps'))).toBe(5);
    expect(findPassthrough(argv('infra', '--mode', 'test', 'docker-compose', 'ps'))).toBe(5);
    expect(findPassthrough(argv('infra', '--mode=test', 'docker-compose', 'ps'))).toBe(4);
    expect(findPassthrough(argv('infra', '--workspace-dir', 'x', 'docker-compose', 'ps'))).toBe(5);
    expect(findPassthrough(argv('infra', '--workspace-dir=x', 'docker-compose', 'ps'))).toBe(4);
  });

  test('allows root options before `infra`', () => {
    expect(findPassthrough(argv('-m', 'test', 'infra', 'docker-compose', 'ps'))).toBe(5);
  });

  test('is -1 for the other infra subcommands and for no infra at all', () => {
    expect(findPassthrough(argv('infra', 'up'))).toBe(-1);
    expect(findPassthrough(argv('infra', 'up', 'docker-compose'))).toBe(-1);
    expect(findPassthrough(argv('infra'))).toBe(-1);
    expect(findPassthrough(argv('--plain', '-p', 'web'))).toBe(-1);
  });

  test('is -1 when the words sit after a bare `--`, where they belong to a wrapped command', () => {
    expect(findPassthrough(argv('exec', '--', 'infra', 'docker-compose', 'ps'))).toBe(-1);
  });
});

describe('passthroughArgs', () => {
  test('returns everything after the provider word, verbatim', () => {
    expect(
      passthroughArgs(
        argv('-m', 'test', 'infra', 'docker-compose', 'build', '-m', '2g', '--', 'x'),
      ),
    ).toEqual({ provider: 'docker-compose', args: ['build', '-m', '2g', '--', 'x'] });
  });

  test('is null when there is no passthrough', () => {
    expect(passthroughArgs(argv('infra', 'up'))).toBeNull();
  });
});
