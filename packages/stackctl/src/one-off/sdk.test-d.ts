/**
 * Type-level tests for the overloads of `exec()` and `run()`: the form, not the count, picks the
 * result. Run with `pnpm test:types`. Nothing here is called: each call sits in a function that
 * is never run, so only its type is asserted.
 */
import { describe, expectTypeOf, test } from 'vitest';
import { type OneOffManyResult, type OneOffResult, exec, run } from './sdk';

describe('exec() and run() overloads', () => {
  test('one service string, or none, is the single form', () => {
    const single = () => exec({ service: 'api', command: ['x'] });
    expectTypeOf(single).returns.resolves.toEqualTypeOf<OneOffResult>();
    const none = () => run({ script: 'test' });
    expectTypeOf(none).returns.resolves.toEqualTypeOf<OneOffResult>();
  });

  test('a service array is the many form, even with one name', () => {
    const many = () => exec({ service: ['api'], command: ['x'] });
    expectTypeOf(many).returns.resolves.toEqualTypeOf<OneOffManyResult>();
    const viaRun = () => run({ service: ['api'], script: 'test', ignoreSiblingError: true });
    expectTypeOf(viaRun).returns.resolves.toEqualTypeOf<OneOffManyResult>();
  });

  test('tags are the many form, with or without a service string', () => {
    const tagged = () => exec({ tags: ['x'], command: ['x'] });
    expectTypeOf(tagged).returns.resolves.toEqualTypeOf<OneOffManyResult>();
    const joined = () => run({ service: 'api', tags: ['x'], script: 'test' });
    expectTypeOf(joined).returns.resolves.toEqualTypeOf<OneOffManyResult>();
  });

  test('ignoreSiblingError belongs to the many form', () => {
    const lone = () =>
      // @ts-expect-error `ignoreSiblingError` needs a service array or `tags`
      exec({ service: 'api', ignoreSiblingError: true, command: ['x'] });
    const unnamed = () =>
      // @ts-expect-error `ignoreSiblingError` needs a service array or `tags`
      run({ ignoreSiblingError: false, script: 'test' });
    void lone;
    void unnamed;
  });

  test("a result's fields", () => {
    expectTypeOf<OneOffManyResult['ok']>().toEqualTypeOf<boolean>();
    type Item = OneOffManyResult['results'][number];
    expectTypeOf<Item['service']>().toEqualTypeOf<string>();
    expectTypeOf<Item['status']>().toEqualTypeOf<'ok' | 'failed' | 'stopped' | 'skipped'>();
    expectTypeOf<Item['exitCode']>().toEqualTypeOf<number | null>();
    expectTypeOf<Item['signal']>().toEqualTypeOf<NodeJS.Signals | null>();
    expectTypeOf<Item['error']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Item['stdout']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Item['stderr']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Item>().not.toHaveProperty('ms');
  });
});
