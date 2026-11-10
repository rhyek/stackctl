import fs from 'node:fs';
import { stripAnsi } from '../format.js';
import { normalize } from '../tui/text-cells.js';
import { callEach } from '../util.js';
import { expandTabs } from '../wrap-rows.js';
import { countRows, wrapLineRows } from './log-layout.js';
import type { LogFilter, LogLine, TimestampMode, WrappedRow } from './types.js';

/** What the log viewport reads: the visible lines, their layout, and a change signal. */
export interface LogSource {
  subscribe(fn: () => void): () => void;
  getVersion(): number;
  getVisibleLines(): readonly LogLine[];
  countRows(line: LogLine, cols: number, mode: TimestampMode): number;
  wrapLineRows(line: LogLine, cols: number, mode: TimestampMode): WrappedRow[];
}

/**
 * The screen buffer's default budget, in the bytes {@link lineBytes} counts: about as many lines
 * as a 50,000-line cap holds at the example's typical length (27 characters, the mean of its
 * logfiles: 382 bytes a line). 18 MiB holds about 49,400 such lines, 33,200 of 120 characters and
 * 16,700 of 400.
 *
 * Measured in the run screen at 61×166 once a flood had filled it (Node 26): a full buffer of
 * 27-character lines adds about 20 MB of live heap, and about 40 MB of footprint a minute later.
 * The line count also sets what each repaint costs, since the viewport counts every buffered
 * line's rows on each one: 6.5 ms of CPU a frame with an empty buffer, 13 ms with 49,000 lines,
 * 21 ms with 87,000. The repaint cost follows the line count, not the bytes: a full buffer of
 * 400-character lines (16,700) repaints in 7.7 ms.
 */
export const DEFAULT_LOG_BYTES = 18 * 1024 * 1024;

/**
 * What a line is charged beyond its text. It is a weight, calibrated against measurement rather
 * than an itemized size. Measured on Node 26: 50,000 ASCII lines, heap after GC, each line
 * counted at 166 columns in both layouts, as the viewport counts every buffered line.
 *
 * - A buffered line costs about 200 bytes plus its text at one byte a character: V8 stores ASCII
 *   in one byte, so the charge's second byte a character pays for the row copy below.
 * - Counting its rows adds about 210 bytes.
 * - Once it is drawn, the rows it keeps (gutter plus text) add about 280 bytes for a one-row line,
 *   and about 1,600 for a 400-character line wrapped to four rows.
 *
 * A 27-character line is charged 382 bytes and costs 438 bytes, or 719 once drawn. A
 * 400-character line is charged 1,128 bytes and costs 806, or 2,402 drawn. So a full buffer of
 * long lines costs about 1.1 times a full buffer of typical ones when every line has been drawn
 * (the rows are what make up the difference), and about 0.6 times when few have, as after a
 * flood. Text that isn't ASCII, which V8 stores at two bytes a character, is charged at its size.
 */
export const LINE_OVERHEAD_BYTES = 328;

/**
 * How far below the budget an eviction goes: a 64th of it. Dropping lines one at a time would move
 * the whole buffer's array on every append once it is full; dropping a slice at a time does it
 * once per few thousand lines.
 */
const EVICTION_SLACK = 64;

/** A line's cost against the budget: its text in UTF-16 code units × 2, plus the overhead. */
export function lineBytes(line: LogLine): number {
  return line.text.length * 2 + LINE_OVERHEAD_BYTES;
}

