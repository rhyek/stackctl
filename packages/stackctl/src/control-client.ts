import type { ResolvedReverseProxyRoute } from './config';
import type { ServiceAction } from './control-server';
import { DEFAULT_PROFILE, type ProfileSource, isProfileSource } from './env-base';
import type { EventEnvelope, EventLine } from './event-log';
import type { InfraAction, InfraStatus } from './infra/control';
import type { ServiceCallbacks } from './lifecycle/service-types';
import type { ServiceName } from './register';
import type { InstanceInfo } from './running';
import {
  QUIT_REQUEST_TIMEOUT_MS,
  SERVICE_START_REQUEST_TIMEOUT_MS,
  SERVICE_STOP_REQUEST_TIMEOUT_MS,
} from './shutdown-timing';
import { readOwnVersion } from './skill';

/** An application service's status on `GET /query/status`. */
export type SessionServiceStatus = 'running' | 'stopped' | 'waiting' | 'restarting' | 'failed';

/**
 * Where the session's own `afterStart` and `afterReady` are: `none` when the config has neither;
 * `afterStart` or `afterReady`, the one still to finish (running, or `afterReady` waiting for the
 * session to be ready first); `done` once both have finished; `failed` once one threw.
 */
export type SessionStartHooks = 'none' | 'afterStart' | 'afterReady' | 'done' | 'failed';

/**
 * A snapshot of a live stackctl session, as returned by `GET /query/status`. `logFile`,
 * `pid`, and `configPath` are always present (even before the process manager attaches);
 * `services`, `infra` and `config` are `null` until it does.
 */
export interface SessionStatus<P extends string = ServiceName> {
  pid: number;
  /**
   * The session's id, when it started in ms (an older stackctl's was a UUID): the same one its
   * `profiles/<profile>/running.json` records, and the name of its folder.
   * Null from an instance older than 1.0.0.
   */
  sessionId: string | null;
  /** Absolute path to the `stackctl.config.*` the session was started with. */
  configPath: string;
  /** The profile the session runs in. */
  profile: string;
  /**
   * Where the session's profile came from: `--profile` (`flag`), `STACKCTL_PROFILE` (`env`), the
   * CI default (`ci`) or neither (`default`). Null from an instance that doesn't report one.
   */
  profileSource: ProfileSource | null;
  /**
   * Whether that session was started by a coding agent rather than by a person. Absent from
   * instances older than 0.7.0, which read as `false` — so a new session never auto-quits one
   * it can't ask about.
   */
  startedByAgent: boolean;
  /** Absolute path to the logfile currently being written (rotation-aware), or null. */
  logFile: string | null;
  /** Each application service's status, or null before the manager attaches. */
  services: Partial<Record<P, SessionServiceStatus>> | null;
  /**
   * Whether each service is ready: running, passing its healthcheck when it has one, and its
   * `afterStart` and `afterReady` hooks finished without failing. Same keys as `services`, and
   * null when it is.
   */
  ready: Partial<Record<P, boolean>> | null;
  /**
   * Why a service can't get ready because a start hook failed. For a `failed` service, the hook's
   * error: `afterStart failed: <message>` or `afterReady failed: <message>`. For a `stopped` one
   * that was never started because its `beforeStart` failed: `beforeStart failed: <message>`. For
   * a `waiting` one held by such a service it waits for, directly or through others that wait:
   * `waiting for api, which failed: <its error>. Run stackctl service restart -s api once it is
   * fixed; a change to stackctl.config.ts needs a new session` (`which failed to start: …` after
   * a `beforeStart`). Only those services are keys; null when `services` is.
   */
  errors: Partial<Record<P, string>> | null;
  /**
   * The `lifecycle` hook each service runs now: `beforeStart`, `afterStart` or `afterReady` of a
   * start, or the `beforeStop` or `afterStop` a stop still runs. A stop of the service abandons
   * whichever it is. Only those services are keys; null when `services` is.
   */
  serviceHooks: Partial<Record<P, keyof ServiceCallbacks>> | null;
  /**
   * Each infra service's live state, or the action under way on it; null for a config without
   * infra, and before the manager attaches.
   */
  infra: Record<string, InfraStatus> | null;
  /**
   * Whether the session is ready as a whole: every infra service running, every service that
   * isn't stopped running and ready (so none `failed`), and the session's own `afterStart` and
   * `afterReady` finished. False before the manager attaches.
   */
  sessionReady: boolean;
  /**
   * Why the session's start failed after its services were started: its `afterStart` or
   * `afterReady` threw (`session afterReady failed: <message>`), or another step of its start
   * failed after that. Null otherwise, and before the manager attaches.
   */
  sessionError: string | null;
  /**
   * Where the session's own `afterStart` and `afterReady` are (see {@link SessionStartHooks}).
   * `none` before the manager attaches, and from an older session, which reports none.
   */
  sessionStartHooks: SessionStartHooks;
  /** The resolved config, or null before the manager attaches. */
  config: unknown;
  /**
   * The session's dev reverse proxy — its port, the domains it routes under (canonical first:
   * `reverseProxy.publicAddress.domain`), and its `routes` as the config resolves them (each
   * `subdomain` a list, `paths` in its order; a name is an application or an infra service) — or
   * null when the config declares none.
   */
  reverseProxy: {
    port: number;
    domain: string;
    domains: string[];
    routes: ResolvedReverseProxyRoute[];
  } | null;
}

