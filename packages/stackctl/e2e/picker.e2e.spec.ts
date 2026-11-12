/**
 * The service picker, by key and by click, and the step from it into the run screen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Pty } from './pty.js';
import { allRunning, expectTerminalRestored, fixtureWorkspace } from './suite.js';

const ws = fixtureWorkspace();

/** The development session folders there are now. */
const sessionFolders = (): string[] => {
  try {
    return fs.readdirSync(path.join(ws(), 'node_modules/.stackctl/modes/development/sessions'));
  } catch {
    return [];
  }
};

/** Moves the picker's cursor down (it wraps) until it is on `name`'s row. */
async function cursorOn(pty: Pty, name: string): Promise<void> {
  const row = new RegExp(`❯ [◉○] ${name}\\b`);
  for (let i = 0; i < 4 && !row.test(pty.text()); i++) {
    const before = pty.text();
    pty.press('down');
    await pty.waitUntil(() => pty.text() !== before, 'the cursor to move');
  }
  expect(pty.text()).toMatch(row);
}

/** The picker, up, with nothing selected (it remembers the last selection otherwise). */
async function emptyPicker(): Promise<Pty> {
  const pty = await Pty.start({ cwd: ws() });
  await pty.waitFor('choose services');
  pty.press('n');
  await pty.waitFor('will start  nothing selected');
  return pty;
}

test('the picker starts what was chosen, and the run screen shows the startup, then every service running', async () => {
  const pty = await emptyPicker();
  // The dependency comes first.
  expect(pty.text()).toMatch(/❯ ○ api\n\s+○ web\n\s+○ worker/);

  await cursorOn(pty, 'web');
  pty.press('space');
  await pty.waitFor('◉ web');
  await cursorOn(pty, 'worker');
  pty.press('space');
  await pty.waitFor('◉ worker');
  expect(pty.text()).toMatch(/◉ api\s+needed by web/);
  expect(pty.text()).toContain('will start  web · worker · api');

  pty.press('enter');
  await pty.waitFor('r restart');
  await pty.waitUntil(() => allRunning(pty), 'every service running');

  // The footer during startup: every service pending, in gray, and the keys api will have, dim.
  expect(
    pty.everShown(/○ api {3}○ web {3}○ worker\n←→ select {3}r restart {3}s stop {3}m commands/),
  ).toBe(true);
  expect(pty.everDots('api:90 web:90 worker:90')).toBe(true);
  // api isn't ready for a second, its dot yellow, and web waits for it, its dot cyan.
  expect(pty.everShown(/● api.*○ web/)).toBe(true);
  expect(pty.everDots(/^api:33 web:36/)).toBe(true);
  // Then the first service has the focus.
  expect(pty.focusedService()).toBe('api');
  const log = pty.text();
  const order = [
    'api: runtime dep of web',
    /\[web\s*\] waiting for api\.\.\./,
    /\[api\s*\] api listening on 21081/,
    /\[web\s*\] api ready, starting\.\.\./,
    /\[web\s*\] web listening on 21082/,
  ].map((needle) => log.search(needle));
  expect(
    order.every((at) => at >= 0),
    `in the log:\n${log}`,
  ).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));

  pty.press('ctrl-c');
  await pty.waitFor('Press Ctrl+C again to exit');
  pty.press('ctrl-c');
  expect(await pty.waitForExit()).toEqual({ code: 0, signal: null });
  expect(expectTerminalRestored(pty)).toContain('■ stackctl exited after');
});

test('picker clicks toggle a row and explain a locked dependency; n clears; / filters', async () => {
  const before = sessionFolders();
  const pty = await emptyPicker();

  // A click on a row toggles it.
  pty.clickText('○ worker', 2);
  await pty.waitFor('◉ worker');
  pty.clickText('◉ worker', 2);
  await pty.waitFor('○ worker');
  expect(pty.text()).toContain('will start  nothing selected');

  // web needs api, so api is locked while web is picked; a click on it says why.
  pty.clickText('○ web', 2);
  await pty.waitFor(/◉ api\s+needed by web/);
  pty.clickText('◉ api', 2);
  await pty.waitFor('api is needed by web');
  expect(pty.text()).toMatch(/◉ api\s+needed by web/);
  expect(pty.text()).toContain('will start  web · api');

  pty.press('n');
  await pty.waitFor('will start  nothing selected');
  expect(pty.text()).toMatch(/○ api\n.*○ web.*\n.*○ worker/);

  // `/` filters as typed; ⏎ keeps the filter, and space then picks the row left.
  pty.press('/');
  await pty.waitFor('filter ›');
  pty.type('wor');
  await pty.waitFor('filter › wor');
  await pty.waitUntil(() => !pty.text().includes('○ api'), 'the other rows filtered out');
  expect(pty.text()).toMatch(/❯ ○ worker/);
  pty.press('enter');
  await pty.waitFor('/ filter: wor');
  pty.press('space');
  await pty.waitFor('◉ worker');
  expect(pty.text()).toContain('will start  worker');
  // esc clears the filter: every row again, the pick kept.
  pty.press('esc');
  await pty.waitFor('○ api');
  expect(pty.text()).toMatch(/○ web/);
  expect(pty.text()).toContain('◉ worker');

  // ^c quits the picker at once, with no session started: no session folder is left.
  pty.press('ctrl-c');
  expect(await pty.waitForExit()).toEqual({ code: 0, signal: null });
  expect(expectTerminalRestored(pty)).toContain('■ stackctl exited after');
  expect(sessionFolders()).toEqual(before);
});
