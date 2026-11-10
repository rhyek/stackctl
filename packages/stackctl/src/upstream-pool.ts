import http from 'node:http';
import type { Socket } from 'node:net';

/**
 * The most pooled connections the proxy holds open to one upstream at a time. A burst of
 * requests beyond it waits for a free connection instead of dialling: a page load sends hundreds
 * of module requests at once (a dev server serves each file on its own), and macOS caps a
 * listener's queue of connections not yet accepted at 128 (`kern.ipc.somaxconn`), refusing or
 * resetting the rest. With `UPSTREAM_MAX_NEW_SOCKETS`, the proxy never has more than 96 connects
 * to one upstream in flight, leaving room for the upstream's other clients.
 */
export const UPSTREAM_MAX_SOCKETS = 64;
/**
 * The most unpooled connections (requests with a body, and retries) the proxy holds open to one
 * upstream at a time; more wait for one to close. A dev app rarely has more such requests in
 * flight at once.
 */
export const UPSTREAM_MAX_NEW_SOCKETS = 32;
/**
 * How long an idle pooled connection is kept: long enough to carry a page load's burst and the
 * next navigation, no longer. A connection the upstream closes while it sits idle leaves the pool
 * at once.
 */
export const UPSTREAM_IDLE_MS = 5_000;
/**
 * An upstream that announces its idle timeout (`Keep-Alive: timeout=5`, every Node server) has its
 * connections closed this long before it, when that comes sooner than `UPSTREAM_IDLE_MS`.
 */
export const UPSTREAM_CLOSE_EARLY_MS = 2_000;

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether `req` carries no body: a `GET`, `HEAD` or `OPTIONS` that doesn't say it has one. */
export function isBodyless(req: { method?: string; headers: http.IncomingHttpHeaders }): boolean {
  return (
    BODYLESS_METHODS.has(req.method ?? '') &&
    req.headers['transfer-encoding'] === undefined &&
    (req.headers['content-length'] ?? '0') === '0'
  );
}

export interface UpstreamHandlers {
  /** The upstream's response; called at most once. */
  onResponse(res: http.IncomingMessage): void;
  /**
   * The request failed. `reused` says whether its last attempt went out on a connection that had
   * carried a request before; a new connection reset before any response means nothing answered
   * on the port.
   */
  onError(err: NodeJS.ErrnoException, reused: boolean): void;
}

export interface UpstreamRequest {
  /** The attempt in flight, for writing a body into (bodyful requests only). */
  readonly body: http.ClientRequest;
  /** Abandons the request, whichever attempt is in flight. */
  destroy(): void;
}

export interface UpstreamPool {
  /**
   * Sends a request upstream. A bodyless request goes out on a pooled connection; if that
   * connection turns out to be one the upstream had just closed (reset, `ECONNRESET`, or `EPIPE`
   * when the reset came while the request was being written, either before any response), the
   * upstream never saw the request, and it is sent once more on a new connection, without the
   * caller hearing of it. A request with a body goes out on a connection outside the pool, never
   * one left idle, and is never sent twice; the caller ends it (or pipes into it) through `body`.
   * Those connections are capped (`UPSTREAM_MAX_NEW_SOCKETS`): past the cap, a request waits and
   * takes over the next one freed, the moment the previous response ends.
   */
  request(
    options: http.RequestOptions,
    bodyless: boolean,
    handlers: UpstreamHandlers,
  ): UpstreamRequest;
  /** Closes every pooled connection. */
  destroy(): void;
}

export function createUpstreamPool(): UpstreamPool {
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: UPSTREAM_MAX_SOCKETS,
    timeout: UPSTREAM_IDLE_MS,
    agentKeepAliveTimeoutBuffer: UPSTREAM_CLOSE_EARLY_MS,
  });
  // A connection it frees goes to the next request waiting for one, if any; otherwise it closes.
  const unpooled = new http.Agent({ keepAlive: false, maxSockets: UPSTREAM_MAX_NEW_SOCKETS });

  // Every connection that has carried a request. Node marks a request `reusedSocket` only when it
  // takes a connection left idle, not one handed straight to it by the request before.
  const used = new WeakSet<Socket>();

  return {
    request(options, bodyless, handlers) {
      let destroyed = false;
      const attempt = (pooled: boolean): http.ClientRequest => {
        const req = http.request({ ...options, agent: pooled ? agent : unpooled });
        let responded = false;
        let reused = false;
        req.on('socket', (socket) => {
          reused = used.has(socket);
          used.add(socket);
        });
        req.on('response', (res) => {
          responded = true;
          handlers.onResponse(res);
        });
        req.on('error', (err: NodeJS.ErrnoException) => {
          const lostRace =
            pooled && !responded && reused && (err.code === 'ECONNRESET' || err.code === 'EPIPE');
          if (lostRace && !destroyed) {
            // A new connection, not another pooled one: an upstream that restarts closes all its
            // idle connections at once.
            current = attempt(false);
            current.end();
          } else {
            handlers.onError(err, reused);
          }
        });
        return req;
      };
      let current = attempt(bodyless);
      if (bodyless) {
        current.end();
      }
      return {
        get body() {
          return current;
        },
        destroy() {
          destroyed = true;
          current.destroy();
        },
      };
    },
    destroy() {
      agent.destroy();
      unpooled.destroy();
    },
  };
}
