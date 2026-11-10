/**
 * Sessions without the TUI: a headless run, `start --detach` and `stop`, `service` driving a
 * detached session, and a takeover with `--kill-others`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { isProcessAlive } from '../src/process-info.js';
import { PORTS, sessionRecord } from './fixture.js';
import { CliProcess, runCli, track, until } from './processes.js';
import { fixtureWorkspace } from './suite.js';

const ws = fixtureWorkspace();

/** Where each of `needles` first appears in `text`, in order; `-1` for one that doesn't. */
const positions = (text: string, needles: RegExp[]) => needles.map((needle) => text.search(needle));

test('headless with every service: the lines in order; SIGINT quits with exit 0', async () => {
  const session = await CliProcess.start(['--headless', '-s', 'api', '-s', 'web', '-s', 'worker'], {
    cwd: ws(),
  });
  await session.waitForOutput(/\[web\s*\] web listening on 21082/);
  await session.waitForOutput(/\[worker\s*\] worker listening on \d+/);

  const order = positions(session.stdout, [
    /\[stackctl\] \[INFO\] mode development \(default\)/,
    /\[api\s*\] started/,
    /\[web\s*\] waiting for api\.\.\./,
    /\[api\s*\] api listening on 21081/,
    /\[web\s*\] api ready, starting\.\.\./,
    /\[web\s*\] started/,
    /\[web\s*\] web listening on 21082/,
  ]);
  expect(
    order.every((at) => at >= 0),
    session.stdout,
  ).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(session.stdout).toMatch(/\[worker\s*\] started/);

  session.child.kill('SIGINT');
  expect(await session.waitForExit()).toEqual({ code: 0, signal: null });
  expect(session.stdout).toMatch(/shutting down/);
  expect(sessionRecord(ws())).toBeNull();
});

test('start --detach in CI: the session outlives the command, and stop ends it', async () => {
  const ci = { CI: '1' };
  // If the test fails halfway, the detached session is still stopped.
  track({
    close: async () => {
      if (sessionRecord(ws(), 'test')) {
        await runCli(['stop'], { cwd: ws(), env: ci });
      }
    },
  });

  const start = await runCli(['start', '--detach', '-s', 'api'], { cwd: ws(), env: ci });
  expect(start.exit, start.stderr).toEqual({ code: 0, signal: null });
  const ready = /^test session ready: pid (\d+), control API on (\d+), log (\S+\.log)$/m.exec(
    start.stdout,
  );
  expect(ready, start.stdout).not.toBeNull();
  const pid = Number(ready![1]);
  expect(sessionRecord(ws(), 'test')).toMatchObject({ pid, port: Number(ready![2]) });
  // The command is gone; its session isn't, and api answers.
  expect(isProcessAlive(pid)).toBe(true);
  const health = await fetch(`http://127.0.0.1:${String(PORTS.api)}/health`);
  expect(health.status).toBe(200);

  const stop = await runCli(['stop'], { cwd: ws(), env: ci });
  expect(stop.exit, stop.stderr).toEqual({ code: 0, signal: null });
  expect(stop.stdout).toContain(`stopped test session (pid ${String(pid)})`);
  await until(
    () => !isProcessAlive(pid),
    15_000,
    () => `the session (pid ${String(pid)}) still runs`,
  );
  expect(sessionRecord(ws(), 'test')).toBeNull();
});

/** The pids of `name`'s running dev processes, as the fixture server records them. */
const servicePids = (name: string) => {
  try {
    return fs
      .readdirSync(path.join(ws(), '.e2e-pids'))
      .filter((file) => file.startsWith(`${name}-`))
      .map((file) => Number(file.slice(name.length + 1)));
  } catch {
    return [];
  }
};

test('service restart, start and stop drive the detached session; with none they fail', async () => {
  const ci = { CI: '1' };
  track({
    close: async () => {
      if (sessionRecord(ws(), 'test')) {
        await runCli(['stop'], { cwd: ws(), env: ci });
      }
    },
  });
  const start = await runCli(['start', '--detach', '-s', 'api'], { cwd: ws(), env: ci });
  expect(start.exit, start.stderr).toEqual({ code: 0, signal: null });
  const [apiBefore] = servicePids('api');
  expect(apiBefore).toBeDefined();

  // A new api process, and the command returns only once it answers its healthcheck.
  const restart = await runCli(['service', 'restart', '-s', 'api'], { cwd: ws(), env: ci });
  expect(restart.exit, restart.stderr).toEqual({ code: 0, signal: null });
  expect(restart.stdout).toContain('restarting api');
  expect(servicePids('api')).not.toContain(apiBefore);
  expect((await fetch(`http://127.0.0.1:${String(PORTS.api)}/health`)).status).toBe(200);

  // worker wasn't picked: start adds it.
  const add = await runCli(['service', 'start', '-s', 'worker'], { cwd: ws(), env: ci });
  expect(add.exit, add.stderr).toEqual({ code: 0, signal: null });
  expect(add.stdout).toContain('started worker');
  expect(servicePids('worker')).toHaveLength(1);

  const halt = await runCli(['service', 'stop', '-s', 'worker', '-s', 'web'], {
    cwd: ws(),
    env: ci,
  });
  expect(halt.exit, halt.stderr).toEqual({ code: 0, signal: null });
  expect(halt.stdout).toContain('stopped worker\nweb is already stopped');
  await until(
    () => servicePids('worker').length === 0,
    15_000,
    () => 'worker still runs',
  );

  const unknown = await runCli(['service', 'restart', '-s', 'ghost'], { cwd: ws(), env: ci });
  expect(unknown.exit?.code).toBe(1);
  expect(unknown.stderr).toContain('Unknown service: ghost');

  expect((await runCli(['stop'], { cwd: ws(), env: ci })).exit?.code).toBe(0);
  const none = await runCli(['service', 'restart', '-s', 'api'], { cwd: ws(), env: ci });
  expect(none.exit?.code).toBe(1);
  expect(none.stderr).toContain('No test stackctl session is running');
});

test('--kill-others takes over: the running session quits with exit 0, the new one runs until stop', async () => {
  const a = await CliProcess.start(['--headless', '-s', 'api'], { cwd: ws() });
  await a.waitForOutput(/\[api\s*\] api listening on 21081/);
  expect(sessionRecord(ws())?.pid).toBe(a.owned.pid);

  const b = await CliProcess.start(['--headless', '-s', 'api', '--kill-others'], { cwd: ws() });
  expect(await a.waitForExit()).toEqual({ code: 0, signal: null });
  expect(a.stdout).toMatch(/\[dt:control\] \[INFO\] quit/);
  await b.waitForOutput(/\[api\s*\] api listening on 21081/);
  expect(b.stdout).toContain('closing previous session');
  expect(sessionRecord(ws())?.pid).toBe(b.owned.pid);

  const stop = await runCli(['stop'], { cwd: ws() });
  expect(stop.exit, stop.stderr).toEqual({ code: 0, signal: null });
  expect(await b.waitForExit()).toEqual({ code: 0, signal: null });
});
