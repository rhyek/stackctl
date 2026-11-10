/**
 * How much of a line's `YYYY-MM-DD HH:MM:SS` stamp the viewport shows. While every timestamp on
 * screen falls on the same day the date is noise, so the pane shows just the time; as soon as
 * two days are visible together (scrolled back across midnight, or the first line after it while
 * following) the full stamp comes back so the rows can be told apart. The stamp is local time,
 * so "same day" is judged in the timezone the stamp itself is rendered in.
 */
export type TsMode = 'date' | 'time';

/** `YYYY-MM-DD HH:MM:SS` → the part shown in `mode`. */
export function displayTimestamp(ts: string, mode: TsMode): string {
  return mode === 'time' ? ts.slice(DAY_LENGTH + 1) : ts;
}

/** Rendered width of the timestamp column (the stamp plus its trailing space) in `mode`. */
export function timestampGutterWidth(mode: TsMode): number {
  return (mode === 'time' ? TIME_LENGTH : DAY_LENGTH + 1 + TIME_LENGTH) + 1;
}

/**
 * Whether every timestamped line in `lines[start, end)` — the visible window — falls on one
 * calendar day. Lines whose stamp is hidden (`showTs` off) don't take part: they can't be told
 * apart by date either way.
 */
export function spansOneDay(
  lines: readonly { ts: string; showTs: boolean }[],
  start: number,
  end: number,
): boolean {
  let day: string | undefined;
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    if (!line.showTs) {
      continue;
    }
    const d = line.ts.slice(0, DAY_LENGTH);
    if (day === undefined) {
      day = d;
    } else if (d !== day) {
      return false;
    }
  }
  return true;
}

const DAY_LENGTH = 'YYYY-MM-DD'.length;
const TIME_LENGTH = 'HH:MM:SS'.length;
