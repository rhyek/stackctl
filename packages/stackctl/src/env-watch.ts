import fs from 'node:fs';
import path from 'node:path';
import { type EnvFileRead, type EnvFilesReading, readEnvFiles } from './env-file-reader.js';

export interface WatchTarget {
  /** Directory to watch (non-recursive). */
  dir: string;
  /** Basenames within `dir` whose create/change/remove should fire `onChange`. */
  filenames: string[];
  /** Fired (debounced) when any watched file in `dir` changes. */
  onChange: () => void;
}

/** Stops every watcher when called. */
export interface EnvWatch {
  (): void;
  /**
   * Settles once what every watched file starts as has been read: a change from then on fires.
   * Reads are asynchronous, so one made just after {@link watchEnvFiles} returns may land before.
   */
  ready: Promise<void>;
}

/** Reports a watcher that had to be abandoned, so the session can say so instead of dying. */
export type WatchErrorHandler = (dir: string, error: Error) => void;

/**
 * Watches a set of directories for changes to specific `.env` filenames and fires each
 * target's `onChange` (debounced) when one of its files is created, edited, or removed — that is,
 * when what one of them reads as differs from the last time it fired (or from the start).
 * Watching directories — rather than the files themselves — means files that don't exist
 * yet are still picked up when they appear. Best-effort: a directory that can't be watched
 * (e.g. it doesn't exist) is skipped silently. Returns a disposer that stops every watcher, and
 * says when the watch is {@link EnvWatch.ready}.
 *
 * A watched name that is a symlink is also followed to the file it resolves to (through chains
 * and symlinked parent directories), whose directory is watched for that one basename: writing
 * through a link changes only its target, so the link's own directory never hears about it. The
 * resolution is redone whenever the target fires, which is how a link that is created, removed or
 * repointed moves its watch along.
 *
 * "Best-effort" has to cover failures that arrive *after* a successful `fs.watch()` call, not just
 * the synchronous throw. The OS can fail a watcher later — most commonly `EMFILE` on macOS, where
 * the FSEvents budget is machine-wide, so an unrelated project's watch-heavy dev stack can knock
 * this one over. An `FSWatcher` with no `error` listener makes that an unhandled `'error'` event,
 * which takes the whole stackctl process down and every package with it. Losing `.env`
 * live-reload for one directory is a much better outcome than losing the session.
 */
