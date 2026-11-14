/**
 * Pure geometry + text math for the log viewport's app-managed selection.
 *
 * A selection is two {@link Point}s in the viewport's **flat rendered-row space**
 * (the same coordinate space {@link computeWindow} works in): row 0 is the first
 * rendered row of the whole visible buffer, and a row keeps its index as newer
 * output is appended below it. Anchoring to that space — rather than to screen
 * coordinates — is what lets a selection survive scrolling and incoming logs,
 * which is exactly what native terminal selection cannot do under our in-place
 * repaints.
 *
 * `col` is a 0-based **display column** within a rendered row (wide glyphs count
 * as two), matching how {@link sliceAnsi} measures.
 */
import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';
import { stripAnsi } from './format.js';

export type Point = { flatRow: number; col: number };
/** An inclusive flat-row range of the rendered rows that make up one logical value. */
export type Run = { start: number; end: number };
/**
 * `anchor` is where the drag began; `focus` is the current end. Either order.
 *
 * `mode` is fixed when the drag starts: `'value'` when the press landed at or past the line's
 * value (see {@link classifyLine}), else `'wysiwyg'`. In value mode `run` holds the rows that
 * value occupies — leaving them reverts the whole copy to WYSIWYG.
 */
export type Selection = {
  anchor: Point;
  focus: Point;
  mode?: 'wysiwyg' | 'value';
  run?: Run | null;
};
/** A half-open display-column range `[start, end)` to highlight on one row. */
export type Span = { start: number; end: number };

/**
 * What a rendered line looks like structurally. Only `continuation` extends a value across
 * buffered lines; the others each begin a value of their own.
 */
export type LineKind = 'keyed' | 'header' | 'continuation' | 'plain';

/** One rendered row, plus where its own content and its value begin (display columns). */
export type RowMeta = {
  /** The rendered row, gutter included, ANSI intact. */
  text: string;
  /** Column where this row's own content begins — past the gutter and any hanging indent. */
  contentStart: number;
  /** Column where the line's value begins. Equals `contentStart` on a wrapped continuation row. */
  valueStart: number;
  /** The columns of the gutter's `[label]`, brackets included, end exclusive. */
  label?: Span;
  /** Index of the buffered line this row came from; wrapped rows of one line share it. */
  lineIndex: number;
  kind: LineKind;
};

// A `key: ` token: no whitespace or colon in the key, one space after the colon. Deliberately
// stricter than "anything up to a colon" so a message like `[INFO] error: boom` isn't split.
const KEYED = /^[ \t]+[^\s:]+:[ ]/;
// A bracketed leading token — stackctl's `[LEVEL] ` header, including `[UNKNOWN LOGLVL: 30] `.
const HEADER = /^\[[^\]]*\][ ]/;

/**
 * Classify a line and locate where its **value** starts, as a display-column offset into the
 * line's own text (i.e. not counting the gutter).
 *
 * Deliberately **not** the same as `hangingIndent` in `session/log-layout.ts`, which decides wrap
 * alignment: that returns 0 for a `[LEVEL] …` header so a wrapped message stays flush with the
 * gutter, while this returns the width of `[LEVEL] ` so selecting a message starts after the
 * level token. The two agree everywhere else. Keep them separate.
 */
export function classifyLine(text: string): { kind: LineKind; valueStart: number } {
  const plain = stripAnsi(text);
  const keyed = KEYED.exec(plain);
  if (keyed) {
    return { kind: 'keyed', valueStart: keyed[0].length };
  }
  const header = HEADER.exec(plain);
  if (header) {
    return { kind: 'header', valueStart: header[0].length };
  }
  const lead = /^[ \t]*/.exec(plain)![0].length;
  if (lead > 0) {
    return { kind: 'continuation', valueStart: lead };
  }
  return { kind: 'plain', valueStart: 0 };
}

/**
 * The rows making up the value that the row at `flatRow` belongs to: every rendered row of that
 * buffered line, plus any following buffered lines that are indented continuations of it (a value
 * that contained real newlines). Stops at the next keyed attr, header, or plain line.
 */
export function valueRun(
  flatRow: number,
  metaAt: (flatRow: number) => RowMeta | null,
  rowCount: number,
): Run {
  const here = metaAt(flatRow);
  if (!here) {
    return { start: flatRow, end: flatRow };
  }
  let start = flatRow;
  while (start > 0 && metaAt(start - 1)?.lineIndex === here.lineIndex) {
    start--;
  }
  let end = flatRow;
  while (end + 1 < rowCount) {
    const next = metaAt(end + 1);
    if (!next) {
      break;
    }
    // Same buffered line (a wrapped row), or a following line continuing this value.
    const sameLine = next.lineIndex === metaAt(end)?.lineIndex;
    if (!sameLine && next.kind !== 'continuation') {
      break;
    }
    end++;
  }
  return { start, end };
}

function comparePoints(a: Point, b: Point): number {
  return a.flatRow !== b.flatRow ? a.flatRow - b.flatRow : a.col - b.col;
}

/** True when anchor and focus coincide (a click with no drag — nothing selected). */
export function isEmptySelection(sel: Selection): boolean {
  return comparePoints(sel.anchor, sel.focus) === 0;
}

