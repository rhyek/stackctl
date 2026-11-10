import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { stripAnsi } from '../format.js';
import { LogStore } from '../session/log-store.js';
import {
  type DragSelection,
  LogPane,
  type LogViewport,
  useDragSelection,
  useLogViewport,
} from './LogPane.js';

// A copy-on-select must not reach the machine's real clipboard.
vi.mock('../clipboard.js', () => ({ copyToClipboard: vi.fn() }));

const h = React.createElement;

let dir: string;
let store: LogStore | undefined;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-log-pane-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  await store?.close();
  store = undefined;
});

function newStore(): LogStore {
  store = new LogStore({ logFile: path.join(dir, 'devlog.txt') });
  return store;
}

/** Appends a stackctl line stamped `ts`, as if it had been logged then. */
function logAt(logs: LogStore, ts: string, text: string): void {
  logs.append({
    service: null,
    text: `[INFO] ${text}`,
    isError: false,
    at: Date.parse(ts.replace(' ', 'T')),
    ts,
    showTs: true,
    label: '[stackctl]',
    filterKey: 'system',
  });
}

/**
 * Mounts `useLogViewport` + `LogPane` at `columns` × `height` and returns the latest frame's
 * rows (ANSI stripped) plus a handle on the viewport for driving the scroll position.
 */
