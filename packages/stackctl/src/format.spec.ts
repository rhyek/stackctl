import { describe, test, expect, vi } from 'vitest';
import { formatDuration, logTimestamp } from './format.js';

describe('logTimestamp', () => {
  test('formats as `YYYY-MM-DD HH:MM:SS` (24-hour, with date)', () => {
    expect(logTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('stamps the time it is called at, to the second', () => {
    vi.useFakeTimers({ now: new Date(2026, 0, 2, 3, 4, 5, 900) });
    try {
      expect(logTimestamp()).toBe('2026-01-02 03:04:05');
      vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 6, 0));
      expect(logTimestamp()).toBe('2026-01-02 03:04:06');
      vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 6, 999));
      expect(logTimestamp()).toBe('2026-01-02 03:04:06');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatDuration', () => {
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  test('spells out days, hours and minutes', () => {
    expect(formatDuration(3 * DAY + 2 * HOUR + 3 * MINUTE)).toBe('3 days 2 hours 3 minutes');
  });

  test('uses the singular for a unit of one', () => {
    expect(formatDuration(DAY + HOUR + MINUTE)).toBe('1 day 1 hour 1 minute');
    expect(formatDuration(SECOND)).toBe('1 second');
  });

  test('leaves out a unit that is zero', () => {
    expect(formatDuration(DAY + 5 * MINUTE)).toBe('1 day 5 minutes');
    expect(formatDuration(HOUR)).toBe('1 hour');
    expect(formatDuration(2 * DAY)).toBe('2 days');
  });

  test('shows seconds only while the whole duration is under a minute', () => {
    expect(formatDuration(42_300)).toBe('42 seconds');
    expect(formatDuration(MINUTE)).toBe('1 minute');
    expect(formatDuration(MINUTE + SECOND)).toBe('1 minute');
    expect(formatDuration(HOUR + 59 * SECOND)).toBe('1 hour');
  });

  test('rounds down, never up into the next unit', () => {
    expect(formatDuration(59 * MINUTE + 59_900)).toBe('59 minutes');
    expect(formatDuration(59_999)).toBe('59 seconds');
  });

  test('reports anything under a second as 0 seconds', () => {
    expect(formatDuration(0)).toBe('0 seconds');
    expect(formatDuration(999)).toBe('0 seconds');
  });
});