/** The selection as top-left `start` .. bottom-right `end`, regardless of drag direction. */
export function normalizeSelection(sel: Selection): { start: Point; end: Point } {
  return comparePoints(sel.anchor, sel.focus) <= 0
    ? { start: sel.anchor, end: sel.focus }
    : { start: sel.focus, end: sel.anchor };
}

/**
 * The display-column span to highlight on the rendered row at `flatRow`, or null
 * if that row is outside the selection or the span is empty. Character-precise on
 * the selection's first and last rows; the full row width in between.
 */
export function rowSpan(
  sel: Selection,
  flatRow: number,
  rowWidth: number,
  valueStart = 0,
): Span | null {
  const { start, end } = normalizeSelection(sel);
  if (flatRow < start.flatRow || flatRow > end.flatRow) {
    return null;
  }
  // In value mode the gutter and indent aren't part of the copy, so they must not look selected
  // either — floor the span where the copy floors it (see {@link selectionCopyText}).
  const floor = isValueScoped(sel) ? valueStart : 0;
  const a = Math.max(floor, Math.min(flatRow === start.flatRow ? start.col : floor, rowWidth));
  const b = Math.max(0, Math.min(flatRow === end.flatRow ? end.col : rowWidth, rowWidth));
  return b > a ? { start: a, end: b } : null;
}

/**
 * Whether this selection copies value-scoped text: it started inside a value **and** both ends
 * are still within that value's rows. Dragging past either edge of the run reverts the whole
 * selection to WYSIWYG.
 */
export function isValueScoped(sel: Selection): boolean {
  if (sel.mode !== 'value' || !sel.run) {
    return false;
  }
  const { start, end } = normalizeSelection(sel);
  return start.flatRow >= sel.run.start && end.flatRow <= sel.run.end;
}

/**
 * The selected text, WYSIWYG: for each row the selection covers, the
 * ANSI-stripped glyphs within the selected columns, joined by newlines. `rowAt`
 * returns the rendered (possibly ANSI-colored) row for a flat row index.
 */
export function selectionText(sel: Selection, rowAt: (flatRow: number) => string): string {
  const { start, end } = normalizeSelection(sel);
  const lines: string[] = [];
  for (let r = start.flatRow; r <= end.flatRow; r++) {
    const raw = rowAt(r);
    const a = r === start.flatRow ? start.col : 0;
    const sliced = r === end.flatRow ? sliceAnsi(raw, a, end.col) : sliceAnsi(raw, a);
    lines.push(stripAnsi(sliced));
  }
  return lines.join('\n');
}

/**
 * The text a finished selection puts on the clipboard.
 *
 * WYSIWYG by default — exactly the glyphs under the highlight, one line per row. When the drag
 * began inside a value and stayed there ({@link isValueScoped}), the gutter and hanging indent are
 * dropped instead, and the rows are rejoined as the process emitted them: rows of the **same**
 * buffered line concatenate with no separator (the terminal introduced that break), while distinct
 * buffered lines keep a newline (the value contained one).
 */
export function selectionCopyText(
  sel: Selection,
  metaAt: (flatRow: number) => RowMeta | null,
): string {
  const { start, end } = normalizeSelection(sel);
  if (!isValueScoped(sel)) {
    return selectionText(sel, (flatRow) => metaAt(flatRow)?.text ?? '');
  }
  let out = '';
  let prevLineIndex: number | null = null;
  for (let r = start.flatRow; r <= end.flatRow; r++) {
    const meta = metaAt(r);
    if (!meta) {
      continue;
    }
    // Floor at `valueStart`, not `contentStart`: on the *first* row of a line that continues a
    // value, the line's own text begins at the gutter but its leading indent is still display
    // padding. `valueStart` covers both that and a wrapped row (where the two coincide).
    const from = Math.max(r === start.flatRow ? start.col : 0, meta.valueStart);
    const sliced = r === end.flatRow ? sliceAnsi(meta.text, from, end.col) : sliceAnsi(meta.text, from); // oxfmt-ignore
    if (prevLineIndex !== null) {
      out += meta.lineIndex === prevLineIndex ? '' : '\n';
    }
    out += stripAnsi(sliced);
    prevLineIndex = meta.lineIndex;
  }
  return out;
}

/** Split a rendered row for highlighting: colored `pre`/`post`, plain (ANSI-stripped) `mid`. */
export function highlightParts(
  row: string,
  span: Span,
): { pre: string; mid: string; post: string } {
  return {
    pre: sliceAnsi(row, 0, span.start),
    mid: stripAnsi(sliceAnsi(row, span.start, span.end)),
    post: sliceAnsi(row, span.end),
  };
}

/** Display width of a rendered row (ANSI-aware, via string-width). */
export function rowWidth(row: string): number {
  return stringWidth(row);
}

/**
 * Map a 1-based terminal row to an index into the bottom-aligned rendered rows of
 * the log pane. The pane starts at terminal row `topHeight + 1`; when the buffer
 * is shorter than the pane, the rendered rows sit flush at the bottom with blank
 * rows above. The result may be out of range — callers clamp into `[0, count)`.
 */
export function viewportRowIndex(
  terminalRow: number,
  topHeight: number,
  paneHeight: number,
  renderedCount: number,
): number {
  const blankTop = Math.max(0, paneHeight - renderedCount);
  return terminalRow - (topHeight + 1) - blankTop;
}
