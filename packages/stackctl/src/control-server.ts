import http from 'node:http';
import { startedByAgent } from './agent-detection.js';
import {
  EVENTS_HEARTBEAT_MS,
  type SessionEvent,
  type SessionServiceStatus,
} from './control-client.js';
import type { DevReverseProxyServer } from './dev-reverse-proxy.js';
import { currentMode, currentModeSource } from './env-base.js';
import { EventTail, fileSize, type EventBy, type EventLog, type StateEntry } from './event-log.js';
import {
  INFRA_ACTIONS,
  type InfraAction,
  type InfraRunOutcome,
  type InfraStatus,
} from './infra/control.js';
import { sessionId } from './running.js';

/** What `POST /command/service/<action>/<name>` can do to an application service. */
export type ServiceAction = 'start' | 'stop' | 'restart';

export const SERVICE_ACTIONS: readonly ServiceAction[] = ['start', 'stop', 'restart'];

/** How often an open `/events` stream reads the event log for lines other processes wrote. */
const EVENTS_POLL_MS = 250;

/** What a request's path is parsed against: any fixed origin will do, only the path is read. */
const REQUEST_URL_BASE = 'http://localhost';

/**
 * How a service action went: `done` (a start or stop, finished), `accepted` (a restart,
 * under way), `unknown` (no such service in the session), `busy` (a restart is under way),
 * `waiting` (a start or restart of a service waiting for its deps), `unavailable` (a start with
 * no dev command),
 * `closing` (a start of a service not in the session, while the session is shutting down).
 */
export type ServiceRunOutcome =
  | 'done'
  | 'accepted'
  | 'unknown'
  | 'busy'
  | 'waiting'
  | 'unavailable'
  | 'closing';

export interface ControlManager {
  serviceStatuses(): unknown;
  /** Whether each service is running and passing its healthcheck (see `/query/status` `ready`). */
  getAllReadiness(): Record<string, boolean>;
  /** The whole resolved config (defaults applied), included in `/query/status` once attached. */
  getConfig(): unknown;
  /** Absolute path to the logfile currently being written (rotation-aware). */
  getLogFile(): string;
  /**
   * Runs an action on an application service, for `by`; a `stop` resolves once its process has
   * exited.
   */
  runPackage(pkg: string, action: ServiceAction, by: EventBy): Promise<ServiceRunOutcome>;
  /** Every infra service's status, or `null` for a session without infra. */
  getInfraStatuses(): Record<string, InfraStatus> | null;
  /**
   * Calls `fn` whenever the statuses, readiness or infra states may have changed (`/events`
   * compares, so a call with nothing changed costs nothing). Returns the unsubscribe.
   */
  subscribeState(fn: () => void): () => void;
  /** Starts an action on an infra service, for `by`; returns at once (see `InfraControl.run`). */
  runInfra(service: string, action: InfraAction, by: EventBy): InfraRunOutcome;
  quit(): void;
  /**
   * Emit a `[control]` log line noting a mutating command arrived over the control API (as
   * opposed to the same action triggered by a UI hotkey). `attrs` carries the variables the
   * command was called with (e.g. `{ service: 'web' }`), rendered as indented properties; an
   * `attrs.service` naming a known service also scopes the line to it for output filtering.
   */
  logControl(command: string, attrs?: Record<string, unknown>): void;
}

