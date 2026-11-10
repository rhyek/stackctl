import { debugLog } from './internal-logger.js';
import type { RenderAppOptions } from './tui/App.js';

/**
 * Mount the Ink TUI (`renderApp`) with React in its **production** build, without
 * forcing `NODE_ENV=production` on the dev processes stackctl spawns.
 *
 * Ink is built on React, and React (plus `react-reconciler`/`scheduler`) picks its
 * development-vs-production build exactly once — from `process.env.NODE_ENV`, the
 * instant its module is first evaluated. There is no runtime or constructor switch,
 * and React's maintainers explicitly declined to add one that bypasses `NODE_ENV`
 * (facebook/react#24984); the package `exports` even block importing the production
 * bundle directly. So `NODE_ENV` at import time is the only lever.
 *
 * This matters because React's *development* build (19.2+) emits a
 * `performance.measure()` per render for its DevTools "performance tracks". Node never
 * flushes the User-Timing timeline, so in a long-lived TUI — which re-renders on a
 * timer forever — those entries pile up without bound and eventually OOM the process
 * (facebook/react#34770). The production build emits none.
 *
 * We can't just set `NODE_ENV=production` process-wide: the child dev servers stackctl
 * launches must inherit whatever `NODE_ENV` the outer shell had. So pin `production`
 * for only the moment React's modules first evaluate — a dynamic `import()` while the
 * var is forced — then restore the previous value. React caches the production build
 * it loaded, so the restore can't flip it back, and everything spawned afterwards sees
 * the original environment.
 *
 * INVARIANT: nothing that transitively imports `ink`/`react` may be imported
 * *statically* on any path reachable from `cli.ts` before this runs. A static import
 * would evaluate React in development mode first — reinstating the leak — before we
 * ever get to pin `production`. (The type-only import above is erased at compile time
 * and never loads the module.) Today the entire Ink surface lives under
 * `src/components/*` and `src/tui/*` and is reachable only through `./tui/App.js`,
 * which this loads dynamically; keep it that way.
 */
export async function renderAppInProduction(options: RenderAppOptions): Promise<void> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const { renderApp } = await import('./tui/App.js');
    // Before the first frame. Should Ink's modules not be where the port expects them, Ink keeps
    // its own compositor: the frames are the same, only heavier to draw.
    const { installLeanInkOutput } = await import('./ink-output.js');
    const installed = await installLeanInkOutput().catch(() => false);
    debugLog(`renderAppInProduction: lean Ink compositor installed=${installed}`);
    renderApp(options);
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous;
    }
  }
}
