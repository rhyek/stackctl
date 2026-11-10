import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import React from 'react';
import { Text, render } from 'ink';
import { describe, expect, test } from 'vitest';
import { MOUSE_DISABLE, MOUSE_ENABLE, type MouseReport } from '../mouse.js';
import {
  type ClickTarget,
  type MouseHandlers,
  createReportHandler,
  useMouse,
} from './use-mouse.js';

const QUIT: ClickTarget = {
  id: 'hint:quit',
  rect: { col: 10, row: 20, width: 7, height: 1 },
  action: { type: 'quit' },
};
const CLEAR: ClickTarget = {
  id: 'hint:clear',
  rect: { col: 20, row: 20, width: 7, height: 1 },
  action: { type: 'clear-log' },
};

function harness() {
  const calls: string[] = [];
  const handlers: MouseHandlers = {
    targets: () => [QUIT, CLEAR],
    onClick: (t) => calls.push(`click ${t?.id ?? 'nothing'}`),
    onWheel: (dir) => calls.push(`wheel ${dir}`),
    onPointer: (r) => calls.push(`pointer ${r.type}`),
    onError: () => {},
  };
  const handle = createReportHandler(() => handlers);
  const send = (...reports: MouseReport[]) => reports.forEach(handle);
  return { calls, send };
}

const down = (col: number, row: number, button = 0): MouseReport => ({ type: 'down', button, col, row }); // oxfmt-ignore
const move = (col: number, row: number): MouseReport => ({ type: 'move', button: 0, col, row });
const up = (col: number, row: number): MouseReport => ({ type: 'up', button: 0, col, row });

describe('mouse reports', () => {
  test('a press and release on the same target is a click, and reaches no selection', () => {
    const h = harness();
    h.send(down(11, 20), up(16, 20));
    expect(h.calls).toEqual(['click hint:quit']);
  });

  test('a press and release on different targets, or with a drag between, is no click', () => {
    const h = harness();
    h.send(down(11, 20), up(21, 20));
    h.send(down(11, 20), move(12, 20), up(12, 20));
    h.send(down(11, 20), up(30, 5));
    expect(h.calls).toEqual([]);
  });

  test('a press on a target dragged into the pane starts no selection', () => {
    const h = harness();
    h.send(down(11, 20), move(11, 5), move(30, 4), up(30, 4));
    expect(h.calls).toEqual([]);
  });

  test('a press in the pane goes to the selection; with no drag it is a click on nothing', () => {
    const h = harness();
    h.send(down(5, 5), up(5, 5));
    expect(h.calls).toEqual(['pointer down', 'pointer up', 'click nothing']);
  });

  test('a drag in the pane selects and is no click, whatever lies under the release', () => {
    const h = harness();
    h.send(down(5, 5), move(9, 6), up(11, 20));
    expect(h.calls).toEqual(['pointer down', 'pointer move', 'pointer up']);
  });

  test('the wheel scrolls; other buttons and a release with no press do nothing', () => {
    const h = harness();
    h.send({ type: 'wheel', dir: 'up', col: 5, row: 5 }, down(11, 20, 2), up(11, 20));
    expect(h.calls).toEqual(['wheel up']);
  });

  test('the targets are read on each press and release, so a relayout between counts', () => {
    const calls: string[] = [];
    let targets: ClickTarget[] = [QUIT];
    const handle = createReportHandler(() => ({
      targets: () => targets,
      onClick: (t) => calls.push(`click ${t?.id ?? 'nothing'}`),
      onWheel: () => {},
      onPointer: () => {},
      onError: () => {},
    }));
    handle(down(11, 20));
    // The same target, moved by a relayout: still a click on it (isClick compares ids).
    targets = [{ ...QUIT, rect: { ...QUIT.rect, row: 21 } }];
    handle(up(11, 21));
    expect(calls).toEqual(['click hint:quit']);
  });
});

describe('useMouse', () => {
  /** Mounts a component taking the mouse over fake streams; returns them and the hook's handle. */
  function mount() {
    const writes: string[] = [];
    const clicks: string[] = [];
    let paused = 0;
    const stdin = Object.assign(new EventEmitter(), {
      pause: () => {
        paused++;
      },
    }) as unknown as NodeJS.ReadableStream & EventEmitter;
    const stdout = Object.assign(new EventEmitter(), {
      write: (data: string) => writes.push(data) > 0,
    }) as unknown as NodeJS.WritableStream & EventEmitter;
    const handlers: MouseHandlers = {
      targets: () => [QUIT],
      onClick: (t) => clicks.push(t?.id ?? 'nothing'),
      onWheel: () => {},
      onPointer: () => {},
      onError: () => {},
    };
    const handle: { dropKey?: () => boolean } = {};
    function Harness({ enabled }: { enabled: boolean }) {
      const mouse = useMouse(enabled, { stdin, stdout }, handlers);
      handle.dropKey = () => mouse.dropKey();
      return React.createElement(Text, null, 'up');
    }
    const screen = Object.assign(new Writable({ write: (_c, _e, cb) => cb() }), { columns: 80 });
    const instance = render(React.createElement(Harness, { enabled: true }), {
      stdout: screen as unknown as NodeJS.WriteStream,
      debug: true,
    });
    return {
      writes,
      clicks,
      stdin,
      stdout,
      handle,
      paused: () => paused,
      disable: () => instance.rerender(React.createElement(Harness, { enabled: false })),
      unmount: () => instance.unmount(),
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  test('enables on mount, re-asserts on a resize, and dispatches reports from stdin', async () => {
    const m = mount();
    try {
      await settle();
      expect(m.writes).toEqual([MOUSE_ENABLE]);
      m.stdout.emit('resize');
      expect(m.writes).toEqual([MOUSE_ENABLE, MOUSE_ENABLE]);
      // A report split across two reads still decodes.
      m.stdin.emit('data', '\x1b[<0;11;20M\x1b[<0;1');
      m.stdin.emit('data', '1;20m');
      expect(m.clicks).toEqual(['hint:quit']);
      expect(m.handle.dropKey!()).toBe(false);
    } finally {
      m.unmount();
    }
  });

  test('a legacy report re-asserts SGR and drops the next key event, once', async () => {
    const m = mount();
    try {
      await settle();
      m.stdin.emit('data', '\x1b[M #!');
      expect(m.writes).toEqual([MOUSE_ENABLE, MOUSE_ENABLE]);
      expect(m.handle.dropKey!()).toBe(true);
      expect(m.handle.dropKey!()).toBe(false);
    } finally {
      m.unmount();
    }
  });

  test('disabling releases the mouse and stops listening', async () => {
    const m = mount();
    await settle();
    m.disable();
    await settle();
    expect(m.writes).toEqual([MOUSE_ENABLE, MOUSE_DISABLE]);
    expect(m.stdin.listenerCount('data')).toBe(0);
    expect(m.paused()).toBe(1);
    m.stdin.emit('data', '\x1b[<0;11;20M\x1b[<0;11;20m');
    m.stdout.emit('resize');
    expect(m.clicks).toEqual([]);
    expect(m.writes).toHaveLength(2);
    m.unmount();
  });
});
