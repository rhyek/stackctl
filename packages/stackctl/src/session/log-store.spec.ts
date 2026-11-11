import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { LINE_OVERHEAD_BYTES, LogStore, lineBytes } from './log-store.js';
import type { LogFilter, LogLine } from './types.js';

let dir: string;
let store: LogStore | undefined;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-log-store-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  await store?.close();
  store = undefined;
});

let files = 0;

function newStore(maxBytes?: number): LogStore {
  store = new LogStore({ logFile: path.join(dir, `session-${String(files++)}.log`), maxBytes });
  return store;
}

const TS = '2026-09-06 08:00:00';
const ESC = String.fromCharCode(27);
// Raw SGR sequences, colored whatever chalk's level is under the test runner.
const red = (text: string) => `${ESC}[31m${text}${ESC}[39m`;
const gray = `${ESC}[90m`;

/** A line of service `name`'s output, or of stackctl's own (`null`). */
function line(text: string, opts: Partial<Omit<LogLine, 'id'>> = {}): Omit<LogLine, 'id'> {
  const service = opts.service === undefined ? 'web' : opts.service;
  return {
    service,
    text,
    isError: false,
    at: Date.now(),
    ts: TS,
    showTs: true,
    label: { name: service ?? 'stackctl' },
    filterKey: service ?? 'system',
    ...opts,
  };
}

