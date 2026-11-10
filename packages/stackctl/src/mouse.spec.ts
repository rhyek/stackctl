import { describe, test, expect } from 'vitest';
import { createMouseDecoder, parseMouseEvents } from './mouse.js';

const ESC = String.fromCharCode(27);
/** Build an SGR mouse report: button byte `cb` at 1-based (col,row); `release` uses the `m` terminator. */
const sgr = (cb: number, col: number, row: number, release = false) =>
  `${ESC}[<${cb};${col};${row}${release ? 'm' : 'M'}`;

describe('parseMouseEvents', () => {
  test('decodes a left-button press', () => {
    expect(parseMouseEvents(sgr(0, 10, 5))).toEqual([{ type: 'down', button: 0, col: 10, row: 5 }]);
  });

  test('decodes drag-motion (button held) via the motion bit (32)', () => {
    expect(parseMouseEvents(sgr(32, 11, 5))).toEqual([
      { type: 'move', button: 0, col: 11, row: 5 },
    ]);
  });

  test('decodes a release via the `m` terminator', () => {
    expect(parseMouseEvents(sgr(0, 12, 5, true))).toEqual([
      { type: 'up', button: 0, col: 12, row: 5 },
    ]);
  });

  test('decodes wheel up (64) and wheel down (65)', () => {
    expect(parseMouseEvents(sgr(64, 3, 3))).toEqual([{ type: 'wheel', dir: 'up', col: 3, row: 3 }]);
    expect(parseMouseEvents(sgr(65, 3, 3))).toEqual([
      { type: 'wheel', dir: 'down', col: 3, row: 3 },
    ]);
  });

  test('decodes several reports packed into one read, in order', () => {
    const chunk = sgr(0, 1, 1) + sgr(32, 2, 1) + sgr(32, 3, 1) + sgr(0, 3, 1, true);
    expect(parseMouseEvents(chunk).map((e) => e.type)).toEqual(['down', 'move', 'move', 'up']);
  });

  test('ignores a report without its leading ESC, which is text someone typed', () => {
    expect(parseMouseEvents(`[<0;7;2M`)).toEqual([]);
  });

  test('ignores non-mouse input (plain keys, arrow-key CSI)', () => {
    expect(parseMouseEvents('a')).toEqual([]);
    expect(parseMouseEvents(`${ESC}[A`)).toEqual([]); // up arrow
  });
});

describe('createMouseDecoder', () => {
  test('decodes the reports in a chunk that mixes them with keys', () => {
    const decode = createMouseDecoder();
    expect(decode(`a${sgr(64, 3, 3)}b${sgr(0, 4, 4)}`)).toEqual({
      reports: [
        { type: 'wheel', dir: 'up', col: 3, row: 3 },
        { type: 'down', button: 0, col: 4, row: 4 },
      ],
      legacy: false,
    });
  });

  test('decodes a report split across two reads once its end arrives', () => {
    const decode = createMouseDecoder();
    const report = sgr(65, 10, 20);
    for (const at of [1, 2, 3, 6, report.length - 1]) {
      expect(decode(`x${report.slice(0, at)}`).reports).toEqual([]);
      expect(decode(report.slice(at)).reports).toEqual([
        { type: 'wheel', dir: 'down', col: 10, row: 20 },
      ]);
    }
  });

  test('drops an unfinished start the next read does not complete', () => {
    const decode = createMouseDecoder();
    decode(`${ESC}[<0;1`);
    expect(decode('a').reports).toEqual([]);
    expect(decode(';1M').reports).toEqual([]);
  });

  test('reports a legacy X10 report, including one whose header is split', () => {
    expect(createMouseDecoder()(`${ESC}[M !!`)).toEqual({ reports: [], legacy: true });
    const decode = createMouseDecoder();
    expect(decode(`${ESC}[`).legacy).toBe(false);
    expect(decode('M !!').legacy).toBe(true);
  });

  test('is not fooled by an arrow key or pasted text starting with `[M`', () => {
    const decode = createMouseDecoder();
    expect(decode(`${ESC}[A`)).toEqual({ reports: [], legacy: false });
    expect(decode('[Match')).toEqual({ reports: [], legacy: false });
  });
});
