import { Writable } from 'node:stream';
import React from 'react';
import { Text, render } from 'ink';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { stripAnsi } from '../format.js';
import type { Session, SessionSnapshot } from '../session/session.js';
import { FooterBoundary, guardedFooterLayout, guardedMenuLayout } from './FooterBoundary.js';
import type { FooterLayout } from './layout.js';
import { initialUiState } from './ui-state.js';

const h = React.createElement;

function fakeSession() {
  const errors: string[] = [];
  const session = { systemLog: { error: (m: string) => errors.push(m) } } as unknown as Session;
  return { session, errors };
}

const layout = (): FooterLayout => ({
  rows: [],
  height: 0,
  keysRow: 0,
  targets: [],
  rects: [],
  entries: [],
});

function mount(node: React.ReactElement) {
  const frames: string[] = [];
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        frames.push(String(chunk));
        callback();
      },
    }),
    { columns: 80 },
  );
  const instance = render(node, { stdout: stdout as unknown as NodeJS.WriteStream, debug: true });
  const frame = () => stripAnsi(frames.at(-1) ?? '');
  return { instance, frame };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the footer guard', () => {
  test('a render fault draws one dim line and is logged; a new layout tries again', async () => {
    // React reports a caught render error on the console as well; keep the run's output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { session, errors } = fakeSession();
    let broken = true;
    function Body() {
      if (broken) {
        throw new Error('bad row');
      }
      return h(Text, null, 'the footer');
    }
    const first = layout();
    const view = mount(h(FooterBoundary, { session, layout: first, children: h(Body) }));
    try {
      await settle();
      expect(view.frame()).toContain('footer failed to render; see the log');
      expect(errors).toEqual(['render the footer failed: bad row']);

      // The same layout keeps the fallback; a new one renders the footer again.
      broken = false;
      view.instance.rerender(h(FooterBoundary, { session, layout: first, children: h(Body) }));
      await settle();
      expect(view.frame()).toContain('footer failed to render');
      view.instance.rerender(h(FooterBoundary, { session, layout: layout(), children: h(Body) }));
      await settle();
      expect(view.frame()).toContain('the footer');
    } finally {
      view.instance.unmount();
    }
  });

  test('a layout fault falls back to one line, and a fault that persists is logged once', () => {
    const { session, errors } = fakeSession();
    const broken = { phase: 'running' } as unknown as SessionSnapshot;
    const a = guardedFooterLayout(session, broken, initialUiState, 80, {});
    const b = guardedFooterLayout(session, broken, initialUiState, 80, {});
    expect(a.rows).toEqual([[{ text: 'footer failed to render; see the log', dim: true }]]);
    expect(a).toMatchObject({ height: 1, targets: [], entries: [] });
    expect(b).toBe(a);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^lay out the footer failed: /);

    expect(guardedMenuLayout(session, broken, { ...initialUiState, mode: 'commands', menu: { selected: 0, custom: '' } }, 80, { commands: {}, rects: [] })).toBeNull(); // oxfmt-ignore
  });
});