function texts(s: LogStore): string[] {
  return s.getVisibleLines().map((l) => l.text);
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('subscription', () => {
  test('appends in one tick bump the version once', async () => {
    const s = newStore();
    const listener = vi.fn();
    s.subscribe(listener);
    const before = s.getVersion();
    for (let i = 0; i < 300; i++) {
      s.append(line(`line ${String(i)}`));
    }
    expect(listener).not.toHaveBeenCalled();
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    // The version bumps synchronously on every append (runtime §3.7.1), so the one notification
    // finds it already at its latest; it changes only with the buffer.
    expect(s.getVersion()).toBe(before + 300);
    expect(s.getVersion()).toBe(before + 300);
    s.append(line('one more'));
    expect(s.getVersion()).toBe(before + 301);
  });

  test('a listener that throws is skipped over: the next is still told, and nothing escapes', async () => {
    const s = newStore();
    const throwing = vi.fn(() => {
      throw new Error('printer fault');
    });
    const next = vi.fn();
    s.subscribe(throwing);
    s.subscribe(next);
    s.append(line('one'));
    // Past the notifying microtask: an unguarded throw there is an uncaught error, which fails the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('an unsubscribed listener is not called', async () => {
    const s = newStore();
    const listener = vi.fn();
    s.subscribe(listener)();
    s.append(line('x'));
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  test('returns the same array for one version', () => {
    const s = newStore();
    s.append(line('a'));
    s.applyFilter({ text: 'a' });
    expect(s.getVisibleLines()).toBe(s.getVisibleLines());
  });

  test('a hidden line still bumps the version', () => {
    const s = newStore();
    s.applyFilter({ text: 'nothing-matches-this' });
    const before = s.getVersion();
    s.append(line('hidden'));
    expect(texts(s)).toEqual([]);
    expect(s.getVersion()).toBeGreaterThan(before);
  });
});

describe('the buffer', () => {
  test('evicts oldest lines past maxBytes', () => {
    const text = 'x'.repeat(100);
    const cost = text.length * 2 + LINE_OVERHEAD_BYTES;
    const s = newStore(cost * 10);
    for (let i = 0; i < 25; i++) {
      s.append(line(`${text.slice(String(i).length)}${String(i)}`));
    }
    const kept = s.getVisibleLines();
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThanOrEqual(10);
    expect(kept.reduce((sum, l) => sum + lineBytes(l), 0)).toBeLessThanOrEqual(cost * 10);
    // The newest stay, in order, with no gap.
    expect(kept.at(-1)!.text.endsWith('24')).toBe(true);
    const ids = kept.map((l) => l.id);
    expect(ids).toEqual(ids.map((_, i) => ids[0]! + i));
  });

  test('counts each line as its text in UTF-16 code units × 2 plus the overhead', () => {
    const s = newStore();
    s.append(line('héllo 🚀'));
    expect(lineBytes(s.getVisibleLines()[0]!)).toBe('héllo 🚀'.length * 2 + LINE_OVERHEAD_BYTES);
  });

  test('keeps the newest line even when it alone is over budget', () => {
    const s = newStore(10);
    s.append(line('first'));
    s.append(line('second'));
    expect(texts(s)).toEqual(['second']);
  });

  test('expands tabs on screen and keeps them in the logfile', () => {
    const s = newStore();
    s.append(line('a\tb'));
    expect(texts(s)).toEqual(['a       b']);
    expect(fs.readFileSync(s.getLogFile(), 'utf8')).toBe(`${TS} [web] a\tb\n`);
  });

  test('numbers lines in append order', () => {
    const s = newStore();
    s.append(line('a'));
    s.append(line('b'));
    const [a, b] = s.getVisibleLines();
    expect(b!.id).toBeGreaterThan(a!.id);
  });

  test('clear drops every line, not the logfile, and bumps the version', () => {
    const s = newStore();
    s.append(line('before'));
    const before = s.getVersion();
    s.clear();
    expect(texts(s)).toEqual([]);
    expect(s.getVersion()).toBeGreaterThan(before);
    s.append(line('after'));
    expect(texts(s)).toEqual(['after']);
    expect(fs.readFileSync(s.getLogFile(), 'utf8')).toBe(`${TS} [web] before\n${TS} [web] after\n`);
  });

  test('clear forgets the open entries, so the next line starts a new one', () => {
    const s = newStore();
    s.append(line('[INFO] header'));
    s.clear();
    s.append(line('  key: value'));
    s.applyFilter({ text: 'header' });
    expect(texts(s)).toEqual([]);
  });
});

describe('the logfile', () => {
  test('writes the stamp, the label padded to the width so far and the text, colors stripped', () => {
    const s = newStore();
    s.addLabels(['web', 'worker']);
    s.append(line(red('boom'), { label: { name: 'web', paint: red }, isError: true }));
    s.addLabels(['billing-worker']);
    s.append(line('up', { label: { name: 'web' } }));
    expect(fs.readFileSync(s.getLogFile(), 'utf8')).toBe(
      `${TS} [web   ] boom\n${TS} [web           ] up\n`,
    );
  });

  test('always timestamps the on-disk log file, even with the on-screen option off', () => {
    const s = newStore();
    s.append(line('to disk', { showTs: false }));
    expect(fs.readFileSync(s.getLogFile(), 'utf8')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[/m,
    );
  });

  test('logfile gets every line even when the buffer evicts', () => {
    const s = newStore(1);
    s.applyFilter({ text: 'shown' });
    for (let i = 0; i < 5; i++) {
      s.append(line(`line ${String(i)}`));
    }
    expect(texts(s)).toEqual([]);
    const written = fs.readFileSync(s.getLogFile(), 'utf8').trimEnd().split('\n');
    expect(written).toEqual([0, 1, 2, 3, 4].map((i) => `${TS} [web] line ${String(i)}`));
  });

  test('writes nothing once closed', async () => {
    const s = newStore();
    s.append(line('before'));
    await s.close();
    s.append(line('after'));
    expect(fs.readFileSync(s.getLogFile(), 'utf8')).toBe(`${TS} [web] before\n`);
  });
});

describe('the filter', () => {
  test('filter hides non-matching lines and bumps the version', () => {
    const s = newStore();
    s.append(line('GET /health'));
    s.append(line('POST /todos'));
    const before = s.getVersion();
    s.applyFilter({ text: 'todos' });
    expect(texts(s)).toEqual(['POST /todos']);
    expect(s.getVersion()).toBeGreaterThan(before);
  });

  test('clearing the filter shows every buffered line again', () => {
    const s = newStore();
    s.append(line('a'));
    s.append(line('b'));
    s.applyFilter({ text: 'a' });
    s.applyFilter(null);
    expect(texts(s)).toEqual(['a', 'b']);
    s.applyFilter({ text: '  ' });
    expect(texts(s)).toEqual(['a', 'b']);
  });

  test('every term must match, in any order', () => {
    const s = newStore();
    s.append(line('added todo item'));
    s.append(line('added user'));
    s.applyFilter({ text: 'item  added' });
    expect(texts(s)).toEqual(['added todo item']);
  });

  test('matches case- and accent-insensitively both ways', () => {
    const s = newStore();
    s.append(line('Málaga'));
    s.append(line('Malaga'));
    s.append(line('Added TODO item'));
    s.applyFilter({ text: 'malaga' });
    expect(texts(s)).toEqual(['Málaga', 'Malaga']);
    s.applyFilter({ text: 'málaga' });
    expect(texts(s)).toEqual(['Málaga', 'Malaga']);
    s.applyFilter({ text: 'added todo' });
    expect(texts(s)).toEqual(['Added TODO item']);
  });

  test('matches the filter key as well as the text', () => {
    const s = newStore();
    s.append(line('listening', { service: 'api' }));
    s.append(line('[INFO] shutting down', { service: null }));
    s.append(line('ready', { service: 'web' }));
    s.applyFilter({ text: 'api' });
    expect(texts(s)).toEqual(['listening']);
    s.applyFilter({ text: 'system' });
    expect(texts(s)).toEqual(['[INFO] shutting down']);
    s.applyFilter({ text: 'stackctl' });
    expect(texts(s)).toEqual([]);
  });

  test('gives error lines no special treatment', () => {
    const s = newStore();
    s.append(line('boom', { isError: true }));
    s.append(line('error: not found'));
    s.applyFilter({ text: 'error' });
    expect(texts(s)).toEqual(['error: not found']);
  });

  test('shows an entry whole when any of its lines matches', () => {
    const s = newStore();
    s.append(line('[INFO] request', { continues: false }));
    s.append(line('  path: /todos', { continues: true }));
    s.append(line('[INFO] other'));
    s.applyFilter({ text: 'todos' });
    expect(texts(s)).toEqual(['[INFO] request', '  path: /todos']);
    s.applyFilter({ text: 'request' });
    expect(texts(s)).toEqual(['[INFO] request', '  path: /todos']);
  });

  test("another key's lines interleaving don't break an entry up", () => {
    const s = newStore();
    s.append(line('[INFO] request'));
    s.append(line('noise', { service: 'api' }));
    s.append(line('  path: /todos'));
    s.applyFilter({ text: 'request' });
    expect(texts(s)).toEqual(['[INFO] request', '  path: /todos']);
  });

  test('an indented line continues its key’s entry; colors before the indent are skipped', () => {
    const s = newStore();
    s.append(line('[INFO] request'));
    s.append(line(`${gray}\tat handler`));
    s.append(line('next'));
    s.applyFilter({ text: 'request' });
    expect(texts(s)).toEqual(['[INFO] request', `${gray}        at handler`]);
  });

  test('an indented line with no entry of its key before it starts one', () => {
    const s = newStore();
    s.append(line('[INFO] request', { service: 'api' }));
    s.append(line('  path: /todos'));
    s.applyFilter({ text: 'path' });
    expect(texts(s)).toEqual(['  path: /todos']);
  });

  test('a structured result groups unindented lines too', () => {
    const s = newStore();
    s.append(line('first', { continues: false }));
    s.append(line('second', { continues: true }));
    s.applyFilter({ text: 'second' });
    expect(texts(s)).toEqual(['first', 'second']);
  });

  test('a line arriving under a filter is shown or hidden with its entry', () => {
    const s = newStore();
    s.applyFilter({ text: 'todos' });
    s.append(line('[INFO] request'));
    s.append(line('ready', { service: 'api' }));
    expect(texts(s)).toEqual([]);
    // The match comes on the entry's second line: the first is shown with it, in buffer order.
    s.append(line('  path: /todos'));
    expect(texts(s)).toEqual(['[INFO] request', '  path: /todos']);
    s.append(line('  status: 200'));
    expect(texts(s)).toEqual(['[INFO] request', '  path: /todos', '  status: 200']);
    s.append(line('[INFO] another'));
    expect(texts(s)).toHaveLength(3);
  });

  test('a revealed entry merges in buffer order around lines already shown', () => {
    const s = newStore();
    s.applyFilter({ text: 'todos' });
    s.append(line('[INFO] request', { service: 'web' }));
    s.append(line('GET /todos', { service: 'api' }));
    s.append(line('  path: /todos', { service: 'web' }));
    expect(texts(s)).toEqual(['[INFO] request', 'GET /todos', '  path: /todos']);
  });

  test('narrows to one service without changing what the text matches', () => {
    const s = newStore();
    s.append(line('GET /todos', { service: 'api' }));
    s.append(line('GET /todos', { service: 'web' }));
    s.append(line('ready', { service: 'web' }));
    s.applyFilter({ text: 'todos', service: 'web' });
    expect(s.getVisibleLines().map((l) => l.service)).toEqual(['web']);
    s.applyFilter({ text: '', service: 'web' });
    expect(texts(s)).toEqual(['GET /todos', 'ready']);
    s.applyFilter({ text: 'todos' });
    expect(texts(s)).toEqual(['GET /todos', 'GET /todos']);
  });

  test('evicting under a filter drops the oldest shown lines too', () => {
    const cost = 2 + LINE_OVERHEAD_BYTES;
    const s = newStore(cost * 4);
    s.applyFilter({ text: 'a' });
    for (let i = 0; i < 12; i++) {
      s.append(line(i % 2 === 0 ? 'a' : 'b'));
    }
    const all = s.getVisibleLines();
    expect(all.every((l) => l.text === 'a')).toBe(true);
    s.applyFilter(null);
    const buffered = s.getVisibleLines();
    expect(all[0]!.id).toBeGreaterThanOrEqual(buffered[0]!.id);
    expect(buffered.filter((l) => l.text === 'a')).toEqual(all);
  });
});

describe('the filter after eviction', () => {
  /** The visible lines now, and after the same filter is applied afresh: they must agree. */
  function bothWays(s: LogStore, filter: LogFilter): [string[], string[]] {
    const incremental = texts(s);
    s.applyFilter(filter);
    return [incremental, texts(s)];
  }

  const cost = (text: string) => text.length * 2 + LINE_OVERHEAD_BYTES;

  test('hides the rest of an entry once its matching line is evicted', () => {
    const s = newStore(cost('  k0: v') * 3);
    s.applyFilter({ text: 'request' });
    s.append(line('[INFO] request'));
    for (let i = 0; i < 5; i++) {
      s.append(line(`  k${String(i)}: v`));
    }
    const [incremental, afresh] = bothWays(s, { text: 'request' });
    expect(incremental).toEqual([]);
    expect(afresh).toEqual([]);
  });

  test('keeps an entry shown while a matching line of it is still buffered', () => {
    const s = newStore(cost('  k0: v') * 3);
    s.applyFilter({ text: 'request' });
    s.append(line('[INFO] header'));
    s.append(line('  k0: v'));
    s.append(line('  request: 1'));
    s.append(line('  k1: v'));
    const [incremental, afresh] = bothWays(s, { text: 'request' });
    expect(incremental).toEqual(['  request: 1', '  k1: v']);
    expect(afresh).toEqual(incremental);
  });

  test('a continuation whose entry was evicted is judged with that entry’s buffered lines', () => {
    const s = newStore(cost('  k0: v') * 3);
    s.append(line('[INFO] request'));
    s.append(line('  k0: v'));
    s.append(line('  k1: v'));
    s.append(line('  k2: v'));
    // The header went when `  k1` arrived: the entry's buffered lines are `k0` to `k2`.
    s.applyFilter({ text: 'k2' });
    expect(texts(s)).toEqual(['  k0: v', '  k1: v', '  k2: v']);
    s.append(line('  k3: v'));
    const [incremental, afresh] = bothWays(s, { text: 'k2' });
    expect(incremental).toEqual(['  k2: v', '  k3: v']);
    expect(afresh).toEqual(incremental);
  });
});

describe('layout through the store', () => {
  test('countRows and wrapLineRows agree', () => {
    const s = newStore();
    s.append(line(`x${' word'.repeat(60)}`));
    const [l] = s.getVisibleLines();
    expect(s.countRows(l!, 80, 'date')).toBe(s.wrapLineRows(l!, 80, 'date').length);
    expect(s.countRows(l!, 80, 'date')).toBeGreaterThan(1);
  });
});
