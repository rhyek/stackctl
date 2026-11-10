import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * What reading one `.env` file came to. `real` is the path a symlink resolves to, through any
 * chain of links and linked directories; absent when the path isn't a link, or a dangling one.
 */
export type EnvFileRead = (
  | { kind: 'text'; text: string }
  /** No such file, or a path through something that isn't a directory. */
  | { kind: 'missing' }
  /** Any other failure, by its error code: the file is there but couldn't be read. */
  | { kind: 'error'; code: string }
) & { real?: string };

/**
 * Reads its argv's files in order, one JSON line each on fd 1, after a line naming the file it
 * is about to read. Written with `writeSync`: on macOS a write to a pipe is otherwise
 * asynchronous, and a read that doesn't return would keep its "reading" line from ever leaving.
 */
const READER_SCRIPT = `
import fs from 'node:fs';
const say = (line) => fs.writeSync(1, JSON.stringify(line) + '\\n');
for (const file of process.argv.slice(1)) {
  say({ reading: file });
  let real;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) real = fs.realpathSync(file);
  } catch {}
  try {
    say({ file, real, text: fs.readFileSync(file, 'utf8') });
  } catch (error) {
    say(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? { file, real, missing: true } : { file, real, error: String(error.code) });
  }
}
`;

/** Readers still running, killed as the process exits: see {@link readEnvFiles}. */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function killLiveReaders(): void {
  for (const child of live) {
    child.kill('SIGKILL');
  }
  live.clear();
}

/** A read of some `.env` files under way: see {@link readEnvFiles}. */
export interface EnvFilesReading {
  /** Each file's result, settling once every file has been read or the read was cancelled. */
  done: Promise<Map<string, EnvFileRead>>;
  /** Stops the read: `done` settles with whatever was read so far. */
  cancel(): void;
}

/**
 * Reads `files`, in order, in a child process, calling `onReading` with each one as its read
 * begins.
 *
 * A read can block for as long as something else decides: macOS holds a read of a File Provider
 * folder (Dropbox, iCloud) until the user answers its prompt to allow access, which can be hours.
 * Read on the event loop's thread, it stops the process answering anything, signals included.
 * Read on libuv's thread pool, it lets the process run, but not end: a process exits only once
 * every thread of the pool is done, so it couldn't stop until the read returned. A child process
 * blocked on a read is killed like any other, so this process stays free to go on and to stop. A
 * reader still running as this process exits is killed with it.
 *
 * Should the child fail to start, or stop before reading every file, the files it didn't get to
 * are read here instead, asynchronously.
 */
export function readEnvFiles(
  files: string[],
  onReading: (file: string) => void = () => {},
): EnvFilesReading {
  const results = new Map<string, EnvFileRead>();
  if (files.length === 0) {
    return { done: Promise.resolve(results), cancel: () => {} };
  }
  // The reader runs no preload of the user's: a `NODE_OPTIONS` `--import` would only slow it.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ['--input-type=module', '-e', READER_SCRIPT, ...files], {
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  live.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', killLiveReaders);
  }
  let cancelled = false;

  let pending = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = JSON.parse(pending.slice(0, newline)) as
        | { reading: string }
        | { file: string; real?: string; text?: string; missing?: true; error?: string };
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
      if ('reading' in line) {
        onReading(line.reading);
      } else {
        const real = line.real === undefined ? {} : { real: line.real };
        if (line.text !== undefined) {
          results.set(line.file, { kind: 'text', text: line.text, ...real });
        } else if (line.missing) {
          results.set(line.file, { kind: 'missing', ...real });
        } else {
          results.set(line.file, { kind: 'error', code: line.error ?? 'UNKNOWN', ...real });
        }
      }
    }
  });

  const done = new Promise<Map<string, EnvFileRead>>((resolve) => {
    let settled = false;
    const settle = async () => {
      if (settled) {
        return;
      }
      settled = true;
      live.delete(child);
      if (!cancelled) {
        for (const file of files.filter((f) => !results.has(f))) {
          onReading(file);
          results.set(file, await readInProcess(file));
        }
      }
      resolve(results);
    };
    child.on('error', () => void settle());
    // 'close', not 'exit': the last lines may still be in the pipe when the process exits.
    child.on('close', () => void settle());
  });

  return {
    done,
    cancel: () => {
      cancelled = true;
      child.kill('SIGKILL');
    },
  };
}

async function readInProcess(file: string): Promise<EnvFileRead> {
  let real: { real?: string } = {};
  try {
    if ((await fs.promises.lstat(file)).isSymbolicLink()) {
      real = { real: await fs.promises.realpath(file) };
    }
  } catch {
    /* not a link, or a dangling one */
  }
  try {
    return { kind: 'text', text: await fs.promises.readFile(file, 'utf8'), ...real };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { kind: 'missing', ...real }
      : { kind: 'error', code, ...real };
  }
}

/** A read {@link readEnvFilesSync} gave up on. */
export class EnvFileReadTimeout extends Error {
  /** The file being read when time ran out. */
  readonly file: string;

  constructor(file: string, timeoutMs: number) {
    super(
      `couldn't read ${file} within ${String(timeoutMs / 1000)}s. If it is in a synced folder (Dropbox, iCloud), macOS may be waiting for you to allow access to it.`,
    );
    this.file = file;
  }
}

/**
 * {@link readEnvFiles}, for a caller that must have the files before it can go on: the same child
 * process, waited on for at most `timeoutMs`. A read that doesn't return by then is killed with it,
 * and throws {@link EnvFileReadTimeout} naming the file, rather than holding the caller as long as
 * the read would.
 */
export function readEnvFilesSync(files: string[], timeoutMs: number): Map<string, EnvFileRead> {
  const results = new Map<string, EnvFileRead>();
  if (files.length === 0) {
    return results;
  }
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', READER_SCRIPT, ...files],
    {
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );
  let reading: string | undefined;
  for (const raw of (child.stdout ?? '').split('\n')) {
    if (!raw) {
      continue;
    }
    const line = JSON.parse(raw) as
      | { reading: string }
      | { file: string; real?: string; text?: string; missing?: true; error?: string };
    if ('reading' in line) {
      reading = line.reading;
      continue;
    }
    reading = undefined;
    const real = line.real === undefined ? {} : { real: line.real };
    results.set(
      line.file,
      line.text !== undefined
        ? { kind: 'text', text: line.text, ...real }
        : line.missing
          ? { kind: 'missing', ...real }
          : { kind: 'error', code: line.error ?? 'UNKNOWN', ...real },
    );
  }
  if (reading !== undefined && child.error) {
    throw new EnvFileReadTimeout(reading, timeoutMs);
  }
  if (child.error) {
    throw child.error;
  }
  return results;
}
