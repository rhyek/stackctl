/** Where a footer item sits on screen: its first cell (1-based) and its row. */
export interface ItemRect {
  col: number;
  row: number;
}

/**
 * The item ↑/↓ moves the footer cursor to, among the package and infra items as laid out on
 * screen (a row wraps wherever the terminal is too narrow for it).
 *
 * The target row is the next one in that direction that has items, wrapping from the last row
 * to the first and back; with a single row the cursor stays put. Within it, the item whose left
 * edge is nearest the current one's, ties to the left — except that the **first item of each
 * row counts as starting where the rows start**, as if the `infra:` label in front of the
 * services were part of the first one. So the first service sits under the first package, and
 * every other item is measured where it is drawn.
 */
export function verticalTarget(rects: ItemRect[], current: number, dir: 'up' | 'down'): number {
  if (!rects[current]) {
    return current;
  }
  const rows = [...new Set(rects.map((r) => r.row))].sort((a, b) => a - b);
  if (rows.length < 2) {
    return current;
  }
  const rowsStart = Math.min(...rects.map((r) => r.col));
  const firstCol = new Map<number, number>();
  for (const r of rects) {
    firstCol.set(r.row, Math.min(firstCol.get(r.row) ?? Infinity, r.col));
  }
  const left = (r: ItemRect) => (r.col === firstCol.get(r.row) ? rowsStart : r.col);
  const from = rects[current];
  const at = rows.indexOf(from.row);
  const row = rows[(at + (dir === 'down' ? 1 : -1) + rows.length) % rows.length]!;
  let best = current;
  let bestDistance = Infinity;
  rects.forEach((rect, i) => {
    if (rect.row !== row) {
      return;
    }
    const distance = Math.abs(left(rect) - left(from));
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}
