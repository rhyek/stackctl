import type { ManyTarget } from './resolve';
import { CommandStartError, FORWARDED_SIGNALS, type OneOffResult, runOneOff } from './run';

// The many form of `exec` and `run`: one command in each of several services at once, the first
// failure stopping the rest. Shared by the CLI and the SDK, which print it differently.

/** How one service's command ended. */
export type ManyStatus = 'ok' | 'failed' | 'stopped' | 'skipped';

/** One service's result. */
export interface ManyOutcome {
  /** The target's label: what the SDK's result calls `service`. */
  service: string;
  /**
   * `stopped`: stackctl stopped it (another one failed first, or this process was sent a
   * signal) while it ran, and it then ended with anything but exit `0`. `skipped`: no such script.
   */
  status: ManyStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Why it couldn't start. */
  error?: string;
  /** With `stdio: 'pipe'`. */
  stdout?: string;
  stderr?: string;
  /** How long it ran. Not part of the SDK's result. */
  ms: number;
}

/** Every service's result, in the order they were given. */
export interface ManyRun {
  /** No result is `failed` or `stopped`. */
  ok: boolean;
  results: ManyOutcome[];
  /** The signal this process was sent while they ran, which ended them. */
  interrupted?: NodeJS.Signals;
}

/**
 * Runs every target with a `spec` at once, each through `runOneOff`'s many form, and resolves
 * once all have ended, with a result per target in `targets`' order (`skipped` for one without a
 * `spec`). A failure is a non-zero exit, an end by a signal stackctl didn't send, or a command
 * that can't start (`failed`, with its `error`). Unless `ignoreSiblingError`, the first failure
 * stops the others. A SIGINT, SIGTERM or SIGHUP sent to this process while they run, which
 * `runOneOff` forwards to each, is no command's failure: it is `interrupted`. A command that a
 * stop or a forwarded signal reached while it ran, and that then ends with anything but exit
 * `0`, is `stopped`. Rejects, once every command has ended, with a throw that is no command's
 * doing: from `record`, from `onLine`, or a log that can't be written.
 */
export async function runMany(
  targets: ManyTarget[],
  opts: {
    stdio: 'inherit' | 'pipe';
    ignoreSiblingError: boolean;
    logDir: string;
    /** With `stdio: 'inherit'`: each output line. */
    onLine?: (target: ManyTarget, stream: 'stdout' | 'stderr', line: string) => void;
    /** Called as each command starts; its `end` as it ends. For the event log. */
    record?: (target: ManyTarget) => {
      end(result: { ok: boolean; exitCode: number | null; signal: NodeJS.Signals | null }): void;
    };
    /** From SIGTERM to SIGKILL, for a stop or a forwarded signal. Default: `runOneOff`'s. */
    graceMs?: number;
  },
): Promise<ManyRun> {
  const stop = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  // A signal `runOneOff` forwards to each command ends the run. One listener per signal, which
  // knows its own: a listener isn't always told which it was.
  const listeners = FORWARDED_SIGNALS.map((signal) => {
    const listener = () => {
      interrupted ??= signal;
    };
    process.on(signal, listener);
    return [signal, listener] as const;
  });
  // The first throw from `onLine`: it stops every command, and the run rejects with it.
  let lineError: { error: unknown } | undefined;

  const failed = () => {
    if (!opts.ignoreSiblingError) {
      stop.abort();
    }
  };

  const one = async (target: ManyTarget): Promise<ManyOutcome> => {
    const { spec } = target;
    const service = target.label;
    if (spec === null) {
      return { service, status: 'skipped', exitCode: null, signal: null, ms: 0 };
    }
    const { onLine } = opts;
    const entry = opts.record?.(target);
    const startedAt = Date.now();
    // Whether stackctl sent it a signal while it ran: what ends it then is no failure of its own.
    let stopSent = false;
    let result: OneOffResult;
    try {
      result = await runOneOff(spec, {
        stdio: opts.stdio,
        logDir: opts.logDir,
        many: {
          // With 'inherit' there is always one: without it the output would be copied through
          // whole, unlabelled. A throw from it is called back from a stream's data handler,
          // where it would be an uncaught exception: it is kept instead, and ends the run.
          ...(opts.stdio === 'inherit' && {
            onLine: (stream: 'stdout' | 'stderr', line: string) => {
              if (lineError !== undefined) {
                return;
              }
              try {
                onLine?.(target, stream, line);
              } catch (error) {
                lineError = { error };
                stop.abort();
              }
            },
          }),
          stop: stop.signal,
          ...(opts.graceMs !== undefined && { graceMs: opts.graceMs }),
          onStopSent: () => (stopSent = true),
        },
      });
    } catch (err) {
      entry?.end({ ok: false, exitCode: null, signal: null });
      if (!(err instanceof CommandStartError)) {
        throw err;
      }
      // It never ran, so no stop ended it: a failure whenever it comes.
      failed();
      return {
        service,
        status: 'failed',
        exitCode: null,
        signal: null,
        error: err.message,
        ms: Date.now() - startedAt,
      };
    }
    const ms = Date.now() - startedAt;
    const ok = result.exitCode === 0;
    entry?.end({ ok, exitCode: result.exitCode, signal: result.signal });
    let status: ManyStatus = 'ok';
    if (!ok) {
      status = stopSent ? 'stopped' : 'failed';
      if (status === 'failed') {
        failed();
      }
    }
    return { service, status, ...result, ms };
  };

  try {
    // A throw that is no command's doing (its log can't be written, `record` throws) stops the
    // others, and the run rejects with it once they have ended.
    const running = targets.map((target) =>
      one(target).catch((err: unknown) => {
        stop.abort();
        throw err;
      }),
    );
    const settled = await Promise.allSettled(running);
    const results: ManyOutcome[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
      results.push(outcome.value);
    }
    if (lineError !== undefined) {
      throw lineError.error;
    }
    return {
      ok: results.every((r) => r.status !== 'failed' && r.status !== 'stopped'),
      results,
      ...(interrupted !== undefined && { interrupted }),
    };
  } finally {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
  }
}
