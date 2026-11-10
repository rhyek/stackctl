import chalk from 'chalk';
import stringWidth from 'string-width';
import { stripAnsi } from '../format.js';
import { displayTimestamp, timestampGutterWidth } from '../timestamp-mode.js';
import { countWrappedRows, measureText, wrapRows, type TextMeasure } from '../wrap-rows.js';
import type { LogLine, TimestampMode, WrappedRow } from './types.js';

// How one log line becomes screen rows: the gutter (timestamp column, label, a space) repeated on
// every row, the text wrapped to what is left, and continuation rows indented to line up under a
// `  key: value` property's value.

/**
 * The narrowest content column a line is wrapped to. At or below it a line stays on one row, and
 * the hanging indent is capped so a continuation row keeps at least this much. Ten columns still
 * fit a word or a short token per row; narrower, wrapping stacks a line into a column of
 * fragments that is harder to read than one row cut at the terminal's edge.
 */
export const MIN_WRAP_WIDTH = 10;

// A property line: leading whitespace, a key with no whitespace or colon, a colon and a space.
const PROPERTY = /^[ \t]+[^\s:]+: /;
const LEADING_WHITESPACE = /^[ \t]+/;

/** What a line's layout needs that doesn't depend on the width, plus its latest results. */
interface LineLayout {
  measure: TextMeasure;
  labelWidth: number;
  /** The hanging indent before it is capped. */
  indent: number;
  /** The width `counts` was computed for. */
  cols: number;
  /** Row counts at `cols`, per mode, side by side so neither evicts the other. */
  counts: Partial<Record<TimestampMode, number>>;
  /** The latest rows built, and the width, mode and stamp they were built with. */
  rows: { cols: number; mode: TimestampMode; ts: string; rows: WrappedRow[] } | null;
}

const layouts = new WeakMap<LogLine, LineLayout>();

/** Where a wrapped line's continuation rows start: under a property's value, else its indent. */
function hangingIndent(text: string): number {
  const plain = stripAnsi(text);
  const property = PROPERTY.exec(plain);
  if (property) {
    return stringWidth(property[0]);
  }
  return LEADING_WHITESPACE.exec(plain)?.[0].length ?? 0;
}

function layoutOf(line: LogLine): LineLayout {
  let layout = layouts.get(line);
  if (!layout) {
    layout = {
      measure: measureText(line.text),
      labelWidth: stringWidth(line.label),
      indent: hangingIndent(line.text),
      cols: -1,
      counts: {},
      rows: null,
    };
    layouts.set(line, layout);
  }
  return layout;
}

function showsTimestamp(line: LogLine, mode: TimestampMode): mode is 'date' | 'time' {
  return line.showTs && mode !== 'none';
}

function gutterWidth(line: LogLine, layout: LineLayout, mode: TimestampMode): number {
  const timestamp = showsTimestamp(line, mode) ? timestampGutterWidth(mode) : 0;
  return timestamp + layout.labelWidth + 1;
}

/** The content width a line wraps to, or `null` when it stays on one row. */
function wrapWidth(layout: LineLayout, cols: number, gutter: number): number | null {
  const width = cols - gutter;
  return layout.measure.width <= width || width <= MIN_WRAP_WIDTH ? null : width;
}

function cappedIndent(layout: LineLayout, width: number): number {
  return Math.min(layout.indent, width - MIN_WRAP_WIDTH);
}

/** How many rows `line` takes at `cols` columns in `mode`, without building them. */
export function countRows(line: LogLine, cols: number, mode: TimestampMode): number {
  const layout = layoutOf(line);
  if (layout.cols !== cols) {
    layout.cols = cols;
    layout.counts = {};
  }
  let count = layout.counts[mode];
  if (count === undefined) {
    const width = wrapWidth(layout, cols, gutterWidth(line, layout, mode));
    count =
      width === null
        ? 1
        : countWrappedRows(line.text, layout.measure, width, cappedIndent(layout, width));
    layout.counts[mode] = count;
  }
  return count;
}

/** The rows `line` takes at `cols` columns in `mode`, each with its gutter. */
export function wrapLineRows(line: LogLine, cols: number, mode: TimestampMode): WrappedRow[] {
  const layout = layoutOf(line);
  const cached = layout.rows;
  // `ts` is part of the key: it is writable, so a line's stamp can change after it is drawn.
  if (cached?.cols === cols && cached.mode === mode && cached.ts === line.ts) {
    return cached.rows;
  }
  const gutterColumns = gutterWidth(line, layout, mode);
  const gutter =
    (showsTimestamp(line, mode) ? `${chalk.dim(displayTimestamp(line.ts, mode))} ` : '') +
    `${line.label} `;
  const width = wrapWidth(layout, cols, gutterColumns);
  let rows: WrappedRow[];
  if (width === null) {
    rows = [{ text: gutter + line.text, contentStart: gutterColumns }];
  } else {
    const indent = cappedIndent(layout, width);
    const pad = ' '.repeat(indent);
    rows = wrapRows(line.text, width, indent).map((text, i) =>
      i === 0
        ? { text: gutter + text, contentStart: gutterColumns }
        : { text: gutter + pad + text, contentStart: gutterColumns + indent },
    );
  }
  layout.rows = { cols, mode, ts: line.ts, rows };
  return rows;
}
