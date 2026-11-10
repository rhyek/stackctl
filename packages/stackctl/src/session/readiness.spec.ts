import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { type Clock, probeHealthcheck, Readiness } from './readiness.js';

const HC = { url: 'http://127.0.0.1:1/health', timeout: 1500 };

/** Lets every pending promise callback run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A clock whose time moves only when a test advances it, running due timers in order. */
class FakeClock implements Clock {
  private time = 0;
  private nextId = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    await settle();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) {
          next = entry;
        }
      }
      if (!next) {
        break;
      }
      this.timers.delete(next[0]);
      this.time = next[1].at;
      next[1].fn();
      await settle();
    }
    this.time = target;
  }
}

/** A probe whose answers the test sets, recording when each probe started. */
function stubProbe(clock: FakeClock) {
  const calls: { name: string; at: number }[] = [];
  const answers = new Map<string, boolean | Error>();
  const probe = (name: string) => {
    calls.push({ name, at: clock.now() });
    const answer = answers.get(name) ?? false;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { calls, answers, probe };
}

function setup() {
  const clock = new FakeClock();
  const stub = stubProbe(clock);
  const readiness = new Readiness({ clock, probe: stub.probe });
  const events: string[] = [];
  readiness.on('ready', (name) => events.push(`ready ${name}`));
  readiness.on('unready', (name) => events.push(`unready ${name}`));
  return { clock, readiness, events, ...stub };
}

const gaps = (times: number[]) => times.map((t, i) => t - (times[i - 1] ?? 0));

describe('Readiness', () => {
  test('probes back off from 100 ms to 2 s', async () => {
    const { clock, readiness, calls } = setup();
    readiness.track('api', HC);
    readiness.processStarted('api');
    await clock.advance(13_100);
    expect(gaps(calls.map((c) => c.at))).toEqual([
      100, 200, 400, 800, 1600, 2000, 2000, 2000, 2000, 2000,
    ]);
  });

  test('a probe slower than its gap is followed at once, and probes never overlap', async () => {
    const clock = new FakeClock();
    const starts: number[] = [];
    let inFlight = 0;
    let overlapped = false;
    const readiness = new Readiness({
      clock,
      probe: () => {
        starts.push(clock.now());
        overlapped ||= inFlight > 0;
        inFlight++;
        return new Promise((resolve) =>
          clock.setTimeout(() => {
            inFlight--;
            resolve(false);
          }, 300),
        );
      },
    });
    readiness.track('api', HC);
    readiness.processStarted('api');
    await clock.advance(1500);
    // 100; then 200 after it started, but it took 300: at once (400); then 400 after (800).
    expect(starts).toEqual([100, 400, 800]);
    expect(overlapped).toBe(false);
  });

  test('ready on first passing probe', async () => {
    const { clock, readiness, answers, events } = setup();
    readiness.track('api', HC);
    readiness.processStarted('api');
    await clock.advance(300);
    expect(readiness.isReady('api')).toBe(false);
    answers.set('api', true);
    await clock.advance(400);
    expect(readiness.isReady('api')).toBe(true);
    expect(events).toEqual(['ready api']);
  });

  test('a failing probe after a passing one makes it unready, and probing goes on', async () => {
    const { clock, readiness, answers, events, calls } = setup();
    answers.set('api', true);
    readiness.track('api', HC);
    readiness.processStarted('api');
    await clock.advance(100);
    answers.set('api', false);
    await clock.advance(200);
    answers.set('api', true);
    await clock.advance(400);
    expect(events).toEqual(['ready api', 'unready api', 'ready api']);
    expect(calls).toHaveLength(3);
  });

  test('a probe that throws counts as failing and the loop goes on', async () => {
    const clock = new FakeClock();
    let n = 0;
    const readiness = new Readiness({
      clock,
      probe: () => {
        n++;
        if (n === 1) {
          throw new Error('sync');
        }
        return n === 2 ? Promise.reject(new Error('async')) : Promise.resolve(true);
      },
    });
    readiness.track('api', HC);
    readiness.processStarted('api');
    await clock.advance(300);
    expect(n).toBe(2);
    expect(readiness.isReady('api')).toBe(false);
    await clock.advance(400);
    expect(readiness.isReady('api')).toBe(true);
  });

  test('a service without a healthcheck is ready while it runs', async () => {
    const { clock, readiness, events, calls } = setup();
    readiness.track('worker', undefined);
    expect(readiness.isReady('worker')).toBe(false);
    readiness.processStarted('worker');
    expect(readiness.isReady('worker')).toBe(true);
    readiness.processExited('worker');
    expect(readiness.isReady('worker')).toBe(false);
    await clock.advance(5000);
    expect(calls).toEqual([]);
    expect(events).toEqual(['ready worker', 'unready worker']);
  });

  test('exit makes it unready and stops probing', async () => {
    const { clock, readiness, answers, events, calls } = setup();
    answers.set('api', true);
    readiness.track('api', HC);
    readiness.processStarted('api');
    await clock.advance(100);
    expect(readiness.isReady('api')).toBe(true);
    readiness.processExited('api');
    expect(readiness.isReady('api')).toBe(false);
    await clock.advance(10_000);
    expect(calls).toHaveLength(1);
    expect(events).toEqual(['ready api', 'unready api']);
  });

  test('a probe in flight at exit is discarded', async () => {
    const clock = new FakeClock();
    let pass!: (ok: boolean) => void;
    const readiness = new Readiness({
      clock,
      probe: () => new Promise((resolve) => (pass = resolve)),
    });
    readiness.track('api', HC);
    readiness.processStarted('api');
    await clock.advance(100);
    readiness.processExited('api');
    pass(true);
    await settle();
    expect(readiness.isReady('api')).toBe(false);
  });

  test('each start resets the backoff to its first step', async () => {
    const { clock, readiness, calls } = setup();
    readiness.track('api', HC);
    readiness.processStarted('api');
    await clock.advance(3100);
    readiness.processExited('api');
    const restartedAt = clock.now();
    readiness.processStarted('api');
    await clock.advance(400);
    expect(calls.map((c) => c.at).filter((at) => at > restartedAt)).toEqual([
      restartedAt + 100,
      restartedAt + 300,
    ]);
  });

  test('whenReady resolves once every name is ready', async () => {
    const { clock, readiness, answers } = setup();
    readiness.track('api', HC);
    readiness.track('db', HC);
    readiness.track('cache', undefined);
    readiness.processStarted('api');
    readiness.processStarted('db');
    let resolved = false;
    const waiting = readiness
      .whenReady(['api', 'db', 'cache'], new AbortController().signal)
      .then(() => (resolved = true));
    answers.set('api', true);
    await clock.advance(1000);
    expect(resolved).toBe(false);
    readiness.processStarted('cache');
    answers.set('db', true);
    await clock.advance(1000);
    await waiting;
    expect(resolved).toBe(true);
  });

  test('whenReady resolves at once when every name is already ready', async () => {
    const { readiness } = setup();
    readiness.track('worker', undefined);
    readiness.processStarted('worker');
    await expect(
      readiness.whenReady(['worker'], new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  test('a service something waits on is probed while it is not running', async () => {
    const { clock, readiness, answers, calls } = setup();
    readiness.track('api', HC);
    const controller = new AbortController();
    const waiting = readiness.whenReady(['api'], controller.signal);
    await clock.advance(300);
    expect(calls.map((c) => c.at)).toEqual([100, 300]);
    answers.set('api', true);
    await clock.advance(400);
    await waiting;
    // Released: nothing probes it any more, and it is no longer ready.
    expect(readiness.isReady('api')).toBe(false);
    await clock.advance(5000);
    expect(calls).toHaveLength(3);
  });

  test('a service that exits while something waits on it stays probed', async () => {
    const { clock, readiness, answers, calls, events } = setup();
    answers.set('api', true);
    readiness.track('api', HC);
    readiness.processStarted('api');
    await clock.advance(100);
    readiness.processExited('api');
    answers.set('api', false);
    const waiting = readiness.whenReady(['api'], new AbortController().signal);
    await clock.advance(300);
    expect(calls).toHaveLength(3);
    answers.set('api', true);
    await clock.advance(400);
    await waiting;
    expect(events).toEqual(['ready api', 'unready api', 'ready api', 'unready api']);
  });

  test('abort rejects whenReady', async () => {
    const { clock, readiness, calls } = setup();
    readiness.track('api', HC);
    const listeners = readiness.listenerCount('ready');
    const controller = new AbortController();
    const waiting = readiness.whenReady(['api'], controller.signal);
    await clock.advance(100);
    controller.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    await clock.advance(5000);
    expect(calls).toHaveLength(1);
    expect(readiness.listenerCount('ready')).toBe(listeners);
  });

  test('an already aborted signal rejects whenReady at once', async () => {
    const { readiness } = setup();
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    await expect(readiness.whenReady(['api'], controller.signal)).rejects.toThrow('gone');
  });

  test('tracking a healthcheck makes the service unready until its probe passes', async () => {
    const { clock, readiness, answers, events } = setup();
    // Ready while it runs, for having no healthcheck; then it gets one.
    readiness.track('api', undefined);
    readiness.processStarted('api');
    expect(readiness.isReady('api')).toBe(true);
    readiness.track('api', HC);
    expect(readiness.isReady('api')).toBe(false);
    answers.set('api', true);
    await clock.advance(100);
    expect(readiness.isReady('api')).toBe(true);
    expect(events).toEqual(['ready api', 'unready api', 'ready api']);
  });

  test('a waiter is not released by a service started before its healthcheck was tracked', async () => {
    const { clock, readiness, answers } = setup();
    let released = false;
    void readiness.whenReady(['db'], new AbortController().signal).then(() => (released = true));
    readiness.processStarted('db');
    readiness.track('db', HC);
    await clock.advance(1000);
    expect(released).toBe(false);
    answers.set('db', true);
    await clock.advance(2000);
    expect(released).toBe(true);
  });

  test('a restart while a probe is in flight discards it and waits for it before probing', async () => {
    const clock = new FakeClock();
    const pending: ((ok: boolean) => void)[] = [];
    let inFlight = 0;
    let overlapped = false;
    const readiness = new Readiness({
      clock,
      probe: () => {
        overlapped ||= inFlight > 0;
        inFlight++;
        return new Promise((resolve) =>
          pending.push((ok) => {
            inFlight--;
            resolve(ok);
          }),
        );
      },
    });
    readiness.track('api', HC);
    readiness.processStarted('api');
    await clock.advance(100);
    expect(pending).toHaveLength(1);
    readiness.processExited('api');
    readiness.processStarted('api');
    // The new loop's first probe is due, but the old one hasn't settled: nothing more starts.
    await clock.advance(500);
    expect(pending).toHaveLength(1);
    pending[0]!(true);
    await settle();
    // The old result is discarded, and the new loop's probe starts at once.
    expect(readiness.isReady('api')).toBe(false);
    expect(pending).toHaveLength(2);
    pending[1]!(true);
    await settle();
    expect(readiness.isReady('api')).toBe(true);
    expect(overlapped).toBe(false);
  });

  test('a listener that throws neither ends the probe loop nor silences the others', async () => {
    const { clock, readiness, answers, calls } = setup();
    const heard: string[] = [];
    readiness.on('ready', () => {
      throw new Error('listener');
    });
    readiness.on('ready', (name) => heard.push(name));
    answers.set('api', true);
    readiness.track('api', HC);
    readiness.processStarted('api');
    await clock.advance(100);
    expect(heard).toEqual(['api']);
    await clock.advance(1000);
    expect(calls.length).toBeGreaterThan(1);
    expect(readiness.isReady('api')).toBe(true);
  });
});

describe('probeHealthcheck', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server!.close(resolve));
      server = undefined;
    }
  });

  async function serve(handler: http.RequestListener): Promise<string> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  test('a 2xx answer passes, after any redirect; any other status fails', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(204).end();
      } else if (req.url === '/moved') {
        res.writeHead(302, { location: '/ok' }).end();
      } else {
        res.writeHead(500).end('broken');
      }
    });
    expect(await probeHealthcheck({ url: `${base}/ok`, timeout: 1000 })).toBe(true);
    // A redirect is followed, and judged by where it lands.
    expect(await probeHealthcheck({ url: `${base}/moved`, timeout: 1000 })).toBe(true);
    expect(await probeHealthcheck({ url: `${base}/fail`, timeout: 1000 })).toBe(false);
  });

  test('a body slower than the timeout fails', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200);
      res.write('partial');
      setTimeout(() => res.end('done'), 2000).unref();
    });
    const began = Date.now();
    expect(await probeHealthcheck({ url: base, timeout: 200 })).toBe(false);
    expect(Date.now() - began).toBeLessThan(1500);
  });

  test('a refused connection fails', async () => {
    const base = await serve(() => {});
    server!.closeAllConnections();
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
    expect(await probeHealthcheck({ url: base, timeout: 1000 })).toBe(false);
  });
});
