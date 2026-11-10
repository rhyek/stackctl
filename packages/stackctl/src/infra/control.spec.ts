import { describe, expect, test, vi } from 'vitest';
import { InfraControl, infraCliSteps } from './control.js';
import type { InfraServiceState } from './types.js';

/**
 * A stand-in for the stackctl CLI: prints the arguments it got, and fails when they name the
 * `broken` service.
 */
const FAKE_CLI = [
  process.execPath,
  '-e',
  `const a = process.argv.slice(1); console.log('args: ' + a.join(' ')); process.exit(a.includes('broken') ? 3 : 0);`,
  '--',
];

function control(services = ['db', 'broken']) {
  const lines: string[] = [];
  let report: ((states: Map<string, InfraServiceState>) => void) | null = null;
  const refresh = vi.fn();
  const stop = vi.fn();
  const infra = new InfraControl({
    services,
    watch: (onStates) => {
      report = onStates;
      return { stop, refresh };
    },
    cli: FAKE_CLI,
    mode: 'test',
    cwd: process.cwd(),
    // oxlint-disable-next-line no-control-regex -- strips the color the log lines carry
    log: (service, text) => lines.push(`${service}: ${text.replace(/\x1b\[[0-9;]*m/g, '')}`),
  });
  return {
    infra,
    lines,
    refresh,
    stop,
    report: (s: Map<string, InfraServiceState>) => report?.(s),
  };
}

/** Resolves once the service has no action under way. */
async function settled(infra: InfraControl, service: string) {
  await vi.waitFor(() => expect(infra.isBusy(service)).toBe(false), { timeout: 5000 });
}

describe('infraCliSteps', () => {
  test('maps each action to the infra commands it runs', () => {
    expect(infraCliSteps('start', 'db')).toEqual([['infra', 'up', 'db']]);
    expect(infraCliSteps('stop', 'db')).toEqual([['infra', 'down', 'db']]);
    expect(infraCliSteps('restart', 'db')).toEqual([
      ['infra', 'down', 'db'],
      ['infra', 'up', 'db'],
    ]);
    expect(infraCliSteps('reset', 'db')).toEqual([['infra', 'up', '--reset', 'db']]);
  });
});

describe('InfraControl', () => {
  test('takes every service as running until the watch reports, then follows it', () => {
    const { infra, report } = control();
    expect(infra.statuses()).toEqual({ db: 'running', broken: 'running' });
    const changed = vi.fn();
    infra.subscribe(changed);
    infra.start();
    report(new Map([['db', 'starting']]));
    expect(infra.status('db')).toBe('starting');
    expect(changed).toHaveBeenCalledTimes(1);
    // The same reading again is no change.
    report(new Map([['db', 'starting']]));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  test('runs the infra command with the mode, logs it, and refreshes the watch after', async () => {
    const { infra, lines, refresh } = control();
    infra.start();
    expect(infra.run('db', 'restart')).toBe('accepted');
    expect(infra.status('db')).toBe('restarting');
    expect(infra.run('db', 'stop')).toBe('busy');
    await settled(infra, 'db');
    expect(lines).toEqual([
      'db: ▶ running: stackctl infra down db',
      'db: args: infra down db --mode test',
      'db: ✔ stackctl infra down db finished',
      'db: ▶ running: stackctl infra up db',
      'db: args: infra up db --mode test',
      'db: ✔ stackctl infra up db finished',
    ]);
    expect(infra.status('db')).toBe('running');
    expect(refresh).toHaveBeenCalled();
  });

  test('stops a restart at the step that fails', async () => {
    const { infra, lines } = control();
    infra.run('broken', 'restart');
    await settled(infra, 'broken');
    expect(lines.at(-1)).toBe('broken: ✘ stackctl infra down broken exited with code 3');
    expect(lines.some((l) => l.includes('infra up broken'))).toBe(false);
  });

  test('refuses a service it does not have', () => {
    expect(control().infra.run('cache', 'start')).toBe('unknown');
  });

  test('starts nothing once stopped: no new action, and no further step of one under way', async () => {
    // A shutdown stops the control and kills what is running; an action asked for after that, or
    // the next step of one already under way, would outlive the session.
    const { infra, lines } = control();
    infra.run('db', 'restart');
    infra.stop();
    expect(infra.run('broken', 'start')).toBe('busy');
    await settled(infra, 'db');
    expect(lines.some((l) => l.includes('infra up db'))).toBe(false);
  });

  test('a step under way when the control stops logs no end line', async () => {
    // A shutdown SIGTERMs the actions it waits on; their exit is not reported as a failure.
    const { infra, lines } = control();
    infra.run('db', 'start');
    infra.stop();
    await settled(infra, 'db');
    expect(lines).toContain('db: ▶ running: stackctl infra up db');
    expect(lines.filter((l) => l.includes('✔') || l.includes('✘'))).toEqual([]);
  });
});