/**
 * A line of `GET /events`, each one JSON object with a `type`: first `snapshot`, the same as
 * `GET /query/status`; then every line of the session's event log as it is written (an
 * {@link EventLine}: a state change, a command, the session's own lifecycle), by the session or
 * by another stackctl process; and a `heartbeat` every {@link EVENTS_HEARTBEAT_MS} whatever else
 * happens, with the session's clock in ms. A client that switches on `type` ignores the ones it
 * doesn't know.
 */
export type SessionEvent<P extends string = ServiceName> =
  | ({ type: 'snapshot' } & SessionStatus<P>)
  | { type: 'heartbeat'; at: number }
  | (Omit<Extract<EventLine, { type: 'service-state' }>, 'service'> & { service: P })
  | Exclude<EventLine, { type: 'service-state' }>;

export type { EventEnvelope };

/**
 * What stackctl's own client says it is, so the event log can tell a stackctl command's request
 * (`stackctl service restart`, `stop`, a takeover) from `curl`'s.
 */
const CLIENT_HEADERS = { 'user-agent': `stackctl/${readOwnVersion()}` };

/** How often `GET /events` sends a heartbeat. */
export const EVENTS_HEARTBEAT_MS = 5000;

/** How long {@link ControlClient.events} waits for a line before it calls the session frozen. */
const EVENTS_IDLE_TIMEOUT_MS = 3 * EVENTS_HEARTBEAT_MS;

/**
 * A thin HTTP client for a running instance's localhost control API, its methods named after
 * the endpoint paths: `query.status()` is `GET /query/status`, `command.service.restart(name)`
 * is `POST /command/service/restart/<name>`. Bind one with {@link createControlClient} (bound to
 * an explicit port), or `find-session.ts`'s helpers (which first check the session is the one its
 * record names). Reusable by any feature that needs to query or drive a session.
 */
