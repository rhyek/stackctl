import { createElement as h } from 'react';
import { describe, expect, test } from 'vitest';
import {
  INK_VERSION,
  installLeanInkOutput,
  leanOutputMethods,
  loadInkOutput,
  type InkOutput,
} from './ink-output.js';

/** A small seeded generator, so a failure names a case that can be replayed. */
function random(seed: number) {
  let state = seed;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  return { next, int, pick };
}

const PIECES = [
  'abc',
  'hello world ',
  ' ',
  '界',
  '中文字',
  '👩‍💻',
  '​', // invisible: takes no cell
  '\n',
  '\x1b[31m',
  '\x1b[34m',
  '\x1b[39m',
  '\x1b[1m',
  '\x1b[2m',
  '\x1b[22m',
  '\x1b[0m',
  '\x1b[7m',
  '\x1b[27m',
  '\x1b[44m',
  '\x1b[49m',
  '\x1b[38;2;10;20;30m',
  '\x1b[38;5;200m',
  '\x1b]8;;https://example.com\x1b\\',
  '\x1b]8;;\x1b\\',
] as const;

const TRANSFORMERS: ((line: string, index: number) => string)[] = [
  (line) => `\x1b[32m${line}\x1b[39m`,
  (line, index) => (index % 2 === 0 ? `\x1b[1m${line}\x1b[22m` : line),
];

type Bound = number | undefined;
type OutputClass = new (options: { width: number; height: number }) => InkOutput & {
  write(x: number, y: number, text: string, options: { transformers: unknown[] }): void;
  clip(clip: { x1: Bound; x2: Bound; y1: Bound; y2: Bound }): void;
  unclip(): void;
};

const { version, Output } = await loadInkOutput();
const InkOutputClass = Output as unknown as OutputClass;
// Ink's own `get`, kept from before the test that installs the lean one over it.
const inkGet = Object.getOwnPropertyDescriptor(Output.prototype, 'get')!.value as InkOutput['get'];

/** One random frame's operations, written to a fresh Ink `Output`. */
function randomFrame(seed: number): InstanceType<OutputClass> {
  const r = random(seed);
  const output = new InkOutputClass({ width: r.int(1, 40), height: r.int(1, 12) });
  let open = 0;
  for (let op = r.int(1, 12); op > 0; op--) {
    const roll = r.next();
    if (roll < 0.15) {
      const bound = (): Bound => (r.next() < 0.2 ? undefined : r.int(-3, 40));
      output.clip({ x1: bound(), x2: bound(), y1: bound(), y2: bound() });
      open++;
    } else if (roll < 0.25 && open > 0) {
      output.unclip();
      open--;
    } else {
      let text = '';
      for (let i = r.int(0, 30); i > 0; i--) {
        text += r.pick(PIECES);
      }
      const transformers = TRANSFORMERS.filter(() => r.next() < 0.3);
      output.write(r.int(-4, 38), r.int(-2, 12), text, { transformers });
    }
  }
  return output;
}

/** The frame drawn by the lean methods, from the same operations. */
function leanGet(output: InkOutput) {
  const lean = Object.assign(Object.create(output) as InkOutput, leanOutputMethods);
  return lean.get();
}

describe('the lean Ink compositor', () => {
  test('was ported from the Ink stackctl loads', () => {
    // Upgrading Ink means porting the compositor again: see the comment atop ink-output.ts.
    expect(version).toBe(INK_VERSION);
  });

  // CPU-bound: a busy machine running the whole suite needs more than the default 5 s.
  test('draws every frame byte for byte as Ink does', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const output = randomFrame(seed);
      expect(leanGet(output), `seed ${seed}`).toEqual(inkGet.call(output));
    }
  }, 60_000);

  test('draws a blank frame the size of the output', () => {
    const output = new InkOutputClass({ width: 3, height: 2 });
    expect(leanGet(output)).toEqual({ output: '\n', height: 2 });
  });

  test('draws a real Ink tree as Ink does, once installed', async () => {
    const { Box, Text, renderToString } = await import('ink');
    const tree = h(
      Box,
      { flexDirection: 'column', width: 30, height: 6, borderStyle: 'round', overflow: 'hidden' },
      h(Text, { color: 'green', bold: true }, 'api  ready on :3000'),
      h(Text, { wrap: 'truncate-end' }, `${'界'.repeat(20)} truncated`),
      h(Text, { dimColor: true }, h(Text, { inverse: true }, 'selected'), ' rest'),
    );
    const before = renderToString(tree, { columns: 40 });
    expect(await installLeanInkOutput()).toBe(true);
    expect(Output.prototype.get === leanOutputMethods.get).toBe(true);
    expect(renderToString(tree, { columns: 40 })).toBe(before);
  });
});
