/**
 * Type-level tests for the SDK functions that run a CLI command. Run with `pnpm test:types`.
 * Nothing here is called: each call sits in a function that is never run.
 */
import { describe, expectTypeOf, test } from 'vitest';
import type { EventLine } from '../event-log';
import type { Stack } from '../stack';
import { attach, wait } from './attach';
import { type InfraResult, infra } from './infra';
import { events, logs, resetProfile } from './session';

describe('infra', () => {
  test('every lifecycle command resolves with a result per service', () => {
    const start = () => infra.start({ services: ['db'], waitTimeout: 30 });
    expectTypeOf(start).returns.resolves.toEqualTypeOf<InfraResult>();
    const destroy = () => infra.destroy({ tags: ['data'] });
    expectTypeOf(destroy).returns.resolves.toEqualTypeOf<InfraResult>();
  });

  test('waitTimeout is only on the commands that wait for ready', () => {
    expectTypeOf(infra.stop).parameter(0).exclude<undefined>().not.toHaveProperty('waitTimeout');
    expectTypeOf(infra.destroy).parameter(0).exclude<undefined>().not.toHaveProperty('waitTimeout');
    expectTypeOf(infra.reset).parameter(0).exclude<undefined>().toHaveProperty('waitTimeout');
  });
});

describe('session commands', () => {
  test('events and logs resolve, or follow as async iterables', () => {
    expectTypeOf(() => events({ lines: 5 })).returns.resolves.toEqualTypeOf<EventLine[]>();
    expectTypeOf(() => events({ follow: true })).returns.toEqualTypeOf<AsyncIterable<EventLine>>();
    expectTypeOf(() => logs()).returns.resolves.toEqualTypeOf<{ path: string; text: string }>();
    expectTypeOf(() => logs({ follow: true })).returns.toEqualTypeOf<AsyncIterable<string>>();
  });

  test('resetProfile needs a profile', () => {
    expectTypeOf(resetProfile).parameter(0).toHaveProperty('profile').toEqualTypeOf<string>();
  });
});

describe('attach and wait', () => {
  test('resolve with a Stack, attached or started', () => {
    expectTypeOf(() => attach()).returns.resolves.toEqualTypeOf<Stack>();
    expectTypeOf(() => wait({ timeout: 5 })).returns.resolves.toEqualTypeOf<Stack>();
    expectTypeOf<Stack['session']>().toEqualTypeOf<'started' | 'attached'>();
  });
});
