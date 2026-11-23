import chalk from 'chalk';
import { logTimestamp } from '../format';
import { paintOfColor } from '../label-paint';
import type { ManyOutcome } from './many';
import type { ManyTarget } from './resolve';
import { tookFor } from './run';

// What the many form of `exec` and `run` prints: each line labelled as a `--headless` session
// prints its log, and a summary once every command has ended.

/**
 * A label's width in columns, taken as its length: a service's name or a path is narrow text.
 * (`string-width`, which measures a wide character right, is session-only.)
 */
const widthOf = (label: string) => label.length;

/**
 * `[name]`, padded with spaces to `width` and painted whole with the target's color, as
 * `labelGutter` (`session/log-layout.ts`) draws a session's; that module loads the line wrapping,
 * which a one-off command must not. A directory has no color, and stays unpainted.
 */
function gutterOf(target: ManyTarget, width: number): string {
  const text = `[${target.label}${' '.repeat(Math.max(0, width - widthOf(target.label)))}]`;
  const paint = target.color === undefined ? undefined : paintOfColor(target.color);
  return paint ? paint(text) : text;
}

/**
 * The many form's `onLine`: each line written whole, in one write, stdout's to `out.stdout` and
 * stderr's to `out.stderr`, as a `--headless` session prints its log: the date stamp, the label
 * padded to the widest of `targets`, then the line, never wrapped. `nested` (inside a command
 * stackctl runs, which stamps each line itself): no date stamp.
 */
export function createManyPrinter(
  targets: ManyTarget[],
  out: {
    stdout: { write(text: string): unknown };
    stderr: { write(text: string): unknown };
    nested: boolean;
  },
): (target: ManyTarget, stream: 'stdout' | 'stderr', line: string) => void {
  const width = Math.max(0, ...targets.map((t) => widthOf(t.label)));
  const gutters = new Map(targets.map((t) => [t, gutterOf(t, width)]));
  return (target, stream, line) => {
    const gutter = gutters.get(target) ?? gutterOf(target, width);
    const stamp = out.nested ? '' : `${chalk.dim(logTimestamp())} `;
    out[stream].write(`${stamp}${gutter} ${line}\n`);
  };
}

/** The order the summary counts statuses in. */
const STATUSES = ['ok', 'failed', 'stopped', 'skipped'] as const;

/**
 * The lines printed once every command has ended: the count of each status there is, then a
 * line per service with its status and what ended it, and how long it ran.
 */
export function manySummary(results: ManyOutcome[]): string[] {
  const counts = STATUSES.map(
    (status) => [status, results.filter((r) => r.status === status).length] as const,
  )
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${String(n)} ${status}`);
  const nameWidth = Math.max(0, ...results.map((r) => widthOf(r.service)));
  const statusWidth = Math.max(0, ...results.map((r) => r.status.length));
  const lines = results.map((r) => {
    const details: string[] = [];
    if (r.status === 'skipped') {
      details.push('no such script');
    } else if (r.error !== undefined) {
      details.push(r.error);
    } else {
      if (r.status === 'failed') {
        details.push(r.signal ?? `exit ${String(r.exitCode)}`);
      }
      details.push(tookFor(r.ms));
    }
    const name = r.service + ' '.repeat(nameWidth - widthOf(r.service));
    return `  ${name}  ${r.status.padEnd(statusWidth)}  ${details.join(', ')}`;
  });
  return [`stackctl: ${counts.join(', ')}`, ...lines];
}
