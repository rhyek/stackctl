import { describe, test, expect } from 'vitest';
import { defineConfig, findService } from './index.js';
import type { AnyServiceConfig, ServiceName } from './index.js';

describe('public exports', () => {
  test('re-exports the runtime API', () => {
    expect(typeof defineConfig).toBe('function');
    expect(typeof findService).toBe('function');
  });

  test('ServiceName falls back to string when Register is unaugmented', () => {
    // Compile-time assertion: a plain string is assignable to ServiceName.
    const n: ServiceName = 'anything';
    const pkg: AnyServiceConfig | undefined = Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { [n]: {} } }).services,
    )[0];
    expect(pkg?.name).toBe('anything');
  });

  test('narrows ServiceConfig by name, tokens included', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      services: { api: { tokens: { region: 'us-east' } }, web: {} },
    });
    // Compile-time: each package's tokens are its own, keyed by name.
    const region: string = config.services.api.tokens.region;
    const domain: 'example.com' = config.services.web.tokens.domain;
    // @ts-expect-error `region` is api's token, not web's
    void config.services.web.tokens.region;
    expect([region, domain]).toEqual(['us-east', 'example.com']);
  });
});
