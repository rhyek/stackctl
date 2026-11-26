import chalk from 'chalk';
import { describe, expect, test } from 'vitest';
import { stripAnsi } from '../format';
import { createInfraReporter } from './report';
import type { InfraEvent, InfraRunSummary } from './types';

function render(
  events: InfraEvent[],
  finish?: Parameters<ReturnType<typeof createInfraReporter>['finish']>,
) {
  const lines: string[] = [];
  let clock = 0;
  const reporter = createInfraReporter({
    profile: 'development',
    write: (line) => lines.push(stripAnsi(line)),
    // Every reading is 400ms after the last, so durations are predictable.
    now: () => (clock += 400),
  });
  events.forEach(reporter.onEvent);
  if (finish) {
    reporter.finish(...finish);
  }
  return lines;
}

describe('createInfraReporter', () => {
  test('prints a header, one line per service that became ready, and a closing line', () => {
    const lines = render(
      [
        { type: 'targets', provider: 'docker-compose', action: 'up', services: ['db', 'redis'] },
        { type: 'status', service: 'db', status: 'pending' },
        { type: 'status', service: 'redis', status: 'starting', detail: 'waiting for healthy' },
        { type: 'status', service: 'redis', status: 'ready' },
        { type: 'output', service: 'db', line: '2 migrations applied', isError: false },
        { type: 'status', service: 'db', status: 'ready' },
      ],
      [{ ok: true, services: [] }, 'up'],
    );
    expect(lines).toEqual([
      '▶ infra (development): db, redis',
      '  redis  ready (0.4s)',
      '[db] 2 migrations applied',
      '  db     ready (0.8s)',
      '✔ infra ready (1.2s)',
    ]);
  });

  test("labels the provider's own output as [infra]", () => {
    expect(
      render([{ type: 'output', line: 'Container example-db-1 Started', isError: false }]),
    ).toEqual(['[infra] Container example-db-1 Started']);
  });

  test("an error line of the provider's own stands out in red, where its progress is dim", () => {
    const level = chalk.level;
    chalk.level = 1;
    try {
      const lines: string[] = [];
      const reporter = createInfraReporter({ profile: 'development', write: (l) => lines.push(l) });
      reporter.onEvent({ type: 'output', line: 'Container example-db-1 Started', isError: false });
      reporter.onEvent({ type: 'output', line: 'docker-compose beforeStop failed: boom', isError: true }); // oxfmt-ignore
      expect(lines).toEqual([
        chalk.dim('[infra] Container example-db-1 Started'),
        `${chalk.dim('[infra]')} ${chalk.red('docker-compose beforeStop failed: boom')}`,
      ]);
      expect(lines[1]).toContain('\u001b[31m');
    } finally {
      chalk.level = level;
    }
  });

  test('shows a failure with its first line inline and the rest indented', () => {
    const lines = render(
      [
        { type: 'targets', provider: 'docker-compose', action: 'up', services: ['db'] },
        {
          type: 'status',
          service: 'db',
          status: 'failed',
          detail: 'exited (1)\nFATAL: bad config\nexiting',
        },
      ],
      [{ ok: false, services: [{ service: 'db', ok: false, error: 'exited (1)' }] }, 'up'],
    );
    expect(lines).toEqual([
      '▶ infra (development): db',
      '  db  failed: exited (1)',
      '      FATAL: bad config',
      '      exiting',
      '✖ infra failed: db',
    ]);
  });

  test('reports a destroy in its own words', () => {
    const lines = render(
      [
        { type: 'targets', provider: 'docker-compose', action: 'destroy', services: ['db'] },
        { type: 'status', service: 'db', status: 'destroying' },
        { type: 'output', line: 'removed volume example_db-data', isError: false },
        { type: 'status', service: 'db', status: 'destroyed' },
      ],
      [{ ok: true, services: [] }, 'destroy'],
    );
    expect(lines).toEqual([
      '▶ infra destroy (development): db',
      '[infra] removed volume example_db-data',
      '  db  destroyed',
      '✔ infra destroyed (0.4s)',
    ]);
  });

  test('a stop whose hook failed says the service was stopped and what failed; the closing line, that the command failed', () => {
    const lines = render(
      [
        { type: 'targets', provider: 'docker-compose', action: 'down', services: ['db', 'redis'] },
        { type: 'status', service: 'db', status: 'stopping' },
        {
          type: 'status',
          service: 'db',
          status: 'stopped',
          detail: 'beforeStop failed: boom\nfake afterStop failed: later',
        },
        { type: 'status', service: 'redis', status: 'stopped' },
      ],
      [
        {
          ok: false,
          services: [
            { service: 'db', ok: false, error: 'beforeStop failed: boom', hookFailed: true },
            { service: 'redis', ok: true },
          ],
        },
        'down',
      ],
    );
    expect(lines).toEqual([
      '▶ infra stop (development): db, redis',
      '  db     stopped, but beforeStop failed: boom',
      '      fake afterStop failed: later',
      '  redis  stopped',
      '✖ infra stopped, but a hook failed: db',
    ]);
  });

  test('a service destroyed whose afterDestroy failed reads "destroyed, but …"', () => {
    const lines = render(
      [
        { type: 'targets', provider: 'docker-compose', action: 'destroy', services: ['db'] },
        { type: 'status', service: 'db', status: 'destroying' },
        { type: 'status', service: 'db', status: 'destroyed', detail: 'afterDestroy failed: boom' },
      ],
      [
        {
          ok: false,
          services: [
            { service: 'db', ok: false, error: 'afterDestroy failed: boom', hookFailed: true },
          ],
        },
        'destroy',
      ],
    );
    expect(lines).toEqual([
      '▶ infra destroy (development): db',
      '  db  destroyed, but afterDestroy failed: boom',
      '✖ infra destroyed, but a hook failed: db',
    ]);
  });

  test('a reset that stopped after its destroy says what was destroyed, and that nothing started', () => {
    const lines = render(
      [
        { type: 'targets', provider: 'docker-compose', action: 'up', services: ['db', 'redis'] },
        { type: 'status', service: 'db', status: 'destroyed', detail: 'afterDestroy failed: boom' },
        {
          type: 'status',
          service: 'redis',
          status: 'destroyed',
          detail: 'not started: db failed in afterDestroy',
        },
      ],
      [
        {
          ok: false,
          services: [
            {
              service: 'db',
              ok: false,
              error: 'afterDestroy failed: boom',
              hookFailed: true,
              reached: 'destroyed',
            },
            {
              service: 'redis',
              ok: false,
              error: 'not started: db failed in afterDestroy',
              reached: 'destroyed',
            },
          ],
        },
        'up',
      ],
    );
    expect(lines).toEqual([
      '▶ infra (development): db, redis',
      '  db     destroyed, but afterDestroy failed: boom',
      '  redis  destroyed, but not started: db failed in afterDestroy',
      '✖ infra destroyed, but a hook failed: db; nothing was started',
    ]);
  });

  test('a closing line names the services that failed, and those whose hook failed', () => {
    const closing = (services: InfraRunSummary['services']) =>
      render([], [{ ok: false, services }, 'up']).at(-1);
    expect(closing([{ service: 'db', ok: false, error: 'x', hookFailed: true }])).toBe(
      '✖ infra ready, but a hook failed: db',
    );
    expect(
      closing([
        { service: 'db', ok: false, error: 'x', hookFailed: true },
        { service: 'redis', ok: false, error: 'not ready after 5s' },
      ]),
    ).toBe('✖ infra failed: redis; a hook failed: db');
  });

  test('reports a stop in its own words', () => {
    const lines = render(
      [
        { type: 'targets', provider: 'docker-compose', action: 'down', services: ['db'] },
        { type: 'status', service: 'db', status: 'stopping' },
        { type: 'status', service: 'db', status: 'stopped' },
      ],
      [{ ok: true, services: [] }, 'down'],
    );
    expect(lines).toEqual([
      '▶ infra stop (development): db',
      '  db  stopped',
      '✔ infra stopped (0.4s)',
    ]);
  });
});
