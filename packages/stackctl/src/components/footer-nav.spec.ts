import { describe, expect, test } from 'vitest';
import { verticalTarget, type ItemRect } from './footer-nav.js';

/** A row of items laid out like the footer: `● name`, two columns apart, from `startCol`. */
function row(row: number, names: string[], startCol = 1): ItemRect[] {
  let col = startCol;
  return names.map((name) => {
    const rect = { col, row };
    col += 2 + name.length + 2;
    return rect;
  });
}

describe('verticalTarget', () => {
  // Three packages, then one infra service behind the `infra:` label two rows below.
  const rects = [...row(1, ['api', 'auth', 'web']), ...row(3, ['db'], 9)];

  test('down from any package goes to the only infra service', () => {
    expect(verticalTarget(rects, 0, 'down')).toBe(3);
    expect(verticalTarget(rects, 2, 'down')).toBe(3);
  });

  test('up from the only infra service goes to the first package, whatever the label shifts', () => {
    expect(verticalTarget(rects, 3, 'up')).toBe(0);
  });

  test('wraps: up from the top row goes to the bottom one, down from the bottom to the top', () => {
    expect(verticalTarget(rects, 1, 'up')).toBe(3);
    expect(verticalTarget(rects, 3, 'down')).toBe(0);
  });

  test('with several services, goes to the one drawn nearest', () => {
    // `infra:` puts `cache` at column 9 and `db` at 18, under `auth` (8) and `web` (16).
    const two = [...row(1, ['api', 'auth', 'web']), ...row(3, ['cache', 'db'], 9)];
    expect(verticalTarget(two, 1, 'down')).toBe(3); // auth → cache
    expect(verticalTarget(two, 2, 'down')).toBe(4); // web → db
    expect(verticalTarget(two, 4, 'up')).toBe(2); // db → web
    expect(verticalTarget(two, 3, 'up')).toBe(0); // cache, first in its row → api
  });

  test('picks the nearest item between wrapped package rows too', () => {
    const wrapped = [
      ...row(1, ['console-desktop', 'api']),
      ...row(2, ['auth', 'landing', 'worker']),
      ...row(4, ['db', 'redis', 'mail'], 9),
    ];
    // `api` at column 20; on the next row `worker` (20) is nearest.
    expect(verticalTarget(wrapped, 1, 'down')).toBe(4);
    // `landing` (9) → `redis` (15), nearer than `db` — first in its row, so counted at 1.
    expect(verticalTarget(wrapped, 3, 'down')).toBe(6);
    // `mail` (24) → `worker` (20) on the row above.
    expect(verticalTarget(wrapped, 7, 'up')).toBe(4);
  });

  test('stays put with a single row', () => {
    const one = row(1, ['api', 'web']);
    expect(verticalTarget(one, 1, 'down')).toBe(1);
    expect(verticalTarget(one, 1, 'up')).toBe(1);
  });
});
