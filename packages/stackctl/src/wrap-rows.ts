import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { stripAnsi } from './format.js';

/**
 * Expand each tab in `text` to spaces, up to the next stop of 8 columns from the start of the text
 * (colors take no columns). Done to a log line as it comes in: the screen measures a tab as no
 * columns at all, while Ink expands it after measuring, so a row holding one comes out wider
 * than measured and loses its end. This is the expansion Ink does, so the line looks the same.
 */
export function expandTabs(text: string): string {
  return text.includes('\t') ? wrapAnsi(text, Infinity, { trim: false }) : text;
}

/**
 * Wrap `text` into rows: the first `width` columns wide, every row after it `indent` columns
 * narrower to leave room for the hanging indent (which the caller applies). Rows are returned
 * without that indent.
 *
 * `wrap-ansi` only wraps to a single fixed width, so this walks the text one row at a time,
 * slicing off exactly what the previous row consumed. `trim: false` is essential — the default
 * strips a row's leading whitespace, which would eat the formatter's property indent and leave a
 * wrapped `  key:` sitting two columns left of every key short enough not to wrap.
 */
export function wrapRows(text: string, width: number, indent: number): string[] {
  const rows: string[] = [];
  const nextRowWidth = width - indent;
  let rest = text;
  let rowWidth = width;
  while (stringWidth(rest) > rowWidth) {
    let row = wrapAnsi(rest, rowWidth, { hard: true, trim: false }).split('\n')[0]!;
    // `wrap-ansi` pushes an over-long token to the next row when it judges that costs no extra
    // rows — but it reasons with a single uniform width, and our continuation rows are `indent`
    // columns narrower, so here it can cost a row *and* leave `  key:` sitting alone beside a
    // blank. When the token is too long for a continuation row it gets split there anyway, so
    // moving it buys nothing: fill this row instead.
    if (stringWidth(row) < rowWidth) {
      const remainder = stripAnsi(sliceAnsi(rest, stringWidth(row))).replace(/^[ \t]+/, '');
      if (stringWidth(/^\S*/.exec(remainder)![0]) > nextRowWidth) {
        row = sliceAnsi(rest, 0, rowWidth);
      }
    }
    const consumed = stringWidth(row);
    if (consumed === 0) {
      break; // no progress possible (e.g. a wide glyph that can't fit) — emit the remainder as-is
    }
    rows.push(row);
    rest = sliceAnsi(rest, consumed);
    rowWidth = nextRowWidth;
  }
  rows.push(rest);
  return rows;
}

/** The width-independent facts about a text that {@link countWrappedRows} works from. */
export type TextMeasure = {
  /** Display width in columns. */
  width: number;
  /**
   * The text with its colors stripped, when every character left is exactly one column and its
   * own grapheme — so a column offset is a string index. `null` for anything else (a wide glyph,
   * a combining mark, a tab, an escape sequence that isn't a color), which is counted by
   * wrapping it for real.
   */
  cells: string | null;
};

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
// Whitespace other than the plain space. `wrapRows` splits words on ' ' alone but finds the next
// token with `\S`, so on these two the notions of "a word" disagree — leave them to `wrapRows`.
const OTHER_WHITESPACE = /[^\S ]/;
const segmenter = new Intl.Segmenter();
/** Whether a single UTF-16 code unit renders as one column, memoized per character. */
const oneColumn = new Map<string, boolean>();

function isOneColumn(char: string): boolean {
  let known = oneColumn.get(char);
  if (known === undefined) {
    known = stringWidth(char) === 1;
    oneColumn.set(char, known);
  }
  return known;
}

function cellsOf(text: string): string | null {
  const plain = text.includes('\x1b') ? stripAnsi(text) : text;
  if (PRINTABLE_ASCII.test(plain)) {
    return plain;
  }
  if (OTHER_WHITESPACE.test(plain)) {
    return null;
  }
  for (const { segment } of segmenter.segment(plain)) {
    if (segment.length !== 1 || !isOneColumn(segment)) {
      return null;
    }
  }
  return plain;
}

/** Measure a text once; the result holds for every width it is later wrapped to. */
export function measureText(text: string): TextMeasure {
  const cells = cellsOf(text);
  return { width: cells === null ? stringWidth(text) : cells.length, cells };
}

/**
 * Columns the first row takes when `cells.slice(start)` is wrapped to `width`, the rows after it
 * being `nextWidth` wide. This is {@link wrapRows}' own decision — `wrap-ansi`'s word wrap
 * (`hard`, `trim: false`) followed by the over-long-token rule — worked out on column offsets
 * instead of by building the row.
 */
function firstRowWidth(cells: string, start: number, width: number, nextWidth: number): number {
  const end = cells.length;
  let rowWidth = 0;
  let wordStart = start;
  let taken: number;
  for (let first = true; ; first = false) {
    if (!first) {
      // The space before this word: it starts a new row once the row is full, else joins it.
      if (rowWidth >= width) {
        taken = rowWidth;
        break;
      }
      rowWidth++;
    }
    let wordEnd = cells.indexOf(' ', wordStart);
    if (wordEnd === -1) {
      wordEnd = end;
    }
    const length = wordEnd - wordStart;
    if (length > width) {
      // A word longer than a whole row is hard-broken: from here if that costs no more rows
      // than starting it on the next one, filling the row; else it moves down whole.
      const remaining = width - rowWidth;
      const breaksStartingThisRow = 1 + Math.floor((length - remaining - 1) / width);
      const breaksStartingNextRow = Math.floor((length - 1) / width);
      taken = breaksStartingNextRow < breaksStartingThisRow ? rowWidth : width;
      break;
    }
    if (rowWidth + length > width && rowWidth > 0 && length > 0) {
      taken = rowWidth;
      break;
    }
    rowWidth += length;
    if (wordEnd === end) {
      taken = rowWidth;
      break;
    }
    wordStart = wordEnd + 1;
  }
  if (taken < width) {
    // The over-long-token rule: a token too long for a continuation row is split there anyway,
    // so it fills this row rather than moving down.
    let tokenStart = start + taken;
    while (tokenStart < end && cells.charCodeAt(tokenStart) === 32) {
      tokenStart++;
    }
    let tokenEnd = cells.indexOf(' ', tokenStart);
    if (tokenEnd === -1) {
      tokenEnd = end;
    }
    if (tokenEnd - tokenStart > nextWidth) {
      taken = width;
    }
  }
  return taken;
}

/**
 * How many rows {@link wrapRows} breaks `text` into — `wrapRows(text, width, indent).length`,
 * without building them. The log viewport needs this for **every** buffered line whenever the
 * terminal's width changes, and wrapping a line for real costs a thousand times what counting
 * its rows does; only the few lines on screen are ever wrapped.
 */
export function countWrappedRows(
  text: string,
  measure: TextMeasure,
  width: number,
  indent: number,
): number {
  const { cells } = measure;
  if (cells === null) {
    return wrapRows(text, width, indent).length;
  }
  const nextRowWidth = width - indent;
  let rows = 1;
  let start = 0;
  let rowWidth = width;
  while (cells.length - start > rowWidth) {
    const taken = firstRowWidth(cells, start, rowWidth, nextRowWidth);
    if (taken === 0) {
      break;
    }
    start += taken;
    rows++;
    rowWidth = nextRowWidth;
  }
  return rows;
}
