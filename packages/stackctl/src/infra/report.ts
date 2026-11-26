import chalk from 'chalk';
import {
  INFRA_DONE_STATUS,
  type InfraEvent,
  type InfraRunAction,
  type InfraRunSummary,
} from './types';

/** How a run's first line names it. */
const HEADING: Record<InfraRunAction, string> = {
  up: 'infra',
  down: 'infra stop',
  destroy: 'infra destroy',
};

export interface InfraReporter {
  onEvent: (event: InfraEvent) => void;
  /** Prints the closing line for a run. */
  finish: (summary: InfraRunSummary, action: InfraRunAction) => void;
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
        write(
          `${chalk.blue('▶')} ${HEADING[event.action]} ${chalk.dim(`(${opts.profile})`)}: ${event.services.join(', ') || chalk.dim('no services')}`,
        );
        return;
      }
      if (event.type === 'output') {
        if (event.service === undefined) {
          // The provider's own progress (containers created, images pulled): there for when
          // something is slow or goes wrong, and dimmed so it reads as background. An error of
          // its own (a hook of the provider's that failed) is the run's headline: red.
          write(
            event.isError
              ? `${chalk.dim('[infra]')} ${chalk.red(event.line)}`
              : chalk.dim(`[infra] ${event.line}`),
          );
          return;
        }
        const prefix = chalk.dim(`[${event.service}]`);
        write(`${prefix} ${event.isError ? chalk.red(event.line) : event.line}`);
        return;
      }
      const name = event.service.padEnd(width);
      if (event.status === 'ready') {
        write(`  ${name}  ${chalk.green('ready')} ${chalk.dim(`(${elapsed()})`)}`);
      } else if ((event.status === 'destroyed' || event.status === 'stopped') && event.detail) {
        // It got there, but a hook around the step failed (or, in a reset, it went no further).
        const [first = '', ...rest] = event.detail.split('\n');
        write(`  ${name}  ${chalk.green(event.status)}${chalk.red(`, but ${first}`)}`);
        for (const line of rest) {
          write(`      ${line}`);
        }
      } else if (event.status === 'destroyed' || event.status === 'stopped') {
        write(`  ${name}  ${chalk.green(event.status)}`);
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
        write(chalk.green(`✔ infra ${INFRA_DONE_STATUS[action]}`) + chalk.dim(` (${elapsed()})`));
        return;
      }
      const failed = summary.services
        .filter((s) => !s.ok && !s.hookFailed && s.reached === undefined)
        .map((s) => s.service);
      const hooks = summary.services.filter((s) => s.hookFailed).map((s) => s.service);
      // A reset that stopped after its destroy: the services are destroyed, and none started.
      const reached = summary.services.find((s) => s.reached !== undefined)?.reached;
      write(
        chalk.red(
          failed.length > 0
            ? `✖ infra failed: ${failed.join(', ')}${hooks.length > 0 ? `; a hook failed: ${hooks.join(', ')}` : ''}`
            : reached !== undefined
              ? `✖ infra ${reached}, but a hook failed: ${hooks.join(', ')}; nothing was started`
              : `✖ infra ${INFRA_DONE_STATUS[action]}, but a hook failed: ${hooks.join(', ')}`,
        ),
      );
    },
  };
}
