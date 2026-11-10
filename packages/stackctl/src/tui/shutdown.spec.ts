import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import React from 'react';
import { Text, render } from 'ink';
import { describe, expect, test, vi } from 'vitest';
import { MOUSE_DISABLE } from '../mouse.js';
import type { Session } from '../session/session.js';
import { useShutdown } from './shutdown.js';

const h = React.createElement;

/** A session double: its phase, its subscribers, and a `closed` the test settles. */
function fakeSession() {
  const listeners = new Set<() => void>();
  let phase = 'running';
  let resolveClosed!: (code: number) => void;
  const fake = {
    hardKilled: false,
    closed: new Promise<number>((resolve) => (resolveClosed = resolve)),
    getSnapshot: () => ({ phase }),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return {
    session: fake as unknown as Session,
    fake,
    stopping: () => {
      phase = 'stopping';
      listeners.forEach((fn) => fn());
    },
    close: (code: number) => resolveClosed(code),
  };
}

/** Mounts a component running `useShutdown`; `writes` is what the hook wrote to its stdout. */
function mount(session: Session, endProcess: (code: number) => void) {
  const writes: string[] = [];
  const out = Object.assign(new EventEmitter(), {
    write: (data: string) => writes.push(data) > 0,
  }) as unknown as NodeJS.WritableStream;
  const screen = Object.assign(new Writable({ write: (_c, _e, cb) => cb() }), { columns: 80 });
  function Harness() {
    useShutdown(session, out, endProcess);
    return h(Text, null, 'up');
  }
  const instance = render(h(Harness), {
    stdout: screen as unknown as NodeJS.WriteStream,
    debug: true,
  });
  let exited = false;
  void instance.waitUntilExit().then(() => (exited = true));
  return { writes, instance, exited: () => exited };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('useShutdown', () => {
  test('the mouse is released once, as soon as the phase turns stopping', async () => {
    const t = fakeSession();
    const view = mount(t.session, () => {});
    await settle();
    expect(view.writes).toEqual([]);
    t.stopping();
    t.stopping();
    expect(view.writes).toEqual([MOUSE_DISABLE]);
    view.instance.unmount();
  });

  test('once the session has closed, Ink unmounts and the safety net is armed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const t = fakeSession();
      const endProcess = vi.fn();
      const view = mount(t.session, endProcess);
      t.stopping();
      t.close(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(view.exited()).toBe(true);
      expect(endProcess).not.toHaveBeenCalled();
      // Ink's teardown stalled: the net ends the process with the session's code.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(endProcess).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('after a hard kill the process ends at once with 1, without waiting for Ink', async () => {
    const t = fakeSession();
    const endProcess = vi.fn();
    const view = mount(t.session, endProcess);
    t.stopping();
    t.fake.hardKilled = true;
    t.close(1);
    await settle();
    expect(endProcess).toHaveBeenCalledWith(1);
    expect(view.exited()).toBe(false);
    view.instance.unmount();
  });
});
