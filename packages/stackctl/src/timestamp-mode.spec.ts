import { describe, test, expect } from 'vitest';
import { displayTimestamp, spansOneDay, timestampGutterWidth } from './timestamp-mode.js';

describe('displayTimestamp', () => {
  test('keeps the full stamp in date mode', () => {
    expect(displayTimestamp('2026-09-06 19:27:21', 'date')).toBe('2026-09-06 19:27:21');
  });

  test('drops the day in time mode', () => {
    expect(displayTimestamp('2026-09-06 19:27:21', 'time')).toBe('19:27:21');
  });
});

describe('timestampGutterWidth', () => {
  test('is the stamp plus a trailing space, in either mode', () => {
    expect(timestampGutterWidth('date')).toBe('2026-09-06 19:27:21 '.length);
    expect(timestampGutterWidth('time')).toBe('19:27:21 '.length);
  });
});

describe('spansOneDay', () => {
  const line = (ts: string, showTs = true) => ({ ts, showTs });

  test('is true when every visible stamp shares a day', () => {
    const lines = [line('2026-09-06 01:00:00'), line('2026-09-06 23:59:59')];
    expect(spansOneDay(lines, 0, 2)).toBe(true);
  });

  test('is false as soon as two days are visible', () => {
    const lines = [line('2026-09-05 23:59:59'), line('2026-09-06 00:00:00')];
    expect(spansOneDay(lines, 0, 2)).toBe(false);
  });

  test('looks only at the visible range', () => {
    const lines = [line('2026-09-05 23:59:59'), line('2026-09-06 00:00:00'), line('2026-09-06 08:00:00')]; // oxfmt-ignore
    expect(spansOneDay(lines, 1, 3)).toBe(true);
    expect(spansOneDay(lines, 0, 2)).toBe(false);
  });

  test('ignores lines whose timestamp is hidden', () => {
    const lines = [line('2026-09-05 23:59:59', false), line('2026-09-06 00:00:00')];
    expect(spansOneDay(lines, 0, 2)).toBe(true);
  });

  test('is true when nothing on screen shows a timestamp', () => {
    expect(spansOneDay([line('2026-09-05 23:59:59', false)], 0, 1)).toBe(true);
    expect(spansOneDay([], 0, 0)).toBe(true);
  });
});
