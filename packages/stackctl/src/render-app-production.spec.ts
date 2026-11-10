import { afterEach, describe, test, expect, vi } from 'vitest';

// Replace the heavy Ink/React `App` module with a stub whose `renderApp` records the
// ambient NODE_ENV at the moment it's invoked — i.e. the value React would read to pick
// its development-vs-production build when `App` (and thus `react`) is evaluated. Hoisted
// so the `vi.mock` factory can reference it.
const mock = vi.hoisted(() => {
  const state: { nodeEnvAtLoad: string | undefined; calls: number } = {
    nodeEnvAtLoad: undefined,
    calls: 0,
  };
  return {
    state,
    renderApp: vi.fn(() => {
      state.nodeEnvAtLoad = process.env.NODE_ENV;
      state.calls += 1;
    }),
  };
});

vi.mock('./tui/App.js', () => ({ renderApp: mock.renderApp }));

const { renderAppInProduction } = await import('./render-app-production.js');

const OPTIONS = { logFile: 'session.log', configPath: 'stackctl.config.ts' };

/**
 * The Ink TUI must run React in its PRODUCTION build (its dev build leaks User-Timing
 * entries every render — see render-app-production.ts), yet the dev processes stackctl
 * spawns afterwards must inherit whatever NODE_ENV the shell had. These assert both halves:
 * NODE_ENV is `production` exactly while the app (React) loads, and is restored to the
 * original value the instant that's done — so a child spawned later sees the shell's value.
 */
describe('renderAppInProduction', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = original;
    }
    mock.state.nodeEnvAtLoad = undefined;
    mock.state.calls = 0;
    mock.renderApp.mockClear();
  });

  for (const value of ['development', 'test', 'production', undefined] as const) {
    const label = value ?? '(unset)';
    test(`loads the app under NODE_ENV=production, then restores NODE_ENV=${label}`, async () => {
      if (value === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = value;
      }

      await renderAppInProduction(OPTIONS);

      // React is evaluated during the App import, so it must see production there...
      expect(mock.state.calls).toBe(1);
      expect(mock.state.nodeEnvAtLoad).toBe('production');
      // ...and the ambient value is put back afterwards, so spawned children inherit the shell's.
      expect(process.env.NODE_ENV).toBe(value);
    });
  }

  test('restores NODE_ENV even when loading/rendering throws', async () => {
    process.env.NODE_ENV = 'test';
    mock.renderApp.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await expect(renderAppInProduction(OPTIONS)).rejects.toThrow('boom');
    expect(process.env.NODE_ENV).toBe('test');
  });

  test('deletes NODE_ENV (does not leave it as the string "undefined") when it started unset', async () => {
    delete process.env.NODE_ENV;

    await renderAppInProduction(OPTIONS);

    expect('NODE_ENV' in process.env).toBe(false);
  });
});
