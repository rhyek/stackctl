import { EventEmitter } from 'node:events';
import type { ResolvedHealthcheck } from '../config';
import { callEach } from '../util';

/** Time and timers, injectable so tests can drive them. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real clock. It reads the global timers on every call, so faked globals are honored. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as NodeJS.Timeout),
};

/**
 * What {@link Readiness} emits, each with the service's name, only when what it reports flips:
 * `ready` and `unready` for {@link Readiness.isReady}, `healthy` for {@link Readiness.isHealthy}.
 * A listener that throws is skipped over: the others still hear the event, and probing goes on.
 */
export type ReadinessEvents = {
  ready: [name: string];
  unready: [name: string];
  healthy: [name: string, healthy: boolean];
};

/**
 * What a start hook holds a service's ready at: nothing, until its hooks have run (`held`), or
 * never, since one of them failed (`failed`). An exit of its process clears either.
 */
type Hold = 'none' | 'held' | 'failed';

/**
 * One healthcheck probe: a GET of its URL, aborted after its `timeout`, the body read to the end.
 * Redirects are followed. A 2xx answer passes; any other status, a refused or reset connection,
 * a timeout, or any other error fails.
 */
export async function probeHealthcheck(healthcheck: ResolvedHealthcheck): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), healthcheck.timeout);
  try {
    const res = await fetch(healthcheck.url, { signal: controller.signal });
    await res.arrayBuffer();
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The default delay before a fresh loop's first probe, in ms. Measured against the example at
 * 61×166 (three runs each, warm and cold infra): the backend's and the worker's dots turned green
 * within about 0.15 s of their ready lines, so an earlier first probe has nothing left to gain.
 * The frontend's wait is mostly its own: after Vite is up, 0.3–0.6 s until the next probe, then
 * about 0.5 s for Vite's first server-rendered answer.
 */
export const DEFAULT_PROBE_START_MS = 100;

/**
 * The default longest gap between probes, in ms. A service that is up is probed this often for as
 * long as it runs, so the cap sets the steady cost: one GET every 2 s per service. A lower cap
 * would only catch a slow starter sooner, by at most the gap it lands in (the frontend waited
 * 0.3–0.6 s for its next probe), at several times the steady probing, and each probe of a
 * server-rendered app is a render.
 */
export const DEFAULT_PROBE_CAP_MS = 2000;

interface Loop {
  /** How many probes it has started. */
  probes: number;
  timer: unknown;
}

interface Tracked {
  /** `track` has been called for it; until then it is never ready, whether it runs or not. */
  tracked: boolean;
  healthcheck: ResolvedHealthcheck | undefined;
  running: boolean;
  /** How many pending {@link Readiness.whenReady} calls wait on it. */
  waiters: number;
  /** Its last probe passed, or, tracked without a healthcheck, it runs. */
  healthy: boolean;
  hold: Hold;
  /** Healthy and not held: what was last reported, so only a flip is emitted. */
  ready: boolean;
  /** The probe loop while it is probed; a probe whose loop is no longer this one is discarded. */
  loop: Loop | null;
  /** The probe in flight, from this loop or one before it, so probes never overlap. */
  inFlight: Promise<unknown> | null;
}

/**
 * Which services are healthy, and which are ready. A service with a healthcheck is healthy while
 * its last probe passed; one tracked without one is healthy while it runs; one never tracked is
 * never healthy. It is ready while it is healthy and no start hook holds it
 * ({@link Readiness.holdReady}). A service is probed while it runs and while anything waits on it
 * (running or not), by one loop however many wait. Each start begins a fresh loop: the first probe
 * `startMs` after it, then each one twice as long after the one before started, up to `capMs`
 * (100, 200, 400, 800, 1600, 2000, 2000, … ms by default: {@link DEFAULT_PROBE_START_MS},
 * {@link DEFAULT_PROBE_CAP_MS}). A probe that throws counts as failing.
 */
export class Readiness extends EventEmitter<ReadinessEvents> {
  private readonly clock: Clock;
  private readonly probe: (name: string) => Promise<boolean>;
  private readonly startMs: number;
  private readonly capMs: number;
  private readonly services = new Map<string, Tracked>();

  constructor(opts: {
    clock?: Clock;
    probe: (name: string) => Promise<boolean>;
    startMs?: number;
    capMs?: number;
  }) {
    super();
    // Each pending `whenReady` listens for `ready`; any number may wait at once.
    this.setMaxListeners(0);
    this.clock = opts.clock ?? systemClock;
    this.probe = opts.probe;
    this.startMs = opts.startMs ?? DEFAULT_PROBE_START_MS;
    this.capMs = opts.capMs ?? DEFAULT_PROBE_CAP_MS;
  }

  /**
   * Registers a service, or replaces its healthcheck. With a healthcheck it is unready until a
   * probe of that healthcheck passes, and one it is probing starts afresh.
   */
  track(name: string, healthcheck: ResolvedHealthcheck | undefined): void {
    const tracked = this.entry(name);
    tracked.tracked = true;
    tracked.healthcheck = healthcheck;
    if (!healthcheck) {
      this.stopLoop(tracked);
      this.setHealthy(name, tracked, tracked.running);
      return;
    }
    this.stopLoop(tracked);
    this.setHealthy(name, tracked, false);
    if (this.probed(tracked)) {
      this.startLoop(name, tracked);
    }
  }

  /**
   * The service's process started: it is unhealthy until a probe from a fresh loop passes (what
   * probes passed while nothing ran was something else answering), or, tracked without a
   * healthcheck, healthy at once. One never tracked waits for `track` to say which. A hold put on
   * it before stays.
   */
  processStarted(name: string): void {
    const tracked = this.entry(name);
    tracked.running = true;
    if (tracked.healthcheck) {
      this.setHealthy(name, tracked, false);
      this.startLoop(name, tracked);
    } else if (tracked.tracked) {
      this.setHealthy(name, tracked, true);
    }
  }

  /**
   * The service's process exited: it is unhealthy and unready at once, and any hold on it is
   * cleared. It stays probed, from a fresh loop, only while something waits on it.
   */
  processExited(name: string): void {
    const tracked = this.entry(name);
    tracked.running = false;
    tracked.hold = 'none';
    this.stopLoop(tracked);
    this.setHealthy(name, tracked, false);
    if (this.probed(tracked)) {
      this.startLoop(name, tracked);
    }
  }

  /**
   * Whether the service can be reached: its last probe passed, or, tracked without a healthcheck,
   * its process runs. A hold doesn't change it.
   */
  isHealthy(name: string): boolean {
    return this.services.get(name)?.healthy ?? false;
  }

  /** Whether the service is ready: healthy, and not held by a start hook. */
  isReady(name: string): boolean {
    return this.services.get(name)?.ready ?? false;
  }

  /**
   * Holds the service's ready while its start hooks run: it may be healthy, but it isn't ready
   * until {@link releaseReady}. Put on before its process starts; an exit of the process clears
   * it.
   */
  holdReady(name: string): void {
    const tracked = this.entry(name);
    tracked.hold = 'held';
    this.update(name, tracked);
  }

  /**
   * Its start hooks have run: with `ok`, it is ready whenever it is healthy from now on; without,
   * one of them failed and it is never ready until its process exits and starts again.
   */
  releaseReady(name: string, ok: boolean): void {
    const tracked = this.entry(name);
    tracked.hold = ok ? 'none' : 'failed';
    this.update(name, tracked);
  }

  /**
   * Resolves once every one of `names` is ready at the same moment, at once when they already are;
   * rejects with the signal's reason when it aborts first. While it waits, each name is probed
   * whether its service runs or not.
   */
  whenReady(names: string[], signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason as Error);
    }
    if (names.every((name) => this.isReady(name))) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        this.off('ready', onReady);
        signal.removeEventListener('abort', onAbort);
        for (const name of names) {
          this.release(name);
        }
      };
      const onReady = () => {
        if (names.every((name) => this.isReady(name))) {
          done();
          resolve();
        }
      };
      const onAbort = () => {
        done();
        reject(signal.reason as Error);
      };
      this.on('ready', onReady);
      signal.addEventListener('abort', onAbort, { once: true });
      for (const name of names) {
        const tracked = this.entry(name);
        tracked.waiters++;
        if (this.probed(tracked) && !tracked.loop) {
          this.startLoop(name, tracked);
        }
      }
    });
  }

  private entry(name: string): Tracked {
    let tracked = this.services.get(name);
    if (!tracked) {
      tracked = {
        tracked: false,
        healthcheck: undefined,
        running: false,
        waiters: 0,
        healthy: false,
        hold: 'none',
        ready: false,
        loop: null,
        inFlight: null,
      };
      this.services.set(name, tracked);
    }
    return tracked;
  }

  private probed(tracked: Tracked): boolean {
    return tracked.healthcheck !== undefined && (tracked.running || tracked.waiters > 0);
  }

  /** One fewer waiter; when nothing probes it any more, it stops, unhealthy. */
  private release(name: string): void {
    const tracked = this.entry(name);
    tracked.waiters--;
    if (tracked.loop && !this.probed(tracked)) {
      this.stopLoop(tracked);
      this.setHealthy(name, tracked, false);
    }
  }

  /** Its health is now `healthy`: `healthy` is emitted on a flip, then its ready follows. */
  private setHealthy(name: string, tracked: Tracked, healthy: boolean): void {
    if (tracked.healthy !== healthy) {
      tracked.healthy = healthy;
      callEach(
        this.rawListeners('healthy') as ((name: string, healthy: boolean) => void)[],
        this,
        name,
        healthy,
      );
    }
    this.update(name, tracked);
  }

  /** Its ready is its health with no hold on it: `ready` or `unready` is emitted on a flip. */
  private update(name: string, tracked: Tracked): void {
    const ready = tracked.healthy && tracked.hold === 'none';
    if (tracked.ready === ready) {
      return;
    }
    tracked.ready = ready;
    callEach(
      this.rawListeners(ready ? 'ready' : 'unready') as ((name: string) => void)[],
      this,
      name,
    );
  }

  private stopLoop(tracked: Tracked): void {
    if (tracked.loop) {
      this.clock.clearTimeout(tracked.loop.timer);
      tracked.loop = null;
    }
  }

  private startLoop(name: string, tracked: Tracked): void {
    this.stopLoop(tracked);
    const loop: Loop = { probes: 0, timer: null };
    tracked.loop = loop;
    this.schedule(name, tracked, loop, this.startMs);
  }

  /** The gap before probe number `n + 1` starts, from when probe `n` started. */
  private gap(n: number): number {
    return Math.min(this.startMs * 2 ** n, this.capMs);
  }

  private schedule(name: string, tracked: Tracked, loop: Loop, delay: number): void {
    loop.timer = this.clock.setTimeout(() => this.run(name, tracked, loop), delay);
  }

  private run(name: string, tracked: Tracked, loop: Loop): void {
    if (tracked.loop !== loop) {
      return;
    }
    // A probe from an earlier loop still in flight: this one starts once it has settled.
    if (tracked.inFlight) {
      void tracked.inFlight.then(() => this.run(name, tracked, loop));
      return;
    }
    const startedAt = this.clock.now();
    loop.probes++;
    const probe = Promise.resolve()
      .then(() => this.probe(name))
      .catch(() => false);
    tracked.inFlight = probe;
    void probe.then((ok) => {
      tracked.inFlight = null;
      if (tracked.loop !== loop) {
        return;
      }
      this.setHealthy(name, tracked, ok);
      if (tracked.loop !== loop) {
        return;
      }
      const elapsed = this.clock.now() - startedAt;
      this.schedule(name, tracked, loop, Math.max(0, this.gap(loop.probes) - elapsed));
    });
  }
}
