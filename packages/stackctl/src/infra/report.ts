import chalk from 'chalk';
import type { InfraEvent, InfraRunSummary } from './types.js';

export interface InfraReporter {
  onEvent: (event: InfraEvent) => void;
  /** Prints the closing line for a run. */
  finish: (summary: InfraRunSummary, action: 'up' | 'destroy') => void;
}

/**
 * Renders a run's events as plain lines — one per service that reaches a final status, plus
 * whatever the callbacks and the provider's tool print. The same on a TTY and off one: no
 * spinner, nothing rewritten in place, so it reads the same in a terminal, a CI log and a pipe.
 * Used by the `infra` commands and by `--headless`.
 */
export function createInfraReporter(opts: {
  profile: string;
  write?: (line: string) => void;
  now?: () => number;
}): InfraReporter {
  const write = opts.write ?? ((line: string) => console.log(line));
  const now = opts.now ?? Date.now;
  let startedAt = now();
  let width = 0;
  const elapsed = () => `${((now() - startedAt) / 1000).toFixed(1)}s`;

  return {
    onEvent(event) {
      if (event.type === 'targets') {
        startedAt = now();
        width = Math.max(width, ...event.services.map((s) => s.length));
        const what = event.action === 'destroy' ? 'infra destroy' : 'infra';
        write(
          `${chalk.blue('▶')} ${what} ${chalk.dim(`(${opts.profile})`)}: ${event.services.join(', ') || chalk.dim('no services')}`,
        );
        return;
      }
      if (event.type === 'output') {
        if (event.service === undefined) {
          // The provider's own progress (containers created, images pulled): there for when
          // something is slow or goes wrong, and dimmed so it reads as background.
          write(chalk.dim(`[infra] ${event.line}`));
          return;
        }
        const prefix = chalk.dim(`[${event.service}]`);
        write(`${prefix} ${event.isError ? chalk.red(event.line) : event.line}`);
        return;
      }
      const name = event.service.padEnd(width);
      if (event.status === 'ready') {
        write(`  ${name}  ${chalk.green('ready')} ${chalk.dim(`(${elapsed()})`)}`);
      } else if (event.status === 'destroyed') {
        write(`  ${name}  ${chalk.green('destroyed')}`);
      } else if (event.status === 'failed') {
        const [first = '', ...rest] = (event.detail ?? '').split('\n');
        write(`  ${name}  ${chalk.red(`failed: ${first}`)}`);
        for (const line of rest) {
          write(`      ${line}`);
        }
      }
    },
    finish(summary, action) {
      if (summary.ok) {
        const done = action === 'destroy' ? 'destroyed' : 'ready';
        write(chalk.green(`✔ infra ${done}`) + chalk.dim(` (${elapsed()})`));
        return;
      }
      const failed = summary.services.filter((s) => !s.ok).map((s) => s.service);
      write(chalk.red(`✖ infra failed: ${failed.join(', ')}`));
    },
  };
}
