import chalk from 'chalk';
import stringWidth from 'string-width';
import { stripAnsi } from '../format.js';
import { displayTimestamp, timestampGutterWidth } from '../timestamp-mode.js';
import { countWrappedRows, measureText, wrapRows, type TextMeasure } from '../wrap-rows.js';
import type { LogLabel, LogLine, TimestampMode, WrappedRow } from './types.js';

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

/**
 * `[name]`, the name padded with spaces to `width` (never cut), painted whole: how every gutter
 * label is drawn, on screen and in the logfile alike. `width` is the log's
 * ({@link LogStore.labelWidth}), so every line's text starts in one column.
 */
export function labelGutter(label: LogLabel, width: number): string {
  const pad = ' '.repeat(Math.max(0, width - stringWidth(label.name)));
  const text = `[${label.name}${pad}]`;
  return label.paint ? label.paint(text) : text;
}

// A property line: leading whitespace, a key with no whitespace or colon, a colon and a space.
const PROPERTY = /^[ \t]+[^\s:]+: /;
const LEADING_WHITESPACE = /^[ \t]+/;

/** What a line's layout needs that doesn't depend on the width, plus its latest results. */
interface LineLayout {
  measure: TextMeasure;
  /** The label's name, in columns; drawn, it takes the log's label width if that is wider. */
  nameWidth: number;
  /** The hanging indent before it is capped. */
  indent: number;
  /** The width and the label width `counts` was computed for. */
  cols: number;
  labelWidth: number;
  /** Row counts at `cols`, per mode, side by side so neither evicts the other. */
  counts: Partial<Record<TimestampMode, number>>;
  /** The latest rows built, and the width, mode and stamp they were built with. */
  rows: {
    cols: number;
    labelWidth: number;
    mode: TimestampMode;
    ts: string;
    rows: WrappedRow[];
  } | null;
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
      nameWidth: stringWidth(line.label.name),
      indent: hangingIndent(line.text),
      cols: -1,
      labelWidth: -1,
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

function gutterWidth(
  line: LogLine,
  layout: LineLayout,
  mode: TimestampMode,
  labelWidth: number,
): number {
  const timestamp = showsTimestamp(line, mode) ? timestampGutterWidth(mode) : 0;
  // The brackets, the name or the padding it gets, and the space after.
  return timestamp + Math.max(layout.nameWidth, labelWidth) + 3;
}

/** The content width a line wraps to, or `null` when it stays on one row. */
function wrapWidth(layout: LineLayout, cols: number, gutter: number): number | null {
  const width = cols - gutter;
  return layout.measure.width <= width || width <= MIN_WRAP_WIDTH ? null : width;
}

function cappedIndent(layout: LineLayout, width: number): number {
  return Math.min(layout.indent, width - MIN_WRAP_WIDTH);
}

/**
 * How many rows `line` takes at `cols` columns in `mode`, its label padded to `labelWidth`,
 * without building them.
 */
export function countRows(
  line: LogLine,
  cols: number,
  mode: TimestampMode,
  labelWidth: number,
): number {
  const layout = layoutOf(line);
  if (layout.cols !== cols || layout.labelWidth !== labelWidth) {
    layout.cols = cols;
    layout.labelWidth = labelWidth;
    layout.counts = {};
  }
  let count = layout.counts[mode];
  if (count === undefined) {
    const width = wrapWidth(layout, cols, gutterWidth(line, layout, mode, labelWidth));
    count =
      width === null
        ? 1
        : countWrappedRows(line.text, layout.measure, width, cappedIndent(layout, width));
    layout.counts[mode] = count;
  }
  return count;
}

/**
 * The rows `line` takes at `cols` columns in `mode`, each with its gutter, the label padded to
 * `labelWidth`.
 */
export function wrapLineRows(
  line: LogLine,
  cols: number,
  mode: TimestampMode,
  labelWidth: number,
): WrappedRow[] {
  const layout = layoutOf(line);
  const cached = layout.rows;
  // `ts` is part of the key: it is writable, so a line's stamp can change after it is drawn.
  if (
    cached?.cols === cols &&
    cached.labelWidth === labelWidth &&
    cached.mode === mode &&
    cached.ts === line.ts
  ) {
    return cached.rows;
  }
  const gutterColumns = gutterWidth(line, layout, mode, labelWidth);
  const gutter =
    (showsTimestamp(line, mode) ? `${chalk.dim(displayTimestamp(line.ts, mode))} ` : '') +
    `${labelGutter(line.label, labelWidth)} `;
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
  layout.rows = { cols, labelWidth, mode, ts: line.ts, rows };
  return rows;
}
