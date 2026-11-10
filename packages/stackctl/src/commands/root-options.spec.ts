import { describe, expect, test } from 'vitest';
import type { StartOptions } from './default.js';
import { rootOptionsRefusal } from './root-options.js';

const base: StartOptions = {
  service: [],
  lastAnswers: false,
  killOthers: false,
};

describe('rootOptionsRefusal', () => {
  test('refuses --ui with --headless', () => {
    expect(rootOptionsRefusal({ ...base, ui: true, headless: true })).toBe(
      "--ui and --headless can't be combined.",
    );
  });

  test('accepts either one alone', () => {
    expect(rootOptionsRefusal({ ...base, headless: true })).toBeUndefined();
    expect(rootOptionsRefusal({ ...base, ui: true })).toBeUndefined();
  });

  test('--detach takes -s or --last-answers, and no --ui', () => {
    expect(rootOptionsRefusal({ ...base, detach: true, service: ['web'] })).toBeUndefined();
    expect(rootOptionsRefusal({ ...base, detach: true, lastAnswers: true })).toBeUndefined();
    expect(rootOptionsRefusal({ ...base, detach: true })).toBe(
      '--detach needs services to start: pass --service or --last-answers.',
    );
    expect(rootOptionsRefusal({ ...base, detach: true, service: ['web'], ui: true })).toBe(
      "--ui and --detach can't be combined.",
    );
  });

  test('--wait-timeout is for --detach, and is above 0', () => {
    const detach = { ...base, detach: true, service: ['web'] };
    expect(rootOptionsRefusal({ ...detach, waitTimeout: 5 })).toBeUndefined();
    expect(rootOptionsRefusal({ ...detach, waitTimeout: 0 })).toBe(
      '--wait-timeout takes a number of seconds above 0.',
    );
    expect(rootOptionsRefusal({ ...detach, waitTimeout: Number.NaN })).toBe(
      '--wait-timeout takes a number of seconds above 0.',
    );
    expect(rootOptionsRefusal({ ...base, waitTimeout: 5 })).toBe('--wait-timeout is for --detach.');
  });
});
