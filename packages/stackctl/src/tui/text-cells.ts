import stringWidth from 'string-width';
import type { Color } from '../colors.js';

/**
 * Text measured and cut in terminal cells, and rows of styled segments built at known columns.
 * Shared by every pure layout (the run screen's footer and menu, the service picker), so they all
 * measure the same text the same way and their click targets match the drawn cells.
 */

/** A run of text drawn in one style. `link` makes it an OSC 8 hyperlink to that URL. */
export interface Segment {
  text: string;
  color?: Color;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  link?: string;
}

export function width(text: string): number {
  return stringWidth(text);
}

export function rowWidth(segments: readonly Segment[]): number {
  let w = 0;
  for (const s of segments) {
    w += width(s.text);
  }
  return w;
}

export function blank(n: number): Segment {
  return { text: ' '.repeat(Math.max(0, n)) };
}

const graphemeSegmenter = new Intl.Segmenter();

/** `text`'s grapheme clusters: what a terminal draws in one cell, or two when it is wide. */
export function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

/** The first `w` cells of `text`. */
export function headCells(text: string, w: number): string {
  let out = '';
  let used = 0;
  for (const ch of graphemes(text)) {
    const cw = width(ch);
    if (used + cw > w) {
      break;
    }
    out += ch;
    used += cw;
  }
  return out;
}

/** The last `w` cells of `text`. */
export function tailCells(text: string, w: number): string {
  const chars = graphemes(text);
  let out = '';
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = width(chars[i]!);
    if (used + cw > w) {
      break;
    }
    out = chars[i]! + out;
    used += cw;
  }
  return out;
}

/** `text` in at most `w` cells, cut from its start behind `…`. */
export function cutStart(text: string, w: number): string {
  if (width(text) <= w) {
    return text;
  }
  return w < 1 ? '' : `…${tailCells(text, w - 1)}`;
}

/** `text` in at most `w` cells, cut at its end with `…`. */
export function cutEnd(text: string, w: number): string {
  if (width(text) <= w) {
    return text;
  }
  return w < 1 ? '' : `${headCells(text, w - 1).trimEnd()}…`;
}

/** `segments` in at most `w` cells, cut at their end with `…` in the last kept style. */
export function cutSegmentsEnd(segments: readonly Segment[], w: number): Segment[] {
  if (rowWidth(segments) <= w) {
    return [...segments];
  }
  if (w < 1) {
    return [];
  }
  const out: Segment[] = [];
  let left = w - 1;
  for (const s of segments) {
    const sw = width(s.text);
    if (sw <= left) {
      out.push(s);
      left -= sw;
      continue;
    }
    out.push({ ...s, text: `${headCells(s.text, left).trimEnd()}…` });
    return out;
  }
  return out;
}

/** The row clipped to `cols` cells: no row is ever wider than the screen. */
export function clip(segments: readonly Segment[], cols: number): Segment[] {
  const out: Segment[] = [];
  let left = cols;
  for (const s of segments) {
    if (left <= 0) {
      break;
    }
    const sw = width(s.text);
    if (sw <= left) {
      out.push(s);
      left -= sw;
    } else {
      out.push({ ...s, text: headCells(s.text, left) });
      left = 0;
    }
  }
  return out;
}

/** A row assembled from pieces at known columns, gaps filled with blanks. */
export class RowBuilder {
  readonly segments: Segment[] = [];
  /** Cells used so far; the next segment starts at column `used + 1`. */
  used = 0;

  /** Appends `segments` and returns the 1-based column they start at. */
  push(...segments: Segment[]): number {
    const col = this.used + 1;
    for (const s of segments) {
      if (s.text !== '') {
        this.segments.push(s);
        this.used += width(s.text);
      }
    }
    return col;
  }

  /** Pads with blanks up to just before 1-based column `col`. */
  padTo(col: number): void {
    if (col - 1 > this.used) {
      this.push(blank(col - 1 - this.used));
    }
  }
}

/** `a`, `a and b`, `a, b and c`. */
export function joinNames(names: readonly string[]): string {
  return names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

// The Combining Diacritical Marks block, which NFD splits accents into.
const COMBINING_DIACRITICS = /[\u0300-\u036f]/g;

/** Case- and accent-insensitive form of a filter term or haystack. */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(COMBINING_DIACRITICS, '').toLowerCase();
}

/** A filter's terms as the log store matches them: split on whitespace, case and accents folded. */
export function filterTerms(text: string): string[] {
  return text.split(/\s+/).filter(Boolean).map(normalize);
}
