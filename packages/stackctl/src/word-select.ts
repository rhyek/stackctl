/**
 * Word boundaries for double-click selection in the log viewport.
 *
 * The model is the one every terminal emulator uses — a set of word characters
 * plus a set of "joiner" characters that keep a run together — with one extra
 * pass on top: trailing joiners are trimmed. That trim is what makes a word at
 * the end of a sentence come out clean (`being.` -> `being`) while an interior
 * joiner still holds a path or URL together (`record.sh`, `a?b=1`).
 */
import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';
import { stripAnsi } from './format.js';
import type { Point, Span } from './selection.js';

/** Characters that make up a word on their own: letters of any script, combining marks, digits, `_`. */
const WORD = /[\p{L}\p{M}\p{N}_]/u;

/**
 * Characters that don't start a word but hold one together, so paths, timestamps,
 * kebab-case names and `--flags` select as a unit.
 *
 * `=`, `?` and `&` are deliberately **not** here: they separate one thing from
 * another (`env=value` is a key and a value, not one word). Inside a URI they do
 * hold it together — which is why a URI is matched whole up front, before these
 * rules ever run.
 */
const JOINER = new Set('-./~:@#%+');

/**
 * Joiners that are meaningless at the end of a selection and get trimmed. `/` is
 * deliberately absent: a trailing slash is part of what a directory *is* (`dist/`).
 */
const TRIM = new Set('-.~:@#%+');

/**
 * A URI with an explicit scheme, taken as one unit no matter which part is clicked.
 * Everything up to whitespace, since a URI's own punctuation (`?`, `=`, `&`, `#`)
 * would otherwise end the word.
 */
const URI = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/gu;

/**
 * Trailing characters to drop off a matched URI: sentence punctuation and closing
 * pairs that a URI in prose collects but doesn't own. `/` stays — `http://host/`
 * is a real URI, and the slash is part of it.
 */
const URI_TRIM = new Set('.,;:!?&=\'")]}');

function isWordChar(ch: string): boolean {
  return WORD.test(ch) || JOINER.has(ch);
}

/**
 * How long after a press a second press on the same cell still counts as a
 * double-click. The SGR mouse protocol carries no click count, so an application
 * under raw mouse reporting has to time this itself; 300ms is tmux's
 * `KEYC_CLICK_TIMEOUT`, and sits between xterm's 250ms and kitty's 500ms.
 */
export const DOUBLE_CLICK_MS = 300;

/** The last press of an in-progress click streak, or null when there is none. */
export type ClickState = { col: number; row: number; at: number; count: number } | null;

/**
 * Fold a press into a click streak: 1 for a fresh click, 2 for a double-click, 3
 * for a triple. A press on a different cell, or one that arrives more than
 * {@link DOUBLE_CLICK_MS} after the previous one, starts a new streak. Callers
 * drop the state to null on an intervening drag or wheel event.
 */
export function trackClick(
  prev: ClickState,
  cell: { col: number; row: number },
  now: number,
): { state: ClickState; count: number } {
  const continues =
    prev !== null &&
    prev.col === cell.col &&
    prev.row === cell.row &&
    now - prev.at <= DOUBLE_CLICK_MS;
  const count = continues ? prev.count + 1 : 1;
  return { state: { col: cell.col, row: cell.row, at: now, count }, count };
}

/** One code point of a rendered row: its character and the display column it starts at. */
type Cell = { ch: string; col: number };

/**
 * A row split into code points with their display columns, plus a column -> cell
 * lookup. A wide glyph claims two columns; a zero-width combining mark claims
 * none, so the base character it sits on keeps the column.
 */
function layout(text: string): {
  plain: string;
  cells: Cell[];
  at: number[];
  /** UTF-16 index into `plain` -> cell index, so a regex match maps back to cells. */
  unitToCell: number[];
  width: number;
} {
  const plain = stripAnsi(text);
  const cells: Cell[] = [];
  const at: number[] = [];
  const unitToCell: number[] = [];
  let col = 0;
  let unit = 0;
  for (const ch of plain) {
    const index = cells.length;
    cells.push({ ch, col });
    const w = stringWidth(ch);
    for (let k = 0; k < w; k++) {
      at[col + k] = index;
    }
    for (let k = 0; k < ch.length; k++) {
      unitToCell[unit + k] = index;
    }
    col += w;
    unit += ch.length;
  }
  return { plain, cells, at, unitToCell, width: col };
}

