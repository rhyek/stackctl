import { Buffer } from 'node:buffer';
import { describe, test, expect } from 'vitest';
import { copyToClipboard, osc52 } from './clipboard.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('osc52', () => {
  test('wraps the base64-encoded text in an OSC 52 clipboard-set sequence', () => {
    const seq = osc52('hi');
    expect(seq).toBe(`${ESC}]52;c;${Buffer.from('hi', 'utf8').toString('base64')}${BEL}`);
  });

  test('round-trips UTF-8 (including newlines and wide glyphs) through base64', () => {
    const text = 'line one\nlíne two 世';
    const seq = osc52(text)!;
    const base64 = seq.slice(`${ESC}]52;c;`.length, -1);
    expect(Buffer.from(base64, 'base64').toString('utf8')).toBe(text);
  });

  test('returns null when the payload is too large to send safely', () => {
    expect(osc52('x'.repeat(200_000))).toBeNull();
  });
});

describe('copyToClipboard', () => {
  test('over SSH, writes the OSC 52 sequence (a native command would target the remote host)', () => {
    const prev = process.env.SSH_TTY;
    process.env.SSH_TTY = '/dev/ttys000';
    try {
      const writes: string[] = [];
      copyToClipboard('hello', (data) => writes.push(data));
      expect(writes).toEqual([osc52('hello')]);
    } finally {
      if (prev === undefined) {
        delete process.env.SSH_TTY;
      } else {
        process.env.SSH_TTY = prev;
      }
    }
  });

  test('does nothing for empty text', () => {
    const writes: string[] = [];
    copyToClipboard('', (data) => writes.push(data));
    expect(writes).toEqual([]);
  });
});