export interface ControlClient<P extends string = ServiceName> {
  readonly port: number;
  readonly query: {
    /** `GET /query/status` — full session snapshot, or null if the instance didn't answer with a valid one. */
    status(): Promise<SessionStatus<P> | null>;
  };
  /**
   * `GET /events`: the session's snapshot, then every change, as they happen. Ends when the
   * session ends the stream (it is shutting down) or `signal` aborts; throws when the session
   * can't be reached, or sends nothing, not even a heartbeat, for `idleTimeoutMs` (default 15 s):
   * a session whose loop has stopped keeps its connection open, and says nothing.
   */
  events(opts?: { signal?: AbortSignal; idleTimeoutMs?: number }): AsyncGenerator<SessionEvent<P>>;
  readonly command: {
    /**
     * `POST /command/service/<action>/<name>`, one method per action — true if the instance
     * accepted it. False for a service the session doesn't have, and for a `start` or `stop` while
     * a restart of it is under way.
     */
    readonly service: {
      /**
       * Starts a stopped service, resolving once it has started (a start asked for while a stop
       * of it still runs its hooks waits for them). True when it already runs; false while it
       * waits for its deps, and when no answer came in time. With `signal`, the wait for the
       * answer ends when it aborts, not after the default 5 minutes.
       */
      start(name: P, opts?: ServiceRequestOptions): Promise<boolean>;
      /**
       * Stops a service, resolving once its process has exited and its `beforeStop` and
       * `afterStop` have finished. True when it is already stopped; false when no answer came in
       * time, though the stop goes on: by default 12 seconds, which a slow stop hook outlasts.
       * With `signal`, the wait for the answer ends only when it aborts.
       */
      stop(name: P, opts?: ServiceRequestOptions): Promise<boolean>;
      /** Restarts a service (and starts a stopped one). Runs on in the background. */
      restart(name: P): Promise<boolean>;
    };
    /**
     * `POST /command/infra/<action>/<service>`, one method per action — true if the instance
     * accepted it. False for a service the session doesn't have, and while another action on
     * that service is under way. The action runs in the background: watch `infra` on
     * `query.status()` for where it ends.
     */
    readonly infra: {
      /** Starts a stopped service. */
      start(service: string): Promise<boolean>;
      /** Stops a service, keeping its data. */
      stop(service: string): Promise<boolean>;
      /** Recreates the service's container, keeping its data, as `infra restart` does. */
      restart(service: string): Promise<boolean>;
      /** Removes the service and its data, then starts it clean, as `infra reset` does. */
      reset(service: string): Promise<boolean>;
    };
    /**
     * `POST /command/quit` — graceful shutdown. The target **blocks** the response until its
     * services are torn down (ports freed), so this resolves only once that's done (or the
     * request times out / the target vanishes). Returns `true` if the target acked `ok`.
     */
    quit(): Promise<boolean>;
  };
}

/** How long a `command.service` request waits for the session's answer. */
export interface ServiceRequestOptions {
  /** Ends the wait for the answer when it aborts, in place of the request's default timeout. */
  signal?: AbortSignal;
}

