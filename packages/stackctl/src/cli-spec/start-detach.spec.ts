import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect, afterEach } from 'vitest';
import {
  cli,
  start,
  type Owned,
  own,
  killOwned,
  ws,
  stackctl,
  setUpCliWorkspace,
} from './harness.js';

/** `start --detach`: a session that outlives the command that started it. See `harness.ts`. */
setUpCliWorkspace('start-detach');

describe('start --detach', () => {
  const recordOf = (profile: string) => path.join(ws, 'node_modules', '.stackctl', 'profiles', profile, 'running.json'); // oxfmt-ignore
  /** Not an agent, whatever runs the suite: the refusal has a test of its own. */
  const human = { STACKCTL_STARTED_BY_AGENT: '0' };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (done: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!done() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return done();
  };

  /**
   * Sessions a test detached, by profile and pid: stopped after it, then killed should one still
   * run.
   */
  const detached: (Owned & { profile: string })[] = [];
  const keep = async (profile: string, pid: number) => {
    const owned = await own(pid);
    if (owned) {
      detached.push({ ...owned, profile });
    }
  };
  afterEach(async () => {
    for (const session of detached.splice(0)) {
      await stackctl(['--profile', session.profile, 'stop']);
      await killOwned(session);
    }
  });

  /**
   * The `<profile> session ready: pid <pid>, control API on <port>, log <logFile>` line, parsed.
   */
  const readyLine = (stdout: string) => {
    const match = /^(\S+) session ready: pid (\d+), control API on (\d+), log (.+)$/m.exec(stdout);
    expect(match, stdout).not.toBeNull();
    const [, profile, pid, port, logFile] = match!;
    return { profile: profile!, pid: Number(pid), port: Number(port), logFile: logFile! };
  };

  /** `stackctl <args> start --detach <rest>`. */
  const detach = (rest: string[], env: Record<string, string> = human, before: string[] = []) =>
    stackctl([...before, 'start', '--detach', ...rest], { env });

  test('returns once ready, and the session still answers after the command has exited', async () => {
    const result = await detach(['-s', 'idle']);
    expect(result.exitCode, result.stderr).toBe(0);
    const ready = readyLine(result.stdout);
    expect(ready.profile).toBe('development');
    await keep('development', ready.pid);
    // The command has exited; the session hasn't, and answers as itself.
    const status = (await (await fetch(`http://127.0.0.1:${String(ready.port)}/query/status`)).json()) as { pid: number; sessionReady: boolean; profile: string; profileSource: string }; // oxfmt-ignore
    expect(status).toMatchObject({ pid: ready.pid, sessionReady: true, profile: 'development', profileSource: 'default' }); // oxfmt-ignore
    expect(JSON.parse(fs.readFileSync(recordOf('development'), 'utf8'))).toMatchObject({ pid: ready.pid }); // oxfmt-ignore
    // Its log starts with the profile and where it came from.
    expect(fs.readFileSync(ready.logFile as string, 'utf8')).toContain('[stackctl] [INFO] profile development (default)'); // oxfmt-ignore

    // A session of the profile is running: another --detach fails, naming it.
    const again = await detach(['-s', 'idle']);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain(`a development session of this workspace is already running (pid ${String(ready.pid)})`); // oxfmt-ignore
    expect(alive(ready.pid)).toBe(true);

    const stopped = await stackctl(['--profile', 'development', 'stop']);
    expect(stopped.stdout).toBe(`stopped development session (pid ${String(ready.pid)})`);
    expect(alive(ready.pid)).toBe(false);
  }, 90_000);

  test('a $(…) capture returns, with the one line it prints', async () => {
    const result = await start(
      'sh',
      ['-c', 'out=$(node "$0" --profile test start -d -s idle); echo "$out"', cli],
      { cwd: ws, env: human, timeout: 60_000 },
    ).done;
    expect(result.exitCode, result.stderr).toBe(0);
    const match = /^test session ready: pid (\d+), control API on (\d+), log (.+\/sessions\/\d+\/logs\.txt)$/.exec(result.stdout); // oxfmt-ignore
    expect(match, result.stdout).not.toBeNull();
    await keep('test', Number(match![1]));
    expect(JSON.parse(fs.readFileSync(recordOf('test'), 'utf8'))).toMatchObject({ pid: Number(match![1]), port: Number(match![2]) }); // oxfmt-ignore
    expect(fs.readFileSync(match![3]!, 'utf8')).toContain('[stackctl] [INFO] profile test (from --profile)'); // oxfmt-ignore
  }, 90_000);

  test('a service that crashes on start: exit 1, the log tail, and nothing left', async () => {
    const result = await detach(['-s', 'broken']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/start --detach failed: broken stopped while starting/);
    expect(result.stderr).toMatch(/\nlog: .*\/sessions\/\d+\/logs\.txt\n/);
    expect(result.stderr).toContain('[stackctl] [INFO] profile development (default)');
    expect(fs.existsSync(recordOf('development'))).toBe(false);
    expect((await stackctl(['--profile', 'development', 'stop'])).stdout).toBe('No development stackctl session is running.'); // oxfmt-ignore
  }, 90_000);

  test('a picked autostart: false service stays stopped, and the start succeeds', async () => {
    const result = await detach(['-s', 'idle', '-s', 'manual']);
    expect(result.exitCode, result.stderr).toBe(0);
    const ready = readyLine(result.stdout);
    await keep('development', ready.pid);
    const status = (await (await fetch(`http://127.0.0.1:${String(ready.port)}/query/status`)).json()) as { services: Record<string, string> }; // oxfmt-ignore
    expect(status.services).toMatchObject({ idle: 'running', manual: 'stopped' });
  }, 90_000);

  test('--wait-timeout 1 against a service never healthy: exit 1, and nothing left', async () => {
    const result = await detach(['-s', 'slow', '--wait-timeout', '1']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/start --detach failed: .*(not healthy after 1s: slow|didn't come up within 1s)/); // oxfmt-ignore
    expect(fs.existsSync(recordOf('development'))).toBe(false);
    expect((await stackctl(['--profile', 'development', 'stop'])).stdout).toBe('No development stackctl session is running.'); // oxfmt-ignore
  }, 90_000);

  test('SIGINT while waiting: exit 130, and nothing left', async () => {
    const child = start('node', [cli, 'start', '--detach', '-s', 'slow'], {
      cwd: ws,
      env: human,
    });
    // Once the session is up, and waiting on slow.
    expect(await until(() => fs.existsSync(recordOf('development')), 30_000)).toBe(true);
    const { pid } = JSON.parse(fs.readFileSync(recordOf('development'), 'utf8')) as { pid: number };
    await keep('development', pid);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    child.kill('SIGINT');
    const result = await child.done;
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toMatch(/start --detach failed: interrupted/);
    expect(alive(pid)).toBe(false);
    expect(fs.existsSync(recordOf('development'))).toBe(false);
  }, 90_000);

  test('the command killed outright while it waits: the session quits with it', async () => {
    const child = start('node', [cli, 'start', '--detach', '-s', 'slow'], {
      cwd: ws,
      env: human,
    });
    expect(await until(() => fs.existsSync(recordOf('development')), 30_000)).toBe(true);
    const { pid } = JSON.parse(fs.readFileSync(recordOf('development'), 'utf8')) as { pid: number };
    await keep('development', pid);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // No handler of the command's runs: only the closed channel tells the session.
    child.kill('SIGKILL');
    await child.done;
    expect(await until(() => !alive(pid), 30_000)).toBe(true);
    expect(fs.existsSync(recordOf('development'))).toBe(false);
  }, 90_000);

  test('is refused for a coding agent outside CI, and allowed in CI or with the override', async () => {
    const agent = { CLAUDECODE: '1', CI: '', STACKCTL_STARTED_BY_AGENT: '' };
    // An agent names the profile, as it must.
    const refused = await detach(['-s', 'idle', '--profile', 'development'], agent);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('start --detach is for CI');
    expect(refused.stderr).toContain('STACKCTL_STARTED_BY_AGENT=0');
    expect(fs.existsSync(recordOf('development'))).toBe(false);

    // In CI too: the CI default is a default.
    const unnamed = await detach(['-s', 'idle'], { ...agent, CI: 'true' });
    expect(unnamed.exitCode).toBe(1);
    expect(unnamed.stderr).toContain('stackctl --profile development start');
    const ci = await detach(['-s', 'idle', '--profile', 'test'], { ...agent, CI: 'true' });
    expect(ci.exitCode, ci.stderr).toBe(0);
    const inCi = readyLine(ci.stdout);
    await keep('test', inCi.pid);
    expect(inCi.profile).toBe('test');
    const ciStatus = (await (await fetch(`http://127.0.0.1:${String(inCi.port)}/query/status`)).json()) as { profileSource: string }; // oxfmt-ignore
    expect(ciStatus.profileSource).toBe('flag');

    const overridden = await detach(['-s', 'idle'], { ...agent, STACKCTL_STARTED_BY_AGENT: '0' }); // oxfmt-ignore
    expect(overridden.exitCode, overridden.stderr).toBe(0);
    await keep('development', readyLine(overridden.stdout).pid);
  }, 90_000);

  test.each([
    [['-s', 'idle', '--ui'], "--ui and --detach can't be combined."],
    [[], '--detach needs services to start: pass --service or --last-answers.'],
  ])('%j is refused', async (rest, message) => {
    const result = await detach(rest);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(message);
  });
});