// Text that starts with a space or a tab once its leading colors are skipped.
// oxlint-disable-next-line no-control-regex -- skips leading ANSI SGR sequences
const INDENTED = /^(?:\x1b\[[0-9;]*m)*[ \t]/;

/**
 * The lines of one filter key that the filter shows or hides together. Only its buffered lines
 * count: once the lines that matched are evicted, the rest of the entry is hidden, exactly as a
 * filter applied afresh would judge it.
 */
interface Entry {
  /** The id of its first line, which may since have been evicted. */
  startId: number;
  /** How many of its buffered lines match the current filter; shown when above zero. */
  matching: number;
}

interface ActiveFilter {
  terms: string[];
  service: string | undefined;
}

/**
 * The session's log: one buffer of every line, bounded by a byte budget, the filter over it, and
 * the logfile every line is written to. Listeners hear of changes once per microtask.
 *
 * Line ids are consecutive, and lines leave the buffer only from its front (eviction) or all at
 * once (`clear`), so a buffered line's index is its id minus the first buffered line's id.
 */
export class LogStore implements LogSource {
  private readonly maxBytes: number;
  private logFile: string;
  private fd: number | null;
  private lines: LogLine[] = [];
  /** Each buffered line's entry, by index into `lines`. */
  private entryOf: Entry[] = [];
  /** The lines the filter shows; `lines` itself while there is no filter. */
  private visible: LogLine[] = this.lines;
  private bytes = 0;
  private nextId = 0;
  private filter: ActiveFilter | null = null;
  /** Per filter key, the entry its next continuation joins. */
  private readonly entries = new Map<string, Entry>();
  private version = 0;
  private notifying = false;
  private readonly listeners = new Set<() => void>();

  constructor(opts: { logFile: string; maxBytes?: number }) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_LOG_BYTES;
    this.logFile = opts.logFile;
    this.fd = fs.openSync(this.logFile, 'w');
  }

  /**
   * Buffers a line and writes it to the logfile. The buffer gets the text with its tabs expanded;
   * the logfile gets it as it arrived, with the stamp and the label, colors stripped.
   */
  append(input: Omit<LogLine, 'id'>): void {
    const open = this.entries.get(input.filterKey);
    const continues = open !== undefined && (input.continues ?? INDENTED.test(input.text));
    const line: LogLine = {
      id: this.nextId++,
      service: input.service,
      text: expandTabs(input.text),
      isError: input.isError,
      at: input.at,
      ts: input.ts,
      showTs: input.showTs,
      label: input.label,
      filterKey: input.filterKey,
      continues,
    };
    this.write(`${line.ts} ${stripAnsi(line.label)} ${stripAnsi(input.text)}\n`);

    let entry = open;
    if (!continues || !entry) {
      entry = { startId: line.id, matching: 0 };
      this.entries.set(line.filterKey, entry);
    }
    this.lines.push(line);
    this.entryOf.push(entry);
    this.bytes += lineBytes(line);
    if (this.filter) {
      const wasShown = entry.matching > 0;
      if (this.matches(line, this.filter)) {
        entry.matching++;
      }
      if (wasShown) {
        this.visible.push(line);
      } else if (entry.matching > 0) {
        this.reveal(entry);
      }
    }
    this.evict();
    this.bump();
  }

  /** Shows only the lines `filter` matches, whole entries at a time; `null` shows every line. */
  applyFilter(filter: LogFilter | null): void {
    const terms = filter ? filter.text.split(/\s+/).filter(Boolean).map(normalize) : [];
    const service = filter?.service;
    this.filter = terms.length > 0 || service !== undefined ? { terms, service } : null;
    if (this.filter) {
      this.refilter(this.filter);
    } else {
      this.visible = this.lines;
    }
    this.bump();
  }

  /** Drops every buffered line and forgets the open entries. The logfile is untouched. */
  clear(): void {
    this.lines = [];
    this.entryOf = [];
    this.visible = this.filter ? [] : this.lines;
    this.bytes = 0;
    this.entries.clear();
    this.bump();
  }

  getLogFile(): string {
    return this.logFile;
  }

  /** Closes the logfile; nothing more is written to it. */
  async close(): Promise<void> {
    if (this.fd !== null) {
      const fd = this.fd;
      this.fd = null;
      await new Promise<void>((resolve) => fs.close(fd, () => resolve()));
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  getVersion(): number {
    return this.version;
  }

  getVisibleLines(): readonly LogLine[] {
    return this.visible;
  }

  countRows(line: LogLine, cols: number, mode: TimestampMode): number {
    return countRows(line, cols, mode);
  }

  wrapLineRows(line: LogLine, cols: number, mode: TimestampMode): WrappedRow[] {
    return wrapLineRows(line, cols, mode);
  }

  private write(text: string): void {
    if (this.fd === null) {
      return;
    }
    try {
      fs.writeSync(this.fd, text);
    } catch {
      // The logfile is a record of the screen, not the session's lifeline: a full disk or a
      // vanished volume must not take the session down with it.
    }
  }

  /**
   * Bumps the version now and tells the listeners once, after the current microtask. A listener
   * that throws is skipped over, so it never surfaces as an uncaught error that ends the session.
   */
  private bump(): void {
    this.version++;
    if (this.notifying) {
      return;
    }
    this.notifying = true;
    queueMicrotask(() => {
      this.notifying = false;
      callEach(this.listeners, undefined);
    });
  }

  private matches(line: LogLine, filter: ActiveFilter): boolean {
    if (filter.service !== undefined && line.service !== filter.service) {
      return false;
    }
    if (filter.terms.length === 0) {
      return true;
    }
    const haystack = normalize(`${line.filterKey} ${line.text}`);
    return filter.terms.every((term) => haystack.includes(term));
  }

  /**
   * Shows an entry the filter hid until its newest line matched: its buffered lines, merged into
   * the visible lines in buffer order.
   */
  private reveal(entry: Entry): void {
    const firstId = this.lines[0]!.id;
    const revealed: LogLine[] = [];
    for (let i = Math.max(0, entry.startId - firstId); i < this.lines.length; i++) {
      if (this.entryOf[i] === entry) {
        revealed.push(this.lines[i]!);
      }
    }
    const tail = this.visible.splice(firstAfter(this.visible, entry.startId - 1));
    let t = 0;
    for (const line of revealed) {
      while (t < tail.length && tail[t]!.id < line.id) {
        this.visible.push(tail[t++]!);
      }
      this.visible.push(line);
    }
    while (t < tail.length) {
      this.visible.push(tail[t++]!);
    }
  }

  /** Recomputes every entry's matching lines, and so the visible lines, for a new filter. */
  private refilter(filter: ActiveFilter): void {
    for (const entry of this.entries.values()) {
      entry.matching = 0;
    }
    for (const entry of this.entryOf) {
      entry.matching = 0;
    }
    this.lines.forEach((line, i) => {
      if (this.matches(line, filter)) {
        this.entryOf[i]!.matching++;
      }
    });
    this.visible = this.lines.filter((_, i) => this.entryOf[i]!.matching > 0);
  }

  /** Drops the oldest lines once the buffer is over budget, down to a slack below it. */
  private evict(): void {
    if (this.bytes <= this.maxBytes) {
      return;
    }
    const target = this.maxBytes - Math.floor(this.maxBytes / EVICTION_SLACK);
    let count = 0;
    // Entries whose last buffered matching line goes with this eviction.
    const hidden = new Set<Entry>();
    // The newest line always stays, even when it alone is over budget.
    while (this.bytes > target && count < this.lines.length - 1) {
      const line = this.lines[count]!;
      const entry = this.entryOf[count]!;
      if (this.filter && this.matches(line, this.filter) && --entry.matching === 0) {
        hidden.add(entry);
      }
      this.bytes -= lineBytes(line);
      count++;
    }
    if (count === 0) {
      return;
    }
    this.lines.splice(0, count);
    this.entryOf.splice(0, count);
    if (this.visible === this.lines) {
      return;
    }
    this.visible.splice(0, firstAfter(this.visible, this.lines[0]!.id - 1));
    if (hidden.size > 0) {
      const firstId = this.lines[0]!.id;
      this.visible = this.visible.filter((line) => !hidden.has(this.entryOf[line.id - firstId]!));
    }
  }
}

/** The index of the first line in `lines` (in id order) whose id is above `id`. */
function firstAfter(lines: readonly LogLine[], id: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid]!.id <= id) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}
