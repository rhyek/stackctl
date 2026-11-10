import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { stripAnsi } from '../format.js';
import type { SessionSnapshot } from '../session/session.js';
import {
  type ExitIo,
  type ExitSession,
  crashRestore,
  failWith,
  finish,
  uncaughtIsHandled,
} from './app-exit.js';

/** A fake process: what was written where, in order, and the exit code. */
function fakeIo(now = 65_000) {
  const events: string[] = [];
  const stream = (name: string) => ({
    write: (data: string | Uint8Array, cb?: (err?: Error | null) => void) => {
      events.push(`${name}: ${stripAnsi(String(data))}`);
      // A write that flushes later, as a pipe's does: the exit must wait for it.
      setTimeout(() => cb?.(), 5);
      return true;
    },
  });
  const io: ExitIo = {
    stdout: stream('stdout') as unknown as ExitIo['stdout'],
    stderr: stream('stderr') as unknown as ExitIo['stderr'],
    exit: (code) => events.push(`exit ${String(code)}`),
    now: () => now,
  };
  return { io, events };
}

function fakeSession(phase: SessionSnapshot['phase'], code: number) {
  const shutdown = vi.fn(async () => {});
  const session: ExitSession = {
    getSnapshot: () => ({ phase }) as SessionSnapshot,
    shutdown,
    closed: Promise.resolve(code),
    getLogFile: () => path.join(process.cwd(), 'logs', 'a.log'),
  };
  return { session, shutdown };
}

const STARTED = 5_000; // a minute before the fake clock's 65 s

describe('finish', () => {
  test('from the picker: the exit line alone, exit 0', async () => {
    const { io, events } = fakeIo();
    await finish({ session: null, failure: null }, null, STARTED, io);
    expect(events).toEqual(['stdout: ■ stackctl exited after 1 minute\n', 'exit 0']);
  });

  test('a session that could not be made prints why on stderr and exits 1, once flushed', async () => {
    const { io, events } = fakeIo();
    await finish(
      { session: null, failure: new Error('no service is named ghost') },
      null,
      STARTED,
      io,
    );
    expect(events).toEqual(['stderr: stackctl: no service is named ghost\n', 'exit 1']);
  });

  test('a picker that crashed prints the error and exits 1, with no exit line', async () => {
    const { io, events } = fakeIo();
    await finish({ session: null, failure: null }, new Error('render failed'), STARTED, io);
    expect(events).toEqual(['stderr: stackctl: render failed\n', 'exit 1']);
  });

  test('from the run screen: the exit line and the logfile, with the session code', async () => {
    const { io, events } = fakeIo();
    const { session, shutdown } = fakeSession('stopping', 1);
    await finish({ session, failure: null }, null, STARTED, io);
    expect(shutdown).not.toHaveBeenCalled();
    expect(events).toEqual([
      `stdout: ■ stackctl exited after 1 minute\n  logfile: ${path.join('logs', 'a.log')}\n`,
      'exit 1',
    ]);
  });

  test('Ink gone before the session stopped: the session is shut down here, exit 1', async () => {
    const { io, events } = fakeIo();
    const { session, shutdown } = fakeSession('running', 0);
    await finish({ session, failure: null }, null, STARTED, io);
    expect(shutdown).toHaveBeenCalledWith('user');
    expect(events.at(-1)).toBe('exit 1');
  });

  test('a render crash while already stopping never makes the shutdown a hard kill', async () => {
    const { io, events } = fakeIo();
    const { session, shutdown } = fakeSession('stopping', 0);
    await finish({ session, failure: null }, new Error('frame failed'), STARTED, io);
    // A second shutdown call on a stopping session is the hard kill: it must not happen.
    expect(shutdown).not.toHaveBeenCalled();
    expect(events[0]).toBe('stderr: stackctl: frame failed\n');
    expect(events.at(-1)).toBe('exit 1');
  });

  test('finish exits only after its exit line is flushed', async () => {
    const { io, events } = fakeIo();
    const done = finish({ session: null, failure: null }, null, STARTED, io);
    expect(events).toEqual(['stdout: ■ stackctl exited after 1 minute\n']);
    await done;
    expect(events).toEqual(['stdout: ■ stackctl exited after 1 minute\n', 'exit 0']);
  });

  test('failWith exits only after its line is flushed', async () => {
    const { io, events } = fakeIo();
    const done = failWith(new Error('no config'), io);
    expect(events).toEqual(['stderr: stackctl: no config\n']);
    await done;
    expect(events).toEqual(['stderr: stackctl: no config\n', 'exit 1']);
  });
});

describe('the crash monitor', () => {
  const hooks = (listeners: number, capture: boolean) => ({
    listenerCount: () => listeners,
    hasUncaughtExceptionCaptureCallback: () => capture,
  });

  test('an error with no handler is fatal: Ink unmounts, then the exit hook goes', () => {
    const calls: string[] = [];
    const onCrash = crashRestore(
      () => calls.push('unmount'),
      () => calls.push('remove exit hook'),
      () => uncaughtIsHandled(hooks(0, false) as never),
    );
    onCrash();
    expect(calls).toEqual(['unmount', 'remove exit hook']);
  });

  test('a swallowed throw leaves the screen up: a listener or a capture callback handles it', () => {
    expect(uncaughtIsHandled(hooks(1, false) as never)).toBe(true);
    expect(uncaughtIsHandled(hooks(0, true) as never)).toBe(true);
    const calls: string[] = [];
    const onCrash = crashRestore(
      () => calls.push('unmount'),
      () => calls.push('remove exit hook'),
      () => uncaughtIsHandled(hooks(1, false) as never),
    );
    onCrash();
    expect(calls).toEqual([]);
  });

  test('a config that installs its own handler counts, through the real process', () => {
    const swallow = () => {};
    process.on('uncaughtException', swallow);
    try {
      expect(uncaughtIsHandled()).toBe(true);
    } finally {
      process.off('uncaughtException', swallow);
    }
  });

  test('an unmount that throws keeps the exit hook, which restores the terminal instead', () => {
    const calls: string[] = [];
    const onCrash = crashRestore(
      () => {
        throw new Error('half torn down');
      },
      () => calls.push('remove exit hook'),
      () => false,
    );
    expect(() => onCrash()).not.toThrow();
    expect(calls).toEqual([]);
  });
});
