import stringWidth from 'string-width';
import { describe, expect, test } from 'vitest';
import { stripAnsi } from '../format.js';
import { createInternalLogger, formatInternalRecord } from '../internal-logger.js';
import {
  classifyLine,
  rowWidth,
  selectionCopyText,
  valueRun,
  type RowMeta,
  type Selection,
} from '../selection.js';
import { expandTabs } from '../wrap-rows.js';
import {
  countRows as countRowsAt,
  labelGutter,
  wrapLineRows as wrapLineRowsAt,
} from './log-layout.js';
import type { LogLabel, LogLine, TimestampMode } from './types.js';

// The line records are built directly: the text of stackctl's own lines comes from the real
// internal logger and formatter, so colors, the `[INFO]` header and the `  key: value` properties
// are what a session appends.

/** The longest service name of the fixture session, which stackctl's labels are padded to. */
const LONGEST_NAME = 'fixture'.length;
const TS = '2026-09-06 08:00:00';
// chalk emits no colors under the test runner, so colored text is spelled out as raw SGR
// sequences: the layout must measure past them whatever the terminal's color level.
const ESC = String.fromCharCode(27);
const red = (text: string) => `${ESC}[31m${text}${ESC}[39m`;

/** stackctl's gold label, as truecolor SGR. */
function label(name: string): LogLabel {
  return { name, paint: (text) => `${ESC}[38;2;215;175;95m${text}${ESC}[39m` };
}

// Laid out as the fixture session's store lays them out: labels padded to its longest name.
const countRows = (line: LogLine, cols: number, mode: TimestampMode) =>
  countRowsAt(line, cols, mode, LONGEST_NAME);
const wrapLineRows = (line: LogLine, cols: number, mode: TimestampMode) =>
  wrapLineRowsAt(line, cols, mode, LONGEST_NAME);
/** The columns a line's label takes, drawn. */
const labelColumns = (line: LogLine) => stringWidth(labelGutter(line.label, LONGEST_NAME));

let nextId = 0;

function record(
  text: string,
  name: string,
  filterKey: string,
  showTs: boolean,
  continues: boolean,
): LogLine {
  return {
    id: nextId++,
    service: null,
    text: expandTabs(text),
    isError: false,
    at: Date.now(),
    ts: TS,
    showTs,
    label: label(name),
    filterKey,
    continues,
  };
}

/** The lines one internal record renders into, as the session appends them. */
function rendered(
  log: (loggers: ReturnType<typeof createInternalLogger>) => void,
  name: string,
  filterKey: string,
  showTs: boolean,
): LogLine[] {
  const records: string[] = [];
  log(createInternalLogger((line) => records.push(line)));
  return records.flatMap((json) =>
    formatInternalRecord(json)
      .text.split('\n')
      .filter((piece) => piece !== '')
      .map((piece, i) => record(piece, name, filterKey, showTs, i > 0)),
  );
}

/** A `[stackctl]` line: the `[INFO] <text>` header. */
function system(text: string, showTs = true): LogLine {
  return rendered((l) => l.system.info(text), 'stackctl', 'system', showTs)[0]!;
}

/** A `[control]` entry: an `[INFO] <command>` header and one `  key: value` line per attr. */
function control(command: string, attrs: Record<string, string> = {}, showTs = true): LogLine[] {
  return rendered((l) => l.control.info(attrs, command), 'control', 'control', showTs);
}