/** The display-column span covering cells `[first, end)`. */
function spanOf(cells: Cell[], first: number, end: number, width: number): Span {
  return {
    start: cells[first]!.col,
    // The column *after* the last cell, so trailing zero-width marks stay inside.
    end: end < cells.length ? cells[end]!.col : width,
  };
}

/**
 * The span of the word under display column `col`, or null when that column holds
 * no word (whitespace, a bracket, a quote — clicking there selects nothing rather
 * than copying punctuation to the clipboard).
 *
 * `text` is a rendered row with its ANSI intact; the returned span is in display
 * columns, so it slices with `sliceAnsi` like every other selection span.
 */
export function wordSpanAt(text: string, col: number): Span | null {
  const { plain, cells, at, unitToCell, width } = layout(text);
  const hit = at[col];
  if (hit === undefined) {
    return null;
  }

  // A URI wins outright, from any part of it: inside one, `?`/`=`/`&` hold the
  // thing together rather than separating it, so the ordinary rules would cut it
  // short at the query string.
  URI.lastIndex = 0;
  for (let match = URI.exec(plain); match !== null; match = URI.exec(plain)) {
    const first = unitToCell[match.index]!;
    const last = unitToCell[match.index + match[0].length - 1]!;
    if (hit < first || hit > last) {
      continue;
    }
    let end = last + 1;
    while (end > first && URI_TRIM.has(cells[end - 1]!.ch)) {
      end--;
    }
    return spanOf(cells, first, end, width);
  }

  if (!isWordChar(cells[hit]!.ch)) {
    return null;
  }
  let first = hit;
  while (first > 0 && isWordChar(cells[first - 1]!.ch)) {
    first--;
  }
  let last = hit + 1;
  while (last < cells.length && isWordChar(cells[last]!.ch)) {
    last++;
  }
  // Trim trailing joiners, never leading ones — `./foo`, `~/bar`, `.env` and
  // `--verbose` all depend on their lead surviving.
  let trimmed = last;
  while (trimmed > first && TRIM.has(cells[trimmed - 1]!.ch)) {
    trimmed--;
  }
  // A run of nothing but joiners (`...`) has no word to uncover; keep it whole.
  return spanOf(cells, first, trimmed > first ? trimmed : last, width);
}

/** One rendered row of a wrapped logical line, as {@link wordSelectionAt} needs it. */
export type RowSegment = {
  flatRow: number;
  /** Display column where this row's own content begins — past the gutter and any hanging indent. */
  contentStart: number;
  /** The rendered row, gutter included, ANSI intact. */
  text: string;
};

/**
 * The word under a press, looked up across **all** the rendered rows one logical
 * line wraps onto, so a URI or path broken by the terminal's width still selects
 * whole.
 *
 * The rows are stitched back into the line the process actually emitted — stackctl's
 * wrapping is lossless (it slices off exactly what each row consumed and inserts
 * nothing), so concatenating each row's content past `contentStart` reproduces it
 * exactly. The word is found in that text and mapped back to a start and end point,
 * which may land on different rows; the existing value-scoped copy rejoins rows of
 * one line with no separator, so the clipboard gets the unbroken word.
 *
 * Returns null when the press is in the gutter or hanging indent (the caller falls
 * back to the single-row rules, which is what still selects a `[package]` name) or
 * when there's no word under it.
 */
export function wordSelectionAt(
  segments: readonly RowSegment[],
  click: { flatRow: number; col: number },
): { anchor: Point; focus: Point } | null {
  // Each row's own content, and the logical column it starts at.
  let width = 0;
  const parts = segments.map((segment) => {
    const content = sliceAnsi(segment.text, segment.contentStart);
    const part = { segment, offset: width, width: stringWidth(stripAnsi(content)), content };
    width += part.width;
    return part;
  });
  const here = parts.find((p) => p.segment.flatRow === click.flatRow);
  if (!here || click.col < here.segment.contentStart) {
    return null;
  }

  const span = wordSpanAt(
    parts.map((p) => p.content).join(''),
    here.offset + (click.col - here.segment.contentStart),
  );
  if (!span) {
    return null;
  }

  /** Map a logical column back to a row and column; `edge` picks the row for an exclusive end. */
  const pointAt = (logicalCol: number, edge: boolean): Point => {
    const part =
      parts.find((p) =>
        edge
          ? logicalCol > p.offset && logicalCol <= p.offset + p.width
          : logicalCol < p.offset + p.width,
      ) ?? parts[parts.length - 1]!;
    return {
      flatRow: part.segment.flatRow,
      col: part.segment.contentStart + (logicalCol - part.offset),
    };
  };
  return { anchor: pointAt(span.start, false), focus: pointAt(span.end, true) };
}