export async function startControlServer(opts: {
  /** Called for `POST /command/quit`, with who asked. */
  quitHandler: (by: EventBy) => void;
  port: number;
  /**
   * The session's event log: the server writes the session's state changes to it, and `/events`
   * streams its lines, whoever wrote them.
   */
  events: EventLog;
  /** Absolute path to the config this session started with; surfaced on `/query/status` for handoff. */
  configPath?: string;
  /**
   * This session's initial logfile, surfaced on `/query/status` before the process manager
   * attaches. Once attached, the manager's rotation-aware `getLogFile()` supersedes it.
   */
  logFile?: string;
  /**
   * The session's dev reverse proxy, if the config declares one — surfaced on `/query/status`
   * so a client can learn the public hostnames without parsing the config.
   */
  reverseProxy?: Pick<DevReverseProxyServer, 'port' | 'domain' | 'domains' | 'routes'> | null;
}): Promise<{
  bindSession(m: ControlManager): void;
  /**
   * Swaps the handler invoked by `/command/quit`. The server is typically created
   * before the process manager exists (so it can be reached mid-build), then a
   * later phase that owns graceful shutdown takes over quit-routing by calling
   * this — without it, a quit request during that phase would still hit the
   * original (e.g. hard-exit) handler it was constructed with.
   */
  setQuitHandler(fn: (by: EventBy) => void): void;
  /**
   * Send `200 { ok: true }` to any `POST /command/quit` request currently being
   * held open (see the handler), releasing a blocked caller. The graceful
   * shutdown path calls this once services are torn down; a no-op when nothing
   * is waiting (e.g. a Ctrl+C quit, which never went through the HTTP handler).
   */
  ackQuit(): void;
  /** Sends every open `/events` stream the event log's lines it hasn't sent yet. */
  flush(): void;
  close(): Promise<void>;
  port: number;
}> {
  let manager: ControlManager | null = null;
  let quitHandler = opts.quitHandler;
  /** Answers with `body` as JSON. */
  const send = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  // `POST /command/quit` responses held open until the graceful shutdown path
  // acks them (see the handler and ackQuit). Usually 0 or 1 entry.
  let pendingQuits: http.ServerResponse[] = [];
  const flushQuits = () => {
    const held = pendingQuits;
    pendingQuits = [];
    for (const res of held) {
      try {
        send(res, 200, { ok: true });
      } catch {
        /* socket already gone */
      }
    }
  };

  // `GET /events` responses: each gets the snapshot, then every line the event log gets.
  const streams = new Set<http.ServerResponse>();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let trackScheduled = false;
  /** What the event log was last told of the session's state; `null` before the session binds. */
  let logged: LiveState | null = null;
  const tail = new EventTail(opts.events.file, fileSize(opts.events.file));

  const liveState = (): LiveState => {
    const services = manager ? (manager.serviceStatuses() as Record<string, string>) : null;
    const ready = manager ? manager.getAllReadiness() : null;
    const infra = manager ? manager.getInfraStatuses() : null;
    return { services, ready, infra, sessionReady: isSessionReady(services, ready, infra) };
  };
  const statusBody = () => ({
    pid: process.pid,
    sessionId: sessionId(),
    configPath: opts.configPath ?? null,
    mode: currentMode(),
    modeSource: currentModeSource(),
    startedByAgent: startedByAgent(),
    logFile: manager ? manager.getLogFile() : (opts.logFile ?? null),
    ...liveState(),
    config: manager ? manager.getConfig() : null,
    reverseProxy: opts.reverseProxy
      ? {
          port: opts.reverseProxy.port,
          domain: opts.reverseProxy.domain,
          domains: opts.reverseProxy.domains,
          // As `reverseProxy.routes` resolves it: `subdomain` a list, `paths` in its order.
          routes: opts.reverseProxy.routes,
        }
      : null,
  });
  const writeEvent = (res: http.ServerResponse, event: SessionEvent) => {
    res.write(`${JSON.stringify(event)}\n`);
  };
  /** The event log's lines since the last call, to every open stream, as they are in the file. */
  const flush = () => {
    const lines = tail.read();
    for (const res of streams) {
      for (const line of lines) {
        res.write(`${line}\n`);
      }
    }
  };
  // Changes come in bursts (every logged line is one): one comparison per turn of the loop, and
  // one line per change for the event log, whether a client listens or not.
  const scheduleTrack = () => {
    if (trackScheduled || !manager) {
      return;
    }
    trackScheduled = true;
    setImmediate(() => {
      trackScheduled = false;
      const next = liveState();
      const changes = stateChanges(logged, next);
      logged = next;
      for (const change of changes) {
        opts.events.write(change);
      }
    });
  };
  const stopWritten = opts.events.onWrite(flush);
  const openStream = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    // What came before the snapshot goes to the streams already open; this one starts here.
    flush();
    streams.add(res);
    writeEvent(res, { type: 'snapshot', ...statusBody() } as SessionEvent);
    heartbeat ??= setInterval(() => {
      for (const open of streams) {
        writeEvent(open, { type: 'heartbeat', at: Date.now() });
      }
    }, EVENTS_HEARTBEAT_MS).unref();
    // Other processes' lines (a CLI's `infra restart`), read when this one writes and in between.
    poll ??= setInterval(flush, EVENTS_POLL_MS).unref();
    req.on('close', () => {
      streams.delete(res);
      if (streams.size === 0) {
        stopTimers();
      }
    });
  };
  const stopTimers = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
  };
  const endStreams = () => {
    flush();
    for (const res of streams) {
      res.end();
    }
    streams.clear();
    stopTimers();
  };

  // Localhost-only convenience API: HTTP methods are intentionally not enforced.
  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    // Only the path is read, so the request's own `Host` never takes part in parsing it.
    const { pathname: requested } = new URL(req.url ?? '/', REQUEST_URL_BASE);
    const pathname = requested.replace(/\/+$/, '') || '/';
    const parts = pathname.split('/').filter(Boolean);
    // The single consolidated query endpoint. `pid`/`configPath`/`logFile`/`startedByAgent`
    // are available even before the process manager attaches (from the server's own opts, or
    // from this process's own environment); `services`/`config` — and the rotation-aware
    // `logFile` — come from the manager once it does.
    if (pathname === '/query/status') {
      return send(res, 200, statusBody());
    }
    // A long-lived stream of JSON lines: the snapshot, then each change, and a heartbeat.
    if (pathname === '/events') {
      return openStream(req, res);
    }
    /** Who asked: this request, by its path and its client. */
    const by: EventBy = {
      kind: 'control-api',
      request: `${req.method ?? 'GET'} ${pathname}`,
      userAgent: req.headers['user-agent'] ?? null,
    };
    if (pathname === '/command/quit') {
      manager?.logControl('quit');
      // Blocking quit: hold the response open and let the graceful shutdown path
      // ack it (via ackQuit) once services are torn down and their ports freed —
      // so a caller (notably a newer session handing off) knows the ports are
      // clear before it starts. `Connection: close` lets close() reclaim the
      // socket the moment we finally respond. A shutdown that hard-exits before
      // acking (e.g. no manager attached yet) just drops the held request; the
      // caller falls back to polling this pid.
      res.setHeader('Connection', 'close');
      pendingQuits.push(res);
      return quitHandler(by);
    }
    if (pathname === '/') {
      return send(res, 200, { ok: true, pid: process.pid, attached: Boolean(manager) });
    }

    if (!manager) {
      return send(res, 503, { error: 'manager not attached' });
    }

    // `/command/service/<action>/<name>`: a restart is accepted at once and runs on;
    // a start or stop answers once it's done, so a caller that stops a service knows its process
    // has exited.
    if (parts[0] === 'command' && parts[1] === 'service' && parts[2] && parts[3]) {
      const action = parts[2] as ServiceAction;
      const name = parts[3];
      if (!SERVICE_ACTIONS.includes(action)) {
        return send(res, 404, { ok: false, error: `unknown service action "${parts[2]}"` });
      }
      manager.logControl(action, { service: name });
      void manager.runPackage(name, action, by).then(
        (outcome) => {
          switch (outcome) {
            case 'done':
              return send(res, 200, { ok: true });
            case 'accepted':
              return send(res, 202, { ok: true });
            case 'busy':
              return send(res, 409, {
                ok: false,
                error: `service "${name}" is restarting`,
              });
            case 'waiting':
              return send(res, 409, {
                ok: false,
                error: `service "${name}" is waiting for its dependencies`,
              });
            case 'unavailable':
              return send(res, 409, {
                ok: false,
                error: `service "${name}" has no dev command`,
              });
            case 'closing':
              return send(res, 503, {
                ok: false,
                error: `service "${name}" could not be added: the session is shutting down`,
              });
            case 'unknown':
              return send(res, 404, { ok: false, error: `no service "${name}" in this session` });
          }
        },
        (err: unknown) =>
          send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return;
    }
    // `/command/infra/<action>/<service>`: accepted at once, like a service restart — the
    // service's status on `/query/status` shows the action under way, then where it ended.
    if (parts[0] === 'command' && parts[1] === 'infra' && parts[2] && parts[3]) {
      const action = parts[2] as InfraAction;
      if (!INFRA_ACTIONS.includes(action)) {
        return send(res, 404, { error: `unknown infra action "${parts[2]}"` });
      }
      manager.logControl(`infra ${action}`, { infraService: parts[3] });
      const outcome = manager.runInfra(parts[3], action, by);
      return outcome === 'accepted'
        ? send(res, 202, { ok: true })
        : outcome === 'busy'
          ? send(res, 409, { ok: false, error: `infra service "${parts[3]}" is busy` })
          : send(res, 404, { ok: false, error: `no infra service "${parts[3]}" in this session` });
    }
    send(res, 404, { error: 'not found' });
  };
  const server = http.createServer(handleRequest);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', resolve);
  });
  const actualPort = (server.address() as { port: number }).port;

  return {
    bindSession: (m) => {
      manager = m;
      unsubscribe = m.subscribeState(scheduleTrack);
      scheduleTrack();
    },
    setQuitHandler: (fn) => {
      quitHandler = fn;
    },
    ackQuit: flushQuits,
    flush,
    close: () => {
      // Answer any still-held quit request before closing, so server.close()
      // never blocks waiting on an un-responded socket.
      flushQuits();
      // An open `/events` stream would hold `server.close()` for as long as its client listens.
      endStreams();
      stopWritten();
      unsubscribe?.();
      unsubscribe = null;
      const stopped = new Promise<void>((settle) => {
        // Called back once the server has stopped, or at once (with an error) if it already had.
        server.close(() => {
          settle();
        });
      });
      server.closeAllConnections();
      return stopped;
    },
    port: actualPort,
  };
}

