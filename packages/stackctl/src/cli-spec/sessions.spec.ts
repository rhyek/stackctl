import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Running } from '../spawn.js';
import {
  packageDir,
  buildDir,
  cli,
  start,
  parentPid,
  script,
  setUpCliWorkspace,
} from './harness.js';

/** Sessions from the command line: starting one, the default command, their records, and one
 * whose .env file cannot be read yet. See `harness.ts`. */
setUpCliWorkspace('sessions');

/**
 * A workspace of its own, with `web` and `worker` (each idle once started), for the specs that
 * start sessions and read what they leave behind: the shared one's state is other specs' too.
 */
describe('sessions', () => {
  let sws: string;
  const stateDir = () => path.join(sws, 'node_modules', '.stackctl');
  const recordOf = (mode: string) => path.join(stateDir(), 'modes', mode, 'running.json');
  /** The modes with a session record, as `<mode>/running.json`. */
  const records = () =>
    fs.existsSync(path.join(stateDir(), 'modes'))
      ? fs
          .readdirSync(path.join(stateDir(), 'modes'))
          .filter((mode) => fs.existsSync(recordOf(mode)))
          .map((mode) => `${mode}/running.json`)
      : [];

  beforeAll(() => {
    sws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-cli-sessions-')));
    fs.writeFileSync(path.join(sws, 'package.json'), JSON.stringify({ name: 'sessionsroot', type: 'module' })); // oxfmt-ignore
    fs.writeFileSync(path.join(sws, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    fs.writeFileSync(
      path.join(sws, 'stackctl.config.ts'),
      "import { defineConfig } from 'stackctl';\nexport default defineConfig({ serviceRootDir: 'packages', services: { web: {}, worker: {} } });\n",
    );
    const standIn = path.join(sws, 'node_modules', 'stackctl');
    fs.mkdirSync(standIn, { recursive: true });
    fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
    fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
    for (const name of ['web', 'worker']) {
      const dir = path.join(sws, 'packages', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, scripts: { dev: script('setInterval(()=>{},1e9)') } }),
      );
    }
  });

  afterAll(() => {
    fs.rmSync(sws, { recursive: true, force: true });
  });

  /** Sessions a test started, ended after it whatever happened; and the ones that have exited. */
  const started: Running[] = [];
  const ended = new WeakSet<Running>();
  afterEach(async () => {
    for (const child of started.splice(0)) {
      await endSession(child);
    }
  });

  /**
   * Ends a session: SIGTERM, then — should it not exit — SIGKILL, and the process groups of the
   * services its record names, which a SIGKILLed session leaves running. Only ever its own pid,
   * and the groups it recorded whose leader is still its child: never 0 or below, which would
   * signal whole groups.
   */
  async function endSession(child: Running): Promise<void> {
    if (ended.has(child) || !(child.pid! > 0)) {
      await child.done;
      return;
    }
    const exited = child.done.then(() => true);
    child.kill('SIGTERM');
    if (
      await Promise.race([exited, new Promise<false>((r) => setTimeout(() => r(false), 15_000))])
    ) {
      return;
    }
    for (const name of records()) {
      try {
        const record = JSON.parse(
          fs.readFileSync(path.join(stateDir(), 'modes', name), 'utf8'),
        ) as {
          pid: number;
          children?: { pid: number }[];
        };
        if (record.pid !== child.pid) {
          continue;
        }
        for (const { pid } of record.children ?? []) {
          if (pid > 0 && parentPid(pid) === child.pid) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              /* gone */
            }
          }
        }
      } catch {
        /* not readable */
      }
    }
    child.kill('SIGKILL');
    await child.done;
  }

  /**
   * Starts a session with `args` in the workspace and resolves, with its subprocess, once `until`
   * has been printed.
   */
  async function startSession(args: string[], until: string) {
    const child = start('node', [cli, ...args], { cwd: sws });
    started.push(child);
    void child.done.then(() => ended.add(child));
    let output = '';
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    await new Promise<void>((resolve, reject) => {
      const giveUp = setTimeout(
        () => reject(new Error(`never printed ${until}:\n${output}`)),
        20_000,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(until)) {
          clearTimeout(giveUp);
          resolve();
        }
      });
      void child.done.then(() => {
        clearTimeout(giveUp);
        reject(new Error(`exited before printing ${until}:\n${output}`));
      });
    });
    return { child };
  }

  /** The session started by `args`, ended once it printed `until`. */
  async function runSession(args: string[], until: string): Promise<void> {
    const { child } = await startSession(args, until);
    await endSession(child);
  }

  describe('start is the default command', () => {
    test.each([
      ['stackctl --headless -s web', ['--headless', '-s', 'web']],
      ['stackctl start --headless -s web', ['start', '--headless', '-s', 'web']],
    ])(
      '%s starts a headless session of web',
      async (_, args) => {
        const { child } = await startSession(args, '[web     ] started');
        expect(JSON.parse(fs.readFileSync(recordOf('development'), 'utf8'))).toMatchObject({ pid: child.pid }); // oxfmt-ignore
        await endSession(child);
      },
      30_000,
    );

    test.each([
      ['before start', ['--mode', 'test', 'start', '--headless', '-s', 'web']],
      ['after start', ['start', '--mode', 'test', '--headless', '-s', 'web']],
      ['with no start typed', ['--headless', '--mode', 'test', '-s', 'web']],
    ])(
      '--mode %s runs the session in that mode',
      async (_, args) => {
        const { child } = await startSession(args, '[web     ] started');
        expect(records()).toEqual(['test/running.json']);
        expect(JSON.parse(fs.readFileSync(recordOf('test'), 'utf8'))).toMatchObject({ pid: child.pid }); // oxfmt-ignore
        await endSession(child);
      },
      30_000,
    );

    test.each([
      [
        ['-s', 'web', 'exec', '--', 'true'],
        'exec takes the service or directory as its first argument: stackctl exec api -- <command>',
      ],
      [
        ['-s', 'web', 'run', 'build'],
        'run takes the service or directory as its first argument: stackctl run api <script>',
      ],
      [
        ['start', '-s', 'web', 'exec', '--', 'true'],
        'exec takes the service or directory as its first argument: stackctl exec api -- <command>',
      ],
    ])(
      'stackctl %j fails, saying where the service goes, and starts no session',
      async (args, message) => {
        const result = await start('node', [cli, ...args], { cwd: sws }).done;
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toBe(message);
        expect(result.stdout).not.toContain('started');
        expect(records()).toEqual([]);
      },
    );

    test('start takes no other arguments', async () => {
      const result = await start('node', [cli, 'start', 'web'], { cwd: sws }).done;
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("error: too many arguments for 'start'");
      expect(records()).toEqual([]);
    });
  });

  describe("headless -s doesn't touch the saved selection", () => {
    const selectionFile = () => path.join(stateDir(), 'modes', 'development', 'selection.json');
    /** Saves `["worker"]` as the selection, dated an hour back so a rewrite shows. */
    const saveWorker = () => {
      fs.mkdirSync(path.dirname(selectionFile()), { recursive: true });
      fs.writeFileSync(selectionFile(), JSON.stringify(['worker']));
      const past = new Date(Date.now() - 3_600_000);
      fs.utimesSync(selectionFile(), past, past);
      return fs.statSync(selectionFile()).mtimeMs;
    };

    test('a session of -s web leaves it as it was', async () => {
      const mtime = saveWorker();
      await runSession(['--headless', '-s', 'web'], '[web     ] started');
      expect(JSON.parse(fs.readFileSync(selectionFile(), 'utf8'))).toEqual(['worker']);
      expect(fs.statSync(selectionFile()).mtimeMs).toBe(mtime);
    }, 30_000);

    test('a session of --last-answers runs it, and leaves it as it was', async () => {
      const mtime = saveWorker();
      await runSession(['--headless', '--last-answers'], '[worker  ] started');
      expect(JSON.parse(fs.readFileSync(selectionFile(), 'utf8'))).toEqual(['worker']);
      expect(fs.statSync(selectionFile()).mtimeMs).toBe(mtime);
    }, 30_000);
  });
});

