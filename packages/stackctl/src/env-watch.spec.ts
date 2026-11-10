import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { watchEnvFiles } from './env-watch.js';

let dir: string;
let dispose: (() => void) | undefined;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeout = 2000, step = 20): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) {
      return;
    }
    await new Promise((r) => setTimeout(r, step));
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-envwatch-'));
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('watchEnvFiles', () => {
  test('fires (debounced) when a watched file is created or changed', async () => {
    let calls = 0;
    const watch = watchEnvFiles({
      targets: [{ dir, filenames: ['.env.local'], onChange: () => calls++ }],
      debounceMs: 40,
    });
    dispose = watch;
    await watch.ready;

    fs.writeFileSync(path.join(dir, '.env.local'), 'A=1\n');
    await waitFor(() => calls >= 1);
    expect(calls).toBe(1);

    // Two quick writes collapse into a single debounced call.
    fs.writeFileSync(path.join(dir, '.env.local'), 'A=2\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'A=3\n');
    await waitFor(() => calls >= 2);
    expect(calls).toBe(2);
  });

  test('ignores changes to files not in the watch list', async () => {
    let calls = 0;
    dispose = watchEnvFiles({
      targets: [{ dir, filenames: ['.env.local'], onChange: () => calls++ }],
      debounceMs: 40,
    });

    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x\n');
    await wait(150);
    expect(calls).toBe(0);
  });

  test('stops firing after dispose', async () => {
    let calls = 0;
    const stop = watchEnvFiles({
      targets: [{ dir, filenames: ['.env.local'], onChange: () => calls++ }],
      debounceMs: 40,
    });
    stop();

    fs.writeFileSync(path.join(dir, '.env.local'), 'A=1\n');
    await wait(150);
    expect(calls).toBe(0);
  });

  describe('an event that leaves the content as it was', () => {
    // A sync client such as Dropbox rewrites its own extended attributes on a file a second or
    // more after each sync, and FSEvents reports that as a change to the file; the debounce can't
    // absorb it. Only a change to what the file reads as should restart anything.
    let file: string;
    let counter: { calls: number };
    beforeEach(async () => {
      file = path.join(dir, '.env.local');
      fs.writeFileSync(file, 'A=1\n');
      counter = { calls: 0 };
      dispose = watchEnvFiles({
        targets: [{ dir, filenames: ['.env.local'], onChange: () => counter.calls++ }],
        debounceMs: 40,
      });
      // Let the watch go live, and FSEvents' report of the write above pass.
      await wait(200);
      counter.calls = 0;
    });

    test('does not fire when only the modification time changes', async () => {
      const later = new Date(Date.now() + 10_000);
      fs.utimesSync(file, later, later);
      await wait(200);
      expect(counter.calls).toBe(0);

      fs.appendFileSync(file, 'B=2\n');
      await waitFor(() => counter.calls >= 1);
      expect(counter.calls).toBe(1);
    });

    test.skipIf(process.platform !== 'darwin')(
      'does not fire when only an extended attribute is written',
      async () => {
        execFileSync('xattr', ['-w', 'com.example.stackctl-spec', '1', file]);
        await wait(200);
        expect(counter.calls).toBe(0);
      },
    );
  });

  test('does not throw when a target directory does not exist', () => {
    expect(() => {
      dispose = watchEnvFiles({
        targets: [{ dir: path.join(dir, 'missing'), filenames: ['.env'], onChange: () => {} }],
        debounceMs: 40,
      });
    }).not.toThrow();
  });

  test('reports a watcher that fails after creation instead of crashing the process', () => {
    // The OS can fail a watcher asynchronously, long after `fs.watch()` returned — EMFILE on
    // macOS being the common one, since the FSEvents budget is machine-wide and an unrelated
    // watch-heavy dev stack can exhaust it. An FSWatcher with no 'error' listener turns that into
    // an unhandled 'error' event, which kills the whole stackctl process and every package with
    // it. Stand in a fake watcher so the failure is deterministic.
    const fake = new EventEmitter() as EventEmitter & { close: () => void };
    let closed = false;
    fake.close = () => {
      closed = true;
    };
    const spy = vi.spyOn(fs, 'watch').mockReturnValue(fake as unknown as fs.FSWatcher);

    const errors: { dir: string; message: string }[] = [];
    try {
      dispose = watchEnvFiles({
        targets: [{ dir, filenames: ['.env'], onChange: () => {} }],
        onError: (d, e) => errors.push({ dir: d, message: e.message }),
      });
      // Would throw "Unhandled 'error' event" with no listener attached.
      expect(() =>
        fake.emit('error', new Error('EMFILE: too many open files, watch')),
      ).not.toThrow();
    } finally {
      spy.mockRestore();
    }

    expect(errors).toEqual([{ dir, message: 'EMFILE: too many open files, watch' }]);
    expect(closed).toBe(true);
  });

  describe.skipIf(process.platform === 'win32')('a read that does not return', () => {
    // A read of a watched file can block for as long as something outside stackctl decides:
    // macOS holds a read of a File Provider folder (Dropbox, iCloud) until the user answers
    // its "would like to access files in Dropbox" prompt, and a file not yet downloaded blocks
    // until it is. A FIFO with no writer stands in for that: opening it blocks until one opens.
    // Made on the event loop's thread, such a read stops the session answering its control API
    // and reading its children's output until it returns. The watcher runs in a child process:
    // a read blocking this thread would block this test's own timeout too.
    const children: ChildProcess[] = [];
    afterEach(() => {
      for (const child of children.splice(0)) {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          process.kill(child.pid, 'SIGKILL');
        }
      }
    });

    /** Starts the watcher on `ws` in a child, behind a small HTTP server; resolves its port. */
    async function startWatcher(ws: string): Promise<number> {
      const script = path.join(dir, 'watcher.ts');
      // Node runs the source as it is, but finds `./x.js` only as `x.js`: point it at `x.ts`.
      const hook = path.join(dir, 'ts-imports.mjs');
      fs.writeFileSync(
        hook,
        `
import fs from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (fs.existsSync(ts)) {
        return next(ts.href, context);
      }
    }
    return next(specifier, context);
  },
});
`,
      );
      fs.writeFileSync(
        script,
        `
import fs from 'node:fs';
import http from 'node:http';
const { watchEnvFiles } = await import(process.argv[2]);
const ws = process.argv[3];
let changes = 0;
watchEnvFiles({
  targets: [{ dir: ws, filenames: ['.env', '.env.local'], onChange: () => changes++ }],
  debounceMs: 20,
});
http
  .createServer(async (req, res) => {
    if (req.url === '/fs') {
      // An unrelated read through the thread pool, as a DNS lookup or a log write would.
      await fs.promises.readFile(new URL(process.argv[2]));
    }
    if (req.url === '/exit') {
      res.end();
      process.exit(0);
    }
    res.end(String(changes));
  })
  .listen(0, '127.0.0.1', function () {
    console.log(this.address().port);
  });
`,
      );
      const child = spawn(
        process.execPath,
        ['--import', hook, script, new URL('./env-watch.ts', import.meta.url).href, ws],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      children.push(child);
      const line = await Promise.race([
        once(child.stdout!, 'data').then(([data]) => (data as Buffer).toString()),
        once(child, 'exit').then(([code]) => {
          throw new Error(`the watcher exited (${String(code)}) before it listened`);
        }),
      ]);
      return Number(line.trim());
    }

    /** What the watcher's server answers on `url`, or null when it doesn't within `ms`. */
    async function ask(port: number, url = '/', ms = 1000): Promise<string | null> {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
          signal: AbortSignal.timeout(ms),
        });
        return await res.text();
      } catch {
        return null;
      }
    }

    test('keeps the process answering while a watched file cannot be read', async () => {
      const ws = path.join(dir, 'ws');
      const store = path.join(dir, 'store');
      fs.mkdirSync(ws);
      fs.mkdirSync(store);
      fs.writeFileSync(path.join(ws, '.env'), 'A=1\n');
      fs.writeFileSync(path.join(store, '.env.local'), 'B=1\n');
      fs.symlinkSync('../store/.env.local', path.join(ws, '.env.local'));
      const port = await startWatcher(ws);
      await wait(200);
      expect(await ask(port)).toBe('0');

      // The linked file now blocks every read, and the workspace's own `.env` changes.
      fs.rmSync(path.join(store, '.env.local'));
      execFileSync('mkfifo', [path.join(store, '.env.local')]);
      fs.writeFileSync(path.join(ws, '.env'), 'A=2\n');
      await wait(200);
      expect(await ask(port)).toBe('0');

      // Every further change while the read is stuck: none of them may take another thread
      // with it, or the pool runs out and every other async read in the process waits too.
      for (let i = 3; i < 10; i++) {
        fs.writeFileSync(path.join(ws, '.env'), `A=${String(i)}\n`);
        await wait(60);
      }
      expect(await ask(port, '/fs')).toBe('0');

      // Once the read returns, the change it was checking for is reported.
      const writer = spawn('sh', ['-c', 'printf "B=2\\n" > "$1"', 'sh', path.join(store, '.env.local')]); // oxfmt-ignore
      children.push(writer);
      await once(writer, 'exit');
      const deadline = Date.now() + 2000;
      let answer = await ask(port);
      while (answer === '0' && Date.now() < deadline) {
        await wait(20);
        answer = await ask(port);
      }
      expect(answer).toBe('1');
    }, 20_000);

    test('lets the process exit while a watched file cannot be read', async () => {
      // A read stuck on the thread pool would hold `process.exit` until it returned.
      const ws = path.join(dir, 'ws');
      fs.mkdirSync(ws);
      fs.writeFileSync(path.join(ws, '.env'), 'A=1\n');
      execFileSync('mkfifo', [path.join(ws, '.env.local')]);
      const port = await startWatcher(ws);
      fs.writeFileSync(path.join(ws, '.env'), 'A=2\n');
      await wait(200);
      const child = children.at(-1)!;
      const exited = once(child, 'exit');
      await ask(port, '/exit');
      const ended = await Promise.race([exited.then(() => true), wait(3000).then(() => false)]);
      expect(ended).toBe(true);
    }, 20_000);
  });

  describe('a watched file that is a symlink', () => {
    // Writing through a link changes only the file it points to, so the link's own directory sees
    // no event. Personal env files kept in a synced folder and linked into the repo hit exactly
    // this: `.env.local -> .local/env/.env.local`, with `.local` itself a link to that folder.
    let ws: string;
    beforeEach(() => {
      ws = path.join(dir, 'ws');
      fs.mkdirSync(ws);
    });

    // A newly opened watch takes a moment to go live, and FSEvents reports writes made just before
    // it started (each case's setup) shortly after it does. Let both pass before counting.
    const settle = () => wait(200);
    async function watchWs(filenames = ['.env.local']): Promise<{ calls: number }> {
      const counter = { calls: 0 };
      dispose = watchEnvFiles({
        targets: [{ dir: ws, filenames, onChange: () => counter.calls++ }],
        debounceMs: 40,
      });
      await settle();
      counter.calls = 0;
      return counter;
    }

    test('fires when the file it points to is edited through the link', async () => {
      fs.mkdirSync(path.join(dir, 'real'));
      fs.writeFileSync(path.join(dir, 'real', '.env.local'), 'A=1\n');
      fs.symlinkSync('../real/.env.local', path.join(ws, '.env.local'));
      const counter = await watchWs();

      fs.appendFileSync(path.join(ws, '.env.local'), 'B=2\n');
      await waitFor(() => counter.calls >= 1);
      expect(counter.calls).toBe(1);
    });

    test('fires for a link reached through a symlinked directory', async () => {
      fs.mkdirSync(path.join(dir, 'synced', 'env'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'synced', 'env', '.env.local'), 'A=1\n');
      fs.symlinkSync('../synced', path.join(ws, '.local'));
      fs.symlinkSync('.local/env/.env.local', path.join(ws, '.env.local'));
      const counter = await watchWs();

      fs.appendFileSync(path.join(ws, '.env.local'), 'B=2\n');
      await waitFor(() => counter.calls >= 1);
      expect(counter.calls).toBe(1);
    });

    test('ignores files in the linked directory that no watched name points to', async () => {
      fs.mkdirSync(path.join(dir, 'real'));
      fs.writeFileSync(path.join(dir, 'real', '.env.local'), 'A=1\n');
      fs.symlinkSync('../real/.env.local', path.join(ws, '.env.local'));
      const counter = await watchWs(['.env.local', '.env']);

      // `.env` is a watched name, but the one in `ws` doesn't exist: nothing points at this file.
      fs.writeFileSync(path.join(dir, 'real', '.env'), 'X=1\n');
      await wait(150);
      expect(counter.calls).toBe(0);
    });

    test('follows the link when it is repointed', async () => {
      fs.mkdirSync(path.join(dir, 'old'));
      fs.mkdirSync(path.join(dir, 'new'));
      fs.writeFileSync(path.join(dir, 'old', '.env.local'), 'A=1\n');
      fs.writeFileSync(path.join(dir, 'new', '.env.local'), 'A=2\n');
      const link = path.join(ws, '.env.local');
      fs.symlinkSync('../old/.env.local', link);
      const counter = await watchWs();

      // Repointing the link changes what the file reads as, so it fires on its own.
      fs.unlinkSync(link);
      fs.symlinkSync('../new/.env.local', link);
      await waitFor(() => counter.calls >= 1);
      expect(counter.calls).toBe(1);
      await settle();
      counter.calls = 0;

      fs.appendFileSync(path.join(dir, 'new', '.env.local'), 'B=2\n');
      await waitFor(() => counter.calls >= 1);
      expect(counter.calls).toBe(1);

      fs.appendFileSync(path.join(dir, 'old', '.env.local'), 'B=2\n');
      await wait(150);
      expect(counter.calls).toBe(1);
    });
  });
});