/** What `/events` compares between one change and the next. */
interface LiveState {
  services: Record<string, string> | null;
  ready: Record<string, boolean> | null;
  infra: Record<string, InfraStatus> | null;
  sessionReady: boolean;
}

/**
 * Whether a session is ready as a whole: attached, every infra service running, and every service
 * that isn't stopped ready.
 */
function isSessionReady(
  services: Record<string, string> | null,
  ready: Record<string, boolean> | null,
  infra: Record<string, InfraStatus> | null,
): boolean {
  if (!services) {
    return false;
  }
  if (infra && Object.values(infra).some((state) => state !== 'running')) {
    return false;
  }
  return Object.entries(services).every(
    ([name, status]) => status === 'stopped' || ready?.[name] === true,
  );
}

/**
 * The state lines that take the event log from `prev` (`null`: nothing written yet) to `next`, each
 * with what it was. The first call writes every service and infra service as it is.
 */
function stateChanges(prev: LiveState | null, next: LiveState): StateEntry[] {
  const entries: StateEntry[] = [];
  for (const [service, status] of Object.entries(next.services ?? {})) {
    const ready = next.ready?.[service] === true;
    const previousStatus = (prev?.services?.[service] ?? null) as SessionServiceStatus | null;
    const previousReady = prev?.services?.[service] === undefined ? null : prev.ready?.[service] === true; // oxfmt-ignore
    if (previousStatus !== status || previousReady !== ready) {
      entries.push({ type: 'service-state', service, status: status as SessionServiceStatus, ready, previousStatus, previousReady }); // oxfmt-ignore
    }
  }
  for (const [service, status] of Object.entries(next.infra ?? {})) {
    const previousStatus = prev?.infra?.[service] ?? null;
    if (previousStatus !== status) {
      entries.push({ type: 'infra-state', service, status, previousStatus });
    }
  }
  if ((prev?.sessionReady ?? false) !== next.sessionReady) {
    entries.push({ type: 'session-state', ready: next.sessionReady });
  }
  return entries;
}