describe('on-screen log timestamps', () => {
  const DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[/;

  function firstRow(line: LogLine, mode: TimestampMode = 'date'): string {
    return stripAnsi(wrapLineRows(line, 200, mode)[0]!.text);
  }

  test('prefixes rows with a `YYYY-MM-DD HH:MM:SS` timestamp when the line shows it', () => {
    const row = firstRow(system('hello world'));
    expect(row).toMatch(DATE);
    expect(row).toContain('hello world');
  });

  test('leaves rows un-timestamped when the line hides its timestamp', () => {
    const row = firstRow(system('hello world', false));
    expect(row).not.toMatch(DATE);
    expect(row).toMatch(/^\[stackctl\] /);
    expect(row).toContain('hello world');
  });

  test("renders only `HH:MM:SS` in the 'time' layout", () => {
    const row = firstRow(system('hello world'), 'time');
    expect(row).toMatch(/^\d{2}:\d{2}:\d{2} \[/);
    expect(row).not.toMatch(DATE);
  });

  test('every row knows the columns of its `[label]`, whatever the timestamp layout', () => {
    for (const [line, mode] of [
      [system('hello world'), 'date'],
      [system('hello world'), 'time'],
      [system('hello world', false), 'date'],
    ] as const) {
      const row = wrapLineRows(line, 200, mode)[0]!;
      const plain = stripAnsi(row.text);
      expect(plain.slice(row.label.start, row.label.end)).toMatch(/^\[stackctl\s*\]$/);
    }
  });

  test("renders no timestamp column in the 'none' layout", () => {
    expect(firstRow(system('hello world'), 'none')).toMatch(/^\[stackctl\] \S/);
  });

  test('the time layout reclaims the date column, so a long line wraps into fewer rows', () => {
    const line = system('x'.repeat(150));
    // 90 columns: 20 of gutter leave 70 → 3 rows; 9 of gutter leave 81 → 2 rows.
    const cols = 90 + labelColumns(line) + 1;
    expect(countRows(line, cols, 'date')).toBe(3);
    expect(countRows(line, cols, 'time')).toBe(2);
    expect(wrapLineRows(line, cols, 'time')).toHaveLength(2);
    // Both counts stay memoized side by side rather than evicting each other.
    expect(countRows(line, cols, 'date')).toBe(3);
    expect(countRows(line, cols, 'time')).toBe(2);
  });

  test('a line with its timestamp hidden lays out the same in every mode', () => {
    const line = system('x'.repeat(150), false);
    for (const mode of ['time', 'none'] as const) {
      expect(countRows(line, 100, mode)).toBe(countRows(line, 100, 'date'));
      expect(wrapLineRows(line, 100, mode)).toEqual(wrapLineRows(line, 100, 'date'));
    }
  });

  test('a stamp assigned after the line was drawn shows on the next draw', () => {
    const line = system('hello world');
    firstRow(line);
    line.ts = '2026-09-05 23:59:59';
    expect(firstRow(line)).toMatch(/^2026-09-05 23:59:59 \[/);
  });

  // The viewport flips the layout when scrolling across midnight, which
  // reflows a wrapped line.
  test('a line wrapping beside the date column takes fewer rows without it', () => {
    const line = system('w'.repeat(53));
    expect(countRows(line, 60, 'date')).toBeGreaterThan(countRows(line, 60, 'time'));
  });
});

describe('wrapping a line too wide for the terminal', () => {
  const COLS = 80;
  // A single-line value long enough to wrap several times, with no spaces — the shape that
  // exposed this: one very long token, not a value containing newlines.
  const LONG = 'https://cdn.example.com/assets/' + 'ABCDEFGHIJ'.repeat(12) + '?v=9-4&sig=6A8B4178';
  const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';

  /** Rendered rows of `line`, ANSI stripped. */
  function rows(line: LogLine, cols = COLS): string[] {
    return wrapLineRows(line, cols, 'date').map((row) => stripAnsi(row.text));
  }

  function longAttr(opts?: { timestamps?: boolean }): LogLine {
    return control('asset-fetch', { content_url: LONG }, opts?.timestamps ?? false).at(-1)!;
  }

  test('keeps the property key aligned with unwrapped keys (the indent survives wrapping)', () => {
    const wrapped = rows(longAttr());
    expect(wrapped.length).toBeGreaterThan(1);
    // The formatter indents every property by two spaces; wrapping must not eat them, or this
    // key renders two columns left of every key short enough to avoid the wrap.
    expect(wrapped[0]).toContain('  content_url: ');
  });

  test('repeats the prefix on every wrapped row', () => {
    for (const row of rows(longAttr())) {
      expect(row).toMatch(/^\[control\] /);
    }
  });

  test('repeats the timestamp on every wrapped row when timestamps are on', () => {
    for (const row of rows(longAttr({ timestamps: true }))) {
      expect(row).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[control\] /);
    }
  });

  test('aligns continuation rows under the value, like a multi-line value', () => {
    const wrapped = rows(longAttr());
    const gutter = wrapped[0]!.indexOf('  content_url: ');
    // `  content_url: ` is 15 columns; continuations start under the value, not under the key.
    const valueCol = gutter + '  content_url: '.length;
    for (const row of wrapped.slice(1)) {
      expect(row.slice(gutter, valueCol)).toBe(' '.repeat(valueCol - gutter));
      expect(row[valueCol]).not.toBe(' ');
    }
  });

  test('spaces out a tab, so a row holding one is as wide as it is drawn', () => {
    const value = 'col\t'.repeat(30);
    const wrapped = rows(control('table', { row: value }, false).at(-1)!);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const row of wrapped) {
      expect(row).not.toContain('\t');
      expect(row.length).toBeLessThanOrEqual(COLS);
    }
    expect(wrapped.join('').match(/col/g)).toHaveLength(30);
  });

  test('loses no text and never exceeds the terminal width', () => {
    const wrapped = rows(longAttr());
    for (const row of wrapped) {
      expect(row.length).toBeLessThanOrEqual(COLS);
    }
    // Strip the gutter (and, on continuations, the hanging indent) back off and the original
    // value must reassemble exactly — wrapping may not drop or duplicate a character.
    const gutter = wrapped[0]!.indexOf('  content_url: ');
    const indent = '  content_url: '.length;
    const joined = wrapped
      .map((row, i) => (i === 0 ? row.slice(gutter) : row.slice(gutter + indent)))
      .join('');
    expect(joined).toBe(`  content_url: ${LONG}`);
  });

  // End-to-end over the real wrapping: build the row metadata exactly as `useLogViewport` does,
  // then simulate pressing at the value and dragging to the end of its last row.
  test('value-scoped selection reassembles the original value, gutters and indent stripped', () => {
    const lines = control('asset-fetch', { content_url: LONG }, true);
    const meta: RowMeta[] = lines.flatMap((line, lineIndex) => {
      const { kind, valueStart } = classifyLine(line.text);
      return wrapLineRows(line, COLS, 'date').map((row, r) => ({
        text: row.text,
        contentStart: row.contentStart,
        valueStart: r === 0 ? row.contentStart + valueStart : row.contentStart,
        lineIndex,
        kind,
      }));
    });

    const press = meta.findIndex((m) => m.kind === 'keyed' && m.text.includes('content_url'));
    expect(press).toBeGreaterThanOrEqual(0);
    const run = valueRun(press, (r) => meta[r] ?? null, meta.length);
    expect(run.end).toBeGreaterThan(run.start); // it really did wrap

    const selection: Selection = {
      anchor: { flatRow: press, col: meta[press]!.valueStart },
      focus: { flatRow: run.end, col: rowWidth(meta[run.end]!.text) },
      mode: 'value',
      run,
    };
    expect(selectionCopyText(selection, (r) => meta[r] ?? null)).toBe(LONG);
  });

  // As `selection.spec.ts`'s `META` fixture models: the first row of an indented line starts at the
  // gutter, its indent being display padding; a wrapped row's content starts past the indent.
  test('a row’s content starts at the gutter, and past the hanging indent on a continuation', () => {
    const line = system('x', false);
    const gutter = labelColumns(line) + 1;
    const indented = { ...line, id: nextId++, text: '        second line' };
    expect(wrapLineRows(indented, COLS, 'date')).toEqual([
      expect.objectContaining({ contentStart: gutter }),
    ]);
    const attr = longAttr();
    const attrGutter = labelColumns(attr) + 1;
    const wrapped = wrapLineRows(attr, COLS, 'date');
    expect(wrapped[0]!.contentStart).toBe(attrGutter);
    for (const row of wrapped.slice(1)) {
      expect(row.contentStart).toBe(attrGutter + '  content_url: '.length);
    }
  });

  // Whether word-wrap pushes the value to its own row depends on arithmetic between the width,
  // the key length and the token length, so one fixture proves nothing — sweep the widths.
  test('never strands the key on a blank row, at any terminal width', () => {
    const line = longAttr({ timestamps: true });
    for (let cols = 60; cols <= 140; cols++) {
      const wrapped = rows(line, cols);
      if (wrapped.length < 2) {
        continue; // didn't wrap at this width
      }
      expect(wrapped[0], `cols=${cols}`).toContain(LONG.slice(0, 5));
    }
  });

  test('still breaks a prose value on word boundaries', () => {
    const wrapped = rows(control('note', { text: `${WORDS} ${WORDS}` }).at(-1)!);
    expect(wrapped.length).toBeGreaterThan(1);
    // no row ends mid-word: each row boundary falls on a space in the original text
    for (const row of wrapped.slice(0, -1)) {
      expect(row.trimEnd().endsWith('-')).toBe(false);
      const lastWord = row.trimEnd().split(' ').pop()!;
      expect(`${WORDS} ${WORDS}`.split(' ')).toContain(lastWord);
    }
  });

  test('still wraps a plain line with no property key, aligned at the gutter', () => {
    const wrapped = rows(system('x'.repeat(300), false));
    expect(wrapped.length).toBeGreaterThan(1);
    for (const row of wrapped) {
      expect(row).toMatch(/^\[stackctl\s*\] /);
      expect(row.length).toBeLessThanOrEqual(COLS);
    }
  });

  /** Every shape of line the cases above lay out. */
  function corpus(timestamps: boolean): LogLine[] {
    return [
      ...control('asset-fetch', { content_url: LONG, note: `${WORDS} ${WORDS}` }, timestamps),
      ...control('short', {}, timestamps),
      ...control('table', { row: 'col\t'.repeat(30) }, timestamps),
      system('x'.repeat(300), timestamps),
      system(`${WORDS} ${red(LONG)} ${WORDS}`, timestamps),
      system(`  ${red('key:')} ${red(LONG)} ${WORDS}`, timestamps),
      system(`    indented ${WORDS} ${WORDS}`, timestamps),
      system(`✓ built … ➜ ${WORDS} ${WORDS}`, timestamps),
      system(`wide 漢字 🚀 ${WORDS} ${WORDS}`, timestamps),
      system('w'.repeat(53), timestamps),
    ];
  }

  // The viewport counts every buffered line's rows without wrapping it, then wraps only the few
  // on screen — so the count has to be the wrap's length for whatever a line looks like, at any
  // width, in either timestamp layout, or every row below the disagreement lands a row off.
  for (const timestamps of [true, false]) {
    test(`counts the rows a line wraps into without wrapping it (timestamps ${timestamps ? 'on' : 'off'})`, () => {
      const lines = corpus(timestamps);
      for (let cols = 30; cols <= 150; cols += 7) {
        for (const mode of ['date', 'time'] as const) {
          for (const line of lines) {
            expect(countRows(line, cols, mode), `cols=${cols} ${mode} ${line.text}`).toBe(
              wrapLineRows(line, cols, mode).length,
            );
          }
        }
      }
    });
  }

  test('countRows equals wrapLineRows length', () => {
    for (const timestamps of [true, false]) {
      const lines = corpus(timestamps);
      for (const cols of [20, 61, 166]) {
        for (const mode of ['date', 'time', 'none'] as const) {
          for (const line of lines) {
            const label = `cols=${cols} ${mode} timestamps=${timestamps} ${line.text}`;
            expect(countRows(line, cols, mode), label).toBe(wrapLineRows(line, cols, mode).length);
          }
        }
      }
    }
  });
});
