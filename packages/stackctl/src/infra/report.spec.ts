import { describe, expect, test } from 'vitest';
import { stripAnsi } from '../format.js';
import { createInfraReporter } from './report.js';
import type { InfraEvent } from './types.js';

function render(
  events: InfraEvent[],
  finish?: Parameters<ReturnType<typeof createInfraReporter>['finish']>,
) {
  const lines: string[] = [];
  let clock = 0;
  const reporter = createInfraReporter({
    mode: 'development',
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
});