function mount(mgr: LogStore, columns: number, height: number) {
  const frames: string[] = [];
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        frames.push(String(chunk));
        callback();
      },
    }),
    { columns },
  );
  const handle: { viewport?: LogViewport } = {};
  function Harness() {
    const viewport = useLogViewport(mgr, columns, height);
    handle.viewport = viewport;
    return h(LogPane, { rows: viewport.rows });
  }
  const instance = render(h(Harness), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
  });
  const frame = () =>
    stripAnsi(frames[frames.length - 1] ?? '')
      .split('\n')
      .filter((row) => row.trim() !== '');
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
  return {
    frame,
    viewport: () => handle.viewport!,
    settle,
    unmount: () => instance.unmount(),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[/;
const TIME = /^\d{2}:\d{2}:\d{2} \[/;

describe('useLogViewport timestamp layout', () => {
  test('shows only the time while every stamp on screen is from the same day', () => {
    const mgr = newStore();
    logAt(mgr, '2026-09-06 08:00:00', 'one');
    logAt(mgr, '2026-09-06 09:00:00', 'two');
    const view = mount(mgr, 120, 10);
    try {
      const rows = view.frame();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatch(TIME);
        expect(row).not.toMatch(DATE);
      }
      expect(view.viewport().tsMode).toBe('time');
    } finally {
      view.unmount();
    }
  });

  test('shows the full date as soon as two days are visible together', () => {
    const mgr = newStore();
    logAt(mgr, '2026-09-05 23:59:59', 'yesterday');
    logAt(mgr, '2026-09-06 00:00:01', 'today');
    const view = mount(mgr, 120, 10);
    try {
      const rows = view.frame();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatch(/^2026-09-05 23:59:59 \[/);
      expect(rows[1]).toMatch(/^2026-09-06 00:00:01 \[/);
      expect(view.viewport().tsMode).toBe('date');
    } finally {
      view.unmount();
    }
  });

  test('judges only the lines on screen, not the whole buffer', () => {
    const mgr = newStore();
    logAt(mgr, '2026-09-05 23:59:59', 'yesterday');
    for (let i = 0; i < 5; i++) {
      logAt(mgr, `2026-09-06 00:00:0${String(i)}`, `today ${String(i)}`);
    }
    // A 3-row pane following the tail shows only today's lines.
    const view = mount(mgr, 120, 3);
    try {
      expect(view.viewport().tsMode).toBe('time');
      expect(view.frame().every((row) => TIME.test(row))).toBe(true);
    } finally {
      view.unmount();
    }
  });

  test('scrolling back across midnight brings the date column in, and forward drops it again', async () => {
    const mgr = newStore();
    logAt(mgr, '2026-09-05 23:59:59', 'yesterday');
    for (let i = 0; i < 3; i++) {
      logAt(mgr, `2026-09-06 00:00:0${String(i)}`, `today ${String(i)}`);
    }
    const view = mount(mgr, 120, 3);
    try {
      expect(view.viewport().tsMode).toBe('time');
      view.viewport().scrollLines(1);
      await view.settle();
      // The window now starts at yesterday's line: full dates, and exactly one row hidden below.
      expect(view.viewport().tsMode).toBe('date');
      expect(view.viewport().hiddenBelow).toBe(1);
      const rows = view.frame();
      expect(rows[0]).toContain('yesterday');
      expect(rows[rows.length - 1]).toContain('today 1');
      view.viewport().scrollLines(-1);
      await view.settle();
      expect(view.viewport().tsMode).toBe('time');
      expect(view.viewport().following).toBe(true);
      expect(view.frame()[2]).toContain('today 2');
      // Home lands on the very top whichever layout is rendered.
      view.viewport().scrollToTop();
      await view.settle();
      expect(view.viewport().hiddenAbove).toBe(0);
      expect(view.viewport().following).toBe(false);
      expect(view.frame()[0]).toContain('yesterday');
    } finally {
      view.unmount();
    }
  });

  test('keeps the same bottom edge when the date column reflows a wrapped line', async () => {
    const mgr = newStore();
    const columns = 60;
    logAt(mgr, '2026-09-05 23:59:59', 'yesterday');
    // With the `[stackctl] [INFO] ` prefix this takes 3 rows beside the date column and 2 without.
    logAt(mgr, '2026-09-06 00:00:00', 'w'.repeat(53));
    logAt(mgr, '2026-09-06 00:00:01', 'today 1');
    logAt(mgr, '2026-09-06 00:00:02', 'today 2');
    const lines = mgr.getVisibleLines();
    const wrapped = lines[1]!;
    expect(mgr.countRows(wrapped, columns, 'date')).toBeGreaterThan(
      mgr.countRows(wrapped, columns, 'time'),
    );
    const view = mount(mgr, columns, 4);
    try {
      expect(view.viewport().tsMode).toBe('time');
      // Scroll up until yesterday's line is in view: the layout flips to dates, and the row at the
      // bottom edge must still be the one the scroll landed on — not shifted by the extra row the
      // wrapped line now takes.
      view.viewport().scrollLines(1);
      await view.settle();
      expect(view.viewport().hiddenBelow).toBe(1);
      expect(view.frame().at(-1)).toContain('today 1');
      view.viewport().scrollLines(1);
      await view.settle();
      expect(view.viewport().hiddenBelow).toBe(2);
      expect(view.frame().at(-1)).toMatch(/w+$/);
      expect(view.viewport().tsMode).toBe('date');
    } finally {
      view.unmount();
    }
  });
});

describe('useDragSelection', () => {
  test('a selection scrolled out of view is still a selection', async () => {
    const logs = newStore();
    for (let i = 0; i < 20; i++) {
      logAt(logs, '2026-09-06 08:00:00', `line ${String(i)}`);
    }
    const stdout = Object.assign(new Writable({ write: (_c, _e, cb) => cb() }), { columns: 80 });
    const handle: { viewport?: LogViewport; selection?: DragSelection } = {};
    const notify = () => 1;
    const dismiss = () => {};
    function Harness() {
      const viewport = useLogViewport(logs, 80, 5);
      const selection = useDragSelection({
        rows: viewport.rows,
        firstVisibleFlatRow: viewport.firstVisibleFlatRow,
        topHeight: 0,
        paneHeight: 5,
        notify,
        dismiss,
      });
      handle.viewport = viewport;
      handle.selection = selection;
      return h(LogPane, { rows: viewport.rows, highlights: selection.highlights });
    }
    const instance = render(h(Harness), { stdout: stdout as unknown as NodeJS.WriteStream, debug: true }); // oxfmt-ignore
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
    try {
      await settle();
      expect(handle.selection!.hasSelection()).toBe(false);
      handle.selection!.onMouse({ type: 'down', button: 0, col: 1, row: 5 });
      handle.selection!.onMouse({ type: 'move', button: 0, col: 12, row: 5 });
      handle.selection!.onMouse({ type: 'up', button: 0, col: 12, row: 5 });
      await settle();
      expect(handle.selection!.highlights.some(Boolean)).toBe(true);
      handle.viewport!.scrollLines(10);
      await settle();
      // Off screen: nothing highlighted, and still a selection for the `esc` chain to clear.
      expect(handle.selection!.highlights.some(Boolean)).toBe(false);
      expect(handle.selection!.hasSelection()).toBe(true);
      expect(handle.selection!.clear()).toBe(true);
      expect(handle.selection!.hasSelection()).toBe(false);
    } finally {
      instance.unmount();
    }
  });
});