/** Builds a control client bound to `port`, with no liveness check (fits probing arbitrary candidates). */
export function createControlClient<P extends string = string>(
  port: number,
  timeoutMs = 500,
): ControlClient<P> {
  const base = `http://127.0.0.1:${port}`;
  const post = async (path: string, until: number | AbortSignal = timeoutMs): Promise<boolean> => {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: CLIENT_HEADERS,
        signal: typeof until === 'number' ? AbortSignal.timeout(until) : until,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      return res.ok && body.ok === true;
    } catch {
      return false;
    }
  };
  const serviceAction = (action: ServiceAction, name: string, until?: number | AbortSignal) =>
    post(`/command/service/${action}/${encodeURIComponent(name)}`, until);
  const infraAction = (action: InfraAction) => (service: string) =>
    post(`/command/infra/${action}/${encodeURIComponent(service)}`);
  return {
    port,
    query: { status: queryStatus },
    events,
    command: {
      service: {
        // Adding a service to the session can take a while.
        start: (name, opts) =>
          serviceAction('start', name, opts?.signal ?? SERVICE_START_REQUEST_TIMEOUT_MS),
        // The target answers once the process has exited, which can take its whole grace period,
        // and its stop hooks have finished.
        stop: (name, opts) =>
          serviceAction('stop', name, opts?.signal ?? SERVICE_STOP_REQUEST_TIMEOUT_MS),
        restart: (name) => serviceAction('restart', name),
      },
      infra: {
        start: infraAction('start'),
        stop: infraAction('stop'),
        restart: infraAction('restart'),
        reset: infraAction('reset'),
      },
      quit,
    },
  };

  async function queryStatus(): Promise<SessionStatus<P> | null> {
    try {
      const res = await fetch(`${base}/query/status`, {
        headers: CLIENT_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        return null;
      }
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.pid !== 'number' || typeof body.configPath !== 'string') {
        return null;
      }
      return {
        pid: body.pid,
        configPath: body.configPath,
        profile: typeof body.profile === 'string' ? body.profile : DEFAULT_PROFILE,
        profileSource: isProfileSource(body.profileSource) ? body.profileSource : null,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
        startedByAgent: body.startedByAgent === true,
        logFile: typeof body.logFile === 'string' ? body.logFile : null,
        services: (body.services ?? null) as SessionStatus<P>['services'],
        ready: (body.ready ?? null) as SessionStatus<P>['ready'],
        // An older instance reports none: `{}` once it has services.
        errors: (body.errors ?? (body.services ? {} : null)) as SessionStatus<P>['errors'],
        serviceHooks: (body.serviceHooks ?? (body.services ? {} : null)) as SessionStatus<P>['serviceHooks'], // oxfmt-ignore
        infra: (body.infra ?? null) as SessionStatus<P>['infra'],
        sessionReady: body.sessionReady === true,
        sessionError: typeof body.sessionError === 'string' ? body.sessionError : null,
        sessionStartHooks: isSessionStartHooks(body.sessionStartHooks) ? body.sessionStartHooks : 'none', // oxfmt-ignore
        config: body.config ?? null,
        reverseProxy: (body.reverseProxy ?? null) as SessionStatus<P>['reverseProxy'],
      };
    } catch {
      return null;
    }
  }

  async function* events(
    opts: { signal?: AbortSignal; idleTimeoutMs?: number } = {},
  ): AsyncGenerator<SessionEvent<P>> {
    const idleMs = opts.idleTimeoutMs ?? EVENTS_IDLE_TIMEOUT_MS;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (opts.signal?.aborted) {
      return;
    }
    opts.signal?.addEventListener('abort', cancel, { once: true });
    let idleFired = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        idleFired = true;
        controller.abort();
      }, idleMs);
    };
    try {
      arm();
      const res = await fetch(`${base}/events`, {
        headers: CLIENT_HEADERS,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`GET /events on port ${String(port)} answered ${String(res.status)}`);
      }
      const decoder = new TextDecoder();
      let pending = '';
      for await (const chunk of res.body) {
        arm();
        pending += decoder.decode(chunk as Uint8Array, { stream: true });
        for (let nl = pending.indexOf('\n'); nl !== -1; nl = pending.indexOf('\n')) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (line) {
            yield JSON.parse(line) as SessionEvent<P>;
          }
        }
      }
    } catch (error) {
      if (idleFired) {
        throw new Error(
          `the session on port ${String(port)} sent nothing for ${String(idleMs / 1000)}s: it looks frozen`,
          { cause: error },
        );
      }
      if (opts.signal?.aborted) {
        return;
      }
      throw error;
    } finally {
      clearTimeout(idle);
      opts.signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }

  async function quit(): Promise<boolean> {
    try {
      // The target holds this response open until its services are down, so this
      // request can take much longer than a probe — use the blocking-quit timeout,
      // not the short default. Returns true only on an explicit `ok` ack.
      const res = await fetch(`${base}/command/quit`, {
        method: 'POST',
        headers: CLIENT_HEADERS,
        signal: AbortSignal.timeout(QUIT_REQUEST_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      return res.ok && body.ok === true;
    } catch {
      return false; // timed out, or the target hard-exited before acking
    }
  }
}

/**
 * Queries a port's `/query/status` and reduces it to the {@link InstanceInfo} identity used
 * by the port-handoff protocol; null if it isn't a stackctl instance.
 */
export async function probeInstance(port: number, timeoutMs = 500): Promise<InstanceInfo | null> {
  const status = await createControlClient(port, timeoutMs).query.status();
  return status
    ? { pid: status.pid, configPath: status.configPath, profile: status.profile }
    : null;
}

const SESSION_START_HOOKS: readonly string[] = [
  'none',
  'afterStart',
  'afterReady',
  'done',
  'failed',
];

/** Whether `value` is a {@link SessionStartHooks}. */
export function isSessionStartHooks(value: unknown): value is SessionStartHooks {
  return typeof value === 'string' && SESSION_START_HOOKS.includes(value);
}
