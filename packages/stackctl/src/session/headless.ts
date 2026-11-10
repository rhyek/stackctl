import { currentMode } from '../env-base.js';
import { createInfraReporter } from '../infra/report.js';
import type { LogStore } from './log-store.js';
import type { Session } from './session.js';

/** Where a headless session prints. `columns` and `isTTY` are read when stdout is a terminal. */
interface Output {
  write(text: string, done?: () => void): unknown;
  columns?: number;
  isTTY?: boolean;
}

/** The width a line is wrapped to when stdout isn't a terminal. */
export const PIPED_COLUMNS = 120;

export interface HeadlessPrinter {
  /** Prints every log line appended since the last one printed. */
  flush(): void;
  /** Prints a line of its own on stdout, after every log line appended before it. */
  write(line: string): void;
  dispose(): void;
}

/**
 * Prints a session's log as it is appended: each line's rows in `date` mode at stdout's width
 * (120 piped), one write per line, error lines on stderr. With `echo` off only stackctl's own
 * `[stackctl]` lines are printed (the takeover's messages, a startup failure); everything else is
 * in the logfile.
 */
export function createHeadlessPrinter(opts: {
  logs: LogStore;
  echo: boolean;
  stdout?: Output;
  stderr?: Output;
}): HeadlessPrinter {
  const { logs, echo } = opts;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  // The id of the next line to print. Headless sets no filter, so the visible lines are the buffer.
  let next = 0;
  const flush = () => {
    const lines = logs.getVisibleLines();
    const first = lines[0]?.id ?? next;
    const cols = stdout.isTTY && stdout.columns ? stdout.columns : PIPED_COLUMNS;
    for (let i = Math.max(0, next - first); i < lines.length; i++) {
      const line = lines[i]!;
      next = line.id + 1;
      if (!echo && line.filterKey !== 'system') {
        continue;
      }
      const rows = logs.wrapLineRows(line, cols, 'date').map((row) => row.text);
      (line.isError ? stderr : stdout).write(`${rows.join('\n')}\n`);
    }
  };
  const unsubscribe = logs.subscribe(flush);
  return {
    flush,
    write(line) {
      flush();
      stdout.write(`${line}\n`);
    },
    dispose() {
      unsubscribe();
      flush();
    },
  };
}

/** Resolves once everything written to `stream` so far has been handed to the OS. */
function drain(stream: Output): Promise<void> {
  return new Promise((resolve) => {
    try {
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Runs a session headless: starts it, prints its log as it goes and infra's progress lines, and
 * exits when it has shut down — 0 after a graceful shutdown, 1 after a second request or a failed
 * startup, which it prints and then shuts the session down for.
 */
export async function runHeadless(
  session: Session,
  opts: {
    echo: boolean;
    exit?: (code: number) => void;
    stdout?: Output;
    stderr?: Output;
  },
): Promise<void> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const printer = createHeadlessPrinter({ logs: session.logs, echo: opts.echo, stdout, stderr });
  // infra/report.ts's status lines, untimestamped, printed in order with the log's lines; infra's
  // output lines are in the log.
  const reporter = createInfraReporter({
    mode: currentMode(),
    write: (line) => printer.write(line),
  });
  const unsubscribe = session.subscribeInfra((progress) => {
    if (progress.type === 'finished') {
      reporter.finish(progress.summary, 'up');
    } else {
      reporter.onEvent(progress);
    }
  });
  void session.start().then(() => {
    if (session.getSnapshot().phase === 'failed') {
      void session.shutdown('startup-failed');
    }
  });
  const code = await session.closed;
  unsubscribe();
  printer.dispose();
  await drain(stdout);
  await drain(stderr);
  const exit = opts.exit ?? ((c: number) => process.exit(c));
  exit(code);
}
