/**
 * Variable-height virtualization for the log viewport, anchored at the bottom.
 *
 * Given the rendered-row count of every buffered line, the pane height, and how
 * far the view is scrolled up from the newest output, this returns just the
 * slice of lines that intersect the visible window (plus how many rendered rows
 * of the first/last line spill past the top/bottom edges). The caller renders
 * only that slice — never the whole buffer — which is what keeps a huge log cheap
 * to draw, the same idea as a windowed/virtualized list on the web.
 *
 * `scrollOffset` is measured in rendered rows from the bottom: `0` follows the
 * newest output; `maxScroll` pins the very top.
 */
export type LogWindow = {
  /** First visible line (inclusive). */
  startIndex: number;
  /** Last visible line (exclusive). */
  endIndex: number;
  /** Rendered rows of the first visible line hidden above the top edge. */
  topClip: number;
  /** Rendered rows of the last visible line hidden below the bottom edge. */
  bottomClip: number;
  /** Total rendered rows across every line. */
  totalRows: number;
  /** Largest valid `scrollOffset` (rows of history above the viewport). */
  maxScroll: number;
};

export function computeWindow(
  rowCounts: readonly number[],
  paneHeight: number,
  scrollOffset: number,
): LogWindow {
  let totalRows = 0;
  for (const count of rowCounts) {
    totalRows += count;
  }

  const maxScroll = Math.max(0, totalRows - Math.max(0, paneHeight));

  if (totalRows === 0 || paneHeight <= 0) {
    return { startIndex: 0, endIndex: 0, topClip: 0, bottomClip: 0, totalRows, maxScroll };
  }

  const offset = Math.min(Math.max(0, scrollOffset), maxScroll);
  const windowEnd = totalRows - offset; // exclusive bottom edge, in flat row space
  const windowStart = Math.max(0, windowEnd - paneHeight); // inclusive top edge

  let startIndex = 0;
  let endIndex = rowCounts.length;
  let topClip = 0;
  let bottomClip = 0;

  let cumulative = 0;
  for (let i = 0; i < rowCounts.length; i++) {
    const next = cumulative + rowCounts[i]!;
    // The line whose row-range contains the top edge.
    if (cumulative <= windowStart && windowStart < next) {
      startIndex = i;
      topClip = windowStart - cumulative;
    }
    // The line whose row-range contains the last visible row (windowEnd - 1).
    if (cumulative < windowEnd && windowEnd <= next) {
      endIndex = i + 1;
      bottomClip = next - windowEnd;
    }
    cumulative = next;
  }

  return { startIndex, endIndex, topClip, bottomClip, totalRows, maxScroll };
}

/**
 * Flattens the windowed lines into exactly the rendered rows that fit the pane,
 * clipping the partially-visible first/last lines. `wrap` turns a line into its
 * rendered rows (called only for the handful of lines actually on screen).
 */
export function windowRows<T, R = string>(
  lines: readonly T[],
  window: LogWindow,
  wrap: (line: T, index: number) => readonly R[],
): R[] {
  const out: R[] = [];
  for (let i = window.startIndex; i < window.endIndex; i++) {
    const rows = wrap(lines[i]!, i);
    const from = i === window.startIndex ? window.topClip : 0;
    const to = i === window.endIndex - 1 ? rows.length - window.bottomClip : rows.length;
    for (let r = from; r < to; r++) {
      out.push(rows[r]!);
    }
  }
  return out;
}

/**
 * The viewport's bottom edge as a position in the *lines* rather than in rendered rows: the line
 * the edge falls in, and how many of that line's rows are hidden below it. Unlike a row offset
 * this survives a change of layout — when the timestamp gutter narrows and wrapped lines take
 * fewer rows, the same anchor names the same content.
 */
export type BottomAnchor = {
  /** Index of the line at the bottom edge (`-1` for an empty buffer). */
  line: number;
  /** Rows of that line hidden below the edge (`0` = its last row is the last visible row). */
  clip: number;
};

/** Locate the bottom edge for `scrollOffset` (rows from the bottom) in a layout. */
export function bottomAnchor(rowCounts: readonly number[], scrollOffset: number): BottomAnchor {
  let remaining = Math.max(0, scrollOffset);
  for (let i = rowCounts.length - 1; i >= 0; i--) {
    const count = rowCounts[i]!;
    if (remaining < count) {
      return { line: i, clip: remaining };
    }
    remaining -= count;
  }
  // Past the top (or nothing buffered): the oldest row, as computeWindow would clamp to.
  for (let i = 0; i < rowCounts.length; i++) {
    if (rowCounts[i]! > 0) {
      return { line: i, clip: 0 };
    }
  }
  return { line: -1, clip: 0 };
}

/** The row offset that puts `anchor` at the bottom edge in a layout (the inverse of {@link bottomAnchor}). */
export function anchorOffset(rowCounts: readonly number[], anchor: BottomAnchor): number {
  if (anchor.line < 0 || anchor.line >= rowCounts.length) {
    return 0;
  }
  let offset = 0;
  for (let i = anchor.line + 1; i < rowCounts.length; i++) {
    offset += rowCounts[i]!;
  }
  // The line may have fewer rows in this layout than where the anchor was taken.
  return offset + Math.min(anchor.clip, Math.max(0, rowCounts[anchor.line]! - 1));
}

/** Re-express a row offset taken in layout `from` in layout `to`, keeping the same bottom edge. */
export function convertOffset(
  from: readonly number[],
  to: readonly number[],
  scrollOffset: number,
): number {
  return anchorOffset(to, bottomAnchor(from, scrollOffset));
}