export function watchEnvFiles(opts: {
  targets: WatchTarget[];
  debounceMs?: number;
  onError?: WatchErrorHandler;
}): EnvWatch {
  const debounceMs = opts.debounceMs ?? 250;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let disposed = false;

  // One watcher per real directory, shared by every target with a file there; each event is
  // dispatched by basename to whoever registered it.
  const dirs = new Map<string, { watcher: fs.FSWatcher; handlers: Map<string, Set<() => void>> }>();

  // `realDir` is `dir` with its links resolved, when the caller already has it.
  const subscribe = (
    dir: string,
    name: string,
    handler: () => void,
    realDir?: string,
  ): (() => void) | null => {
    const key = realDir ?? realpathOrSelfSync(dir);
    let entry = dirs.get(key);
    if (!entry) {
      const handlers = new Map<string, Set<() => void>>();
      let watcher: fs.FSWatcher;
      try {
        watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
          // `filename` can be null on some platforms; without it we can't tell which file
          // changed, so we don't fire (avoids restarting on unrelated activity in the dir).
          if (!filename) {
            return;
          }
          for (const h of handlers.get(filename.toString()) ?? []) {
            h();
          }
        });
      } catch {
        // best-effort: unwatchable directory (missing, permissions) is skipped.
        return null;
      }
      // Without this listener an async failure is an unhandled 'error' event, which is fatal to
      // the process. Drop just this watcher and keep the session running.
      watcher.on('error', (error: Error) => {
        try {
          watcher.close();
        } catch {
          /* already closed */
        }
        if (dirs.get(key)?.watcher === watcher) {
          dirs.delete(key);
        }
        opts.onError?.(dir, error);
      });
      entry = { watcher, handlers };
      dirs.set(key, entry);
    }
    const { watcher, handlers } = entry;
    let set = handlers.get(name);
    if (!set) {
      set = new Set();
      handlers.set(name, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        handlers.delete(name);
      }
      if (handlers.size === 0 && dirs.get(key)?.watcher === watcher) {
        dirs.delete(key);
        watcher.close();
      }
    };
  };

  // Every read of a watched file, its link included, is made by a reader process: a read can block
  // for as long as something else decides (macOS holds a read of a File Provider folder such as
  // Dropbox until the user answers its access prompt). On the event loop's thread that would stop
  // the session; on the thread pool it would keep the session from exiting until it returned.
  // The reads asked for in one turn of the loop share one reader: as the watch starts, every
  // target's.
  const readings = new Set<EnvFilesReading>();
  let batch: { files: Set<string>; done: Promise<Map<string, EnvFileRead>> } | null = null;
  const read = (files: string[]): Promise<Map<string, EnvFileRead>> => {
    if (!batch) {
      const next = { files: new Set<string>(), done: Promise.resolve(new Map<string, EnvFileRead>()) }; // oxfmt-ignore
      next.done = new Promise((resolve) => {
        queueMicrotask(() => {
          batch = null;
          const reading = readEnvFiles([...next.files]);
          readings.add(reading);
          void reading.done.then((results) => {
            readings.delete(reading);
            resolve(results);
          });
        });
      });
      batch = next;
    }
    for (const file of files) {
      batch.files.add(file);
    }
    return batch.done;
  };

  const ready: Promise<void>[] = [];
  for (const target of opts.targets) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Resolved link target → its unsubscribe. Kept across re-resolutions so an unchanged link keeps
    // its watcher: on macOS every new `fs.watch` rebuilds the process's FSEvents stream, and an
    // edit landing mid-rebuild is lost.
    let linkWatches = new Map<string, () => void>();

    const paths = target.filenames.map((name) => path.join(target.dir, name));

    // Watches the file each watched name that is a link resolves to, as `results` say.
    const followLinks = async (results: Map<string, EnvFileRead>) => {
      const realDir = await realpathOrSelf(target.dir);
      const next = new Map<string, () => void>();
      for (const [i, name] of target.filenames.entries()) {
        const real = results.get(paths[i]!)?.real;
        // Not a link, or a link back to this same file: the directory watch already covers it.
        if (disposed || !real || real === path.join(realDir, name) || next.has(real)) {
          continue;
        }
        // `real` is already resolved, and so is its directory: no need to resolve it again.
        const dir = path.dirname(real);
        const stop = linkWatches.get(real) ?? subscribe(dir, path.basename(real), fire, dir);
        if (stop) {
          next.set(real, stop);
        }
      }
      for (const [real, stop] of linkWatches) {
        if (!next.has(real)) {
          stop();
        }
      }
      linkWatches = next;
    };

    // What each watched name reads as (through any link), or null when it can't be read. An event
    // that leaves all of them as they were fires nothing: a sync client rewriting its extended
    // attributes, a bare `touch`, or FSEvents reporting writes from just before the watch began.
    const contentsOf = (results: Map<string, EnvFileRead>) =>
      paths.map((file) => {
        const result = results.get(file);
        return result?.kind === 'text' ? result.text : null;
      });
    // Null until the first check has read what the files start as.
    let seen: (string | null)[] | null = null;

    // Only one check runs at a time, so a read that doesn't return holds one reader, not one per
    // event. An event during a check runs one more check after it, however many events there were.
    let checking = false;
    let again = false;
    const check = async (): Promise<void> => {
      if (checking) {
        again = true;
        return;
      }
      checking = true;
      try {
        do {
          again = false;
          const results = await read(paths);
          if (disposed) {
            return;
          }
          await followLinks(results);
          const now = contentsOf(results);
          if (seen === null) {
            seen = now;
            continue;
          }
          if (now.every((content, i) => content === seen?.[i])) {
            continue;
          }
          seen = now;
          target.onChange();
        } while (again);
      } finally {
        checking = false;
      }
    };

    const fire = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) {
          void check();
        }
      }, debounceMs);
      timers.push(timer);
    };

    for (const name of target.filenames) {
      subscribe(target.dir, name, fire);
    }
    ready.push(check());
  }

  const dispose = () => {
    disposed = true;
    for (const reading of readings) {
      reading.cancel();
    }
    readings.clear();
    for (const { watcher } of dirs.values()) {
      watcher.close();
    }
    dirs.clear();
    for (const t of timers) {
      clearTimeout(t);
    }
  };
  return Object.assign(dispose, { ready: Promise.all(ready).then(() => {}) });
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return p;
  }
}

/**
 * {@link realpathOrSelf}, for a directory about to be watched: `fs.watch` resolves it the same way,
 * on this same thread.
 */
function realpathOrSelfSync(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