describe.skipIf(process.platform === 'win32')(
  'a session an .env file of which cannot be read yet',
  () => {
    // macOS holds a read of a File Provider folder (Dropbox, iCloud) until the user answers its
    // prompt to allow access, which can be hours. A FIFO stands in: opening one blocks until a writer
    // opens it, and none does here. Each test has a workspace of its own, so no other session reads
    // its FIFO.
    const made: {
      dir: string;
      fifo: string;
      session?: Running;
      ended: boolean;
    }[] = [];

    /** A workspace with one service, `idle`, whose `fifoAt` (relative to its root) is a FIFO. */
    function blockedWorkspace(opts: { config: string; fifoAt: string }) {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-cli-blocked-')));
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'blockedroot', type: 'module' })); // oxfmt-ignore
      fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      fs.writeFileSync(
        path.join(dir, 'stackctl.config.ts'),
        `import { defineConfig } from 'stackctl';\nexport default defineConfig(${opts.config});\n`,
      );
      const standIn = path.join(dir, 'node_modules', 'stackctl');
      fs.mkdirSync(standIn, { recursive: true });
      fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
      fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
      const idle = path.join(dir, 'packages', 'idle');
      fs.mkdirSync(idle, { recursive: true });
      fs.writeFileSync(
        path.join(idle, 'package.json'),
        JSON.stringify({ name: 'idle', scripts: { dev: script('setInterval(()=>{},1e9)') } }),
      );
      const fifo = path.join(dir, opts.fifoAt);
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
      const entry: (typeof made)[number] = { dir, fifo, ended: false };
      made.push(entry);
      return entry;
    }

    /** Starts a `--headless` session of `idle` in `ws`, collecting its output. */
    function startSession(ws: (typeof made)[number]) {
      const session = start('node', [cli, '--headless', '-s', 'idle'], {
        cwd: ws.dir,
      });
      ws.session = session;
      void session.done.then(() => (ws.ended = true));
      const output = { text: '' };
      session.stdout!.on('data', (chunk: Buffer) => (output.text += chunk.toString()));
      session.stderr!.on('data', (chunk: Buffer) => (output.text += chunk.toString()));
      return { session, output };
    }

    /** Whether `session` ends within 10s of a SIGTERM. */
    async function endsOnSigterm(session: Running): Promise<boolean> {
      session.kill('SIGTERM');
      const ended = await Promise.race([
        session.done.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      return ended;
    }

    /**
     * Whether a process has `fifo` open to read, a read blocked in opening it among them. Opening
     * it to write, which succeeds only then, lets that read go on: closed again at once, the file
     * reads as empty, and the reader goes on to exit.
     */
    const releaseReader = (fifo: string): boolean => {
      try {
        fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        return true;
      } catch {
        return false; // ENXIO: no reader
      }
    };

    afterEach(async () => {
      for (const ws of made.splice(0)) {
        // A session stuck in the read itself only ever ends by SIGKILL, and one killed so leaves its
        // reader behind, blocked on the FIFO: released, it exits by itself, with no signal.
        if (ws.session !== undefined && !ws.ended) {
          ws.session.kill('SIGKILL');
        }
        await ws.session?.done;
        const deadline = Date.now() + 5000;
        while (releaseReader(ws.fifo) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        fs.rmSync(ws.dir, { recursive: true, force: true });
      }
    });

    test("a service's: answers its control API while it waits, and stops on SIGTERM", async () => {
      // No `env` callback: loading the config reads no `.env` file of a service.
      const ws = blockedWorkspace({
        config: "{ serviceRootDir: 'packages', services: { idle: {} } }",
        fifoAt: 'packages/idle/.env.development',
      });
      const { session, output } = startSession(ws);

      const record = path.join(ws.dir, 'node_modules', '.stackctl', 'modes', 'development', 'running.json'); // oxfmt-ignore
      const status = async (): Promise<{
        services?: Record<string, string>;
        logFile?: string;
      } | null> => {
        try {
          const { port } = JSON.parse(fs.readFileSync(record, 'utf8')) as { port: number };
          const res = await fetch(`http://127.0.0.1:${String(port)}/query/status`, {
            signal: AbortSignal.timeout(1000),
          });
          return (await res.json()) as { services?: Record<string, string>; logFile?: string };
        } catch {
          return null;
        }
      };
      const until = async (done: () => Promise<boolean>, what: string) => {
        const deadline = Date.now() + 15_000;
        while (!(await done())) {
          if (Date.now() > deadline) {
            throw new Error(`${what}:\n${output.text}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };

      // Its control API answers, its service under way, as `startStack()` counts it: not stopped.
      await until(
        async () => (await status())?.services !== undefined,
        'its control API never answered',
      );
      const { services, logFile } = (await status())!;
      expect(services).toEqual({ idle: 'waiting' });
      // The log names the file it waits on.
      await until(
        async () => fs.readFileSync(logFile!, 'utf8').includes(`waiting to read ${ws.fifo}`),
        'it never said what it waits on',
      );

      expect(await endsOnSigterm(session), `still running 10s after SIGTERM:\n${output.text}`).toBe(true); // oxfmt-ignore
      // Nothing is left waiting on the file. Checked once, after a moment for a killed reader to
      // close it: a check that finds one releases it, so a second would always pass.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(releaseReader(ws.fifo)).toBe(false);
    }, 40_000);

    // Loading the config reads its files on the event loop's thread, which only a signal with no
    // handler of the process's own can interrupt: so it must be done before any is installed.
    test("the workspace's, read by a config callback: stops on SIGTERM", async () => {
      const ws = blockedWorkspace({
        config:
        "{ serviceRootDir: 'packages', env: { vars: ({ envs }) => ({ HOME_DIR: envs.HOME ?? '' }) }, services: { idle: {} } }", // oxfmt-ignore
        fifoAt: '.env.development',
      });
      const { session, output } = startSession(ws);
      // Long enough to be well into loading the config, and blocked there: it never got as far as
      // recording a session.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(ws.ended, output.text).toBe(false);
      expect(fs.existsSync(path.join(ws.dir, 'node_modules', '.stackctl'))).toBe(false);
      expect(output.text).not.toContain('freeing dev ports');
      expect(await endsOnSigterm(session), `still running 10s after SIGTERM:\n${output.text}`).toBe(true); // oxfmt-ignore
    }, 40_000);
  },
);
