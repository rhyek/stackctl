import chalk from 'chalk';
import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';
import { MATCH_COLOR, ON_MATCH_COLOR } from './colors.js';
import { stripAnsi } from './format.js';
import type { Span } from './selection.js';
import { graphemes, normalize } from './tui/text-cells.js';

/** A rendered row, as far as finding the filter's matches in it goes. */
type MatchRow = { text: string; contentStart: number; lineIndex: number; label?: Span };

/** A stretch of one row's plain text, from column `col`. */
type Stretch = { row: number; col: number; text: string };

/** Adds to `spans` the cells where `terms` occur in `stretches`, searched as one text. */
function search(stretches: readonly Stretch[], terms: readonly string[], spans: Span[][]): void {
  let haystack = '';
  // Per UTF-16 unit of `haystack`: the row and the cells of the grapheme it was folded from.
  const cells: { row: number; start: number; end: number }[] = [];
  for (const { row, col: from, text } of stretches) {
    let col = from;
    for (const grapheme of graphemes(text)) {
      const folded = normalize(grapheme);
      const end = col + stringWidth(grapheme);
      for (let i = 0; i < folded.length; i++) {
        cells.push({ row, start: col, end });
      }
      haystack += folded;
      col = end;
    }
  }
  const hit = Array.from({ length: haystack.length }, () => false);
  for (const term of terms.filter(Boolean)) {
    for (let at = haystack.indexOf(term); at !== -1; at = haystack.indexOf(term, at + 1)) {
      hit.fill(true, at, at + term.length);
    }
  }
  cells.forEach((cell, i) => {
    const row = spans[cell.row]!;
    const last = row.at(-1);
    if (hit[i] && last && last.end >= cell.start) {
      last.end = Math.max(last.end, cell.end);
    } else if (hit[i]) {
      row.push({ start: cell.start, end: cell.end });
    }
  });
}

/**
 * Where `terms` occur in one line's rows, as display-column spans per row, in column order. Each
 * row's label is searched on its own, between its brackets; the content from each row's
 * `contentStart`, past the hanging indent, with the rows as one text, so a match the wrap broke
 * in two lights up on both rows. The timestamp is never searched.
 */
export function matchSpans(rows: readonly MatchRow[], terms: readonly string[]): Span[][] {
  const spans: Span[][] = rows.map(() => []);
  const plain = (row: MatchRow, from: number, to?: number) =>
    stripAnsi(sliceAnsi(row.text, from, to));
  rows.forEach(({ label }, r) => {
    if (label) {
      const text = plain(rows[r]!, label.start + 1, label.end - 1);
      search([{ row: r, col: label.start + 1, text }], terms, spans);
    }
  });
  const content = rows.map((row, r) => ({
    row: r,
    col: row.contentStart,
    text: plain(row, row.contentStart),
  }));
  search(content, terms, spans);
  return spans;
}

/** `row` with each span drawn as a match: its own colors dropped, dark text on the gold. */
export function paintMatches(row: string, spans: readonly Span[]): string {
  let out = '';
  let at = 0;
  for (const { start, end } of spans) {
    const text = stripAnsi(sliceAnsi(row, start, end));
    out += sliceAnsi(row, at, start) + chalk.bgHex(MATCH_COLOR).hex(ON_MATCH_COLOR)(text);
    at = end;
  }
  return spans.length === 0 ? row : out + sliceAnsi(row, at);
}

/** Each row's text with the matches of `terms` painted, a line's wrapped rows searched together. */
export function paintMatchRows(rows: readonly MatchRow[], terms: readonly string[]): string[] {
  const out: string[] = [];
  for (let from = 0, to = 0; from < rows.length; from = to) {
    while (to < rows.length && rows[to]!.lineIndex === rows[from]!.lineIndex) {
      to++;
    }
    const line = rows.slice(from, to);
    const spans = terms.length > 0 ? matchSpans(line, terms) : [];
    line.forEach((row, i) => out.push(paintMatches(row.text, spans[i] ?? [])));
  }
  return out;
}
