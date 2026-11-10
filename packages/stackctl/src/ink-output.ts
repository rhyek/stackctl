/**
 * A leaner frame compositor for Ink, put in place of Ink's own when the TUI starts.
 *
 * Ink draws a frame by laying every text node onto a grid of cells the size of the screen, then
 * turning each grid row back into a string (`Output.get()` in `ink/build/output.js`). It builds the
 * grid from scratch on every frame, one fresh object per cell, and turns a row back into a string by
 * diffing the styles of every pair of neighboring cells, which allocates several `Set`s and arrays
 * per cell even when both are blank. On a fullscreen TUI that is tens of thousands of short-lived
 * objects per frame: about 100 MB a second at a few frames a second, which V8 answers by growing
 * its young generation to 128 MB, so the session ends up holding several times the memory it
 * uses. (Measured with a 166×61 screen and four services logging.)
 *
 * This is Ink's `applyWriteOperation`, `sliceLineToColumns` and `get` ported as they are, with
 * three changes that leave every frame byte for byte the same:
 *
 * - The grid starts out filled with one shared blank cell. Ink never changes a cell in place, it
 *   only puts another in its slot, so the cells can be shared.
 * - A row is turned back into a string without diffing two neighbors whose styles are the same,
 *   since that diff is always empty. The same change is proposed upstream, in
 *   AlCalzone/ansi-tokenize#84. A line's characters also share one styles array per run of
 *   same-styled characters, so most comparisons end at the reference.
 * - Lines are tokenized once and kept for later frames (the most recent {@link STYLED_CACHE_SIZE}),
 *   where Ink tokenizes them again for every frame.
 *
 * Ink's internals change between releases, so this replaces them only on the version it was ported
 * from, {@link INK_VERSION}. `package.json` pins it, and the `@alcalzone/ansi-tokenize` this shares
 * with it. Any other version keeps Ink's own compositor.
 */
import fs from 'node:fs';
import {
  ansiCodesToString,
  diffAnsiCodes,
  reduceAnsiCodesIncremental,
  tokenize,
  type AnsiCode,
  type StyledChar,
} from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';

/** The Ink release this compositor was ported from. */
export const INK_VERSION = '8.0.0';

/** Tokenized lines kept across frames: a screen's worth of rows, and then some for scrolling. */
const STYLED_CACHE_SIZE = 512;

type Clip = {
  x1: number | undefined;
  x2: number | undefined;
  y1: number | undefined;
  y2: number | undefined;
};

type WriteOperation = {
  type: 'write';
  x: number;
  y: number;
  text: string;
  transformers: ((line: string, index: number) => string)[];
};

type Operation = WriteOperation | { type: 'clip'; clip: Clip } | { type: 'unclip' };

/** The members of Ink's `Output` that the port reads and replaces. */
export interface InkOutput {
  width: number;
  height: number;
  operations: Operation[];
  applyWriteOperation(output: StyledChar[][], operation: WriteOperation, clip?: Clip): void;
  sliceLineToColumns(line: string, from: number, to: number): string;
  get(): { output: string; height: number };
}

type InkOutputMethods = Pick<InkOutput, 'applyWriteOperation' | 'sliceLineToColumns' | 'get'>;

/** A map that forgets its least recently used entry past `max` entries. */
class Lru<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.map.set(key, value);
    if (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value!);
    }
  }
}

const styledCache = new Lru<StyledChar[]>(STYLED_CACHE_SIZE);
const widthCache = new Lru<number>(4096);

const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}+$/u;

/**
 * `styledCharsFromTokens`, but with one styles array for each run of characters in the same
 * style, where it copies the array for every character. The reducer returns a new array for every
 * code, so a later code never changes an earlier run's.
 */
function styledCharsFromTokens(text: string): StyledChar[] {
  let styles: AnsiCode[] = [];
  const chars: StyledChar[] = [];
  for (const token of tokenize(text)) {
    if (token.type === 'ansi') {
      styles = reduceAnsiCodesIncremental(styles, [token]);
    } else if (token.type === 'char') {
      chars.push({ ...token, styles });
    }
  }
  return chars;
}

function getStyledChars(line: string): StyledChar[] {
  let chars = styledCache.get(line);
  if (chars === undefined) {
    // Standalone invisible Unicode characters must not occupy terminal cells.
    chars = styledCharsFromTokens(line).filter((char) => !DEFAULT_IGNORABLE.test(char.value));
    styledCache.set(line, chars);
  }
  return chars;
}

function getStringWidth(text: string): number {
  if (text.length === 1) {
    const code = text.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) {
      return 1;
    }
  }
  let width = widthCache.get(text);
  if (width === undefined) {
    width = stringWidth(text);
    widthCache.set(text, width);
  }
  return width;
}

function getWidestLine(text: string): number {
  let width = 0;
  for (const line of text.split('\n')) {
    width = Math.max(width, getStringWidth(line));
  }
  return width;
}

/** Whether going from one reduced style to the other takes no codes. */
function isSameStyle(from: AnsiCode[], to: AnsiCode[]): boolean {
  if (from === to) {
    return true;
  }
  if (from.length !== to.length) {
    return false;
  }
  for (let i = 0; i < from.length; i++) {
    if (from[i]!.code !== to[i]!.code || from[i]!.endCode !== to[i]!.endCode) {
      return false;
    }
  }
  return true;
}

const NO_STYLES: AnsiCode[] = [];

/** `styledCharsToString`, skipping the diffs that come out empty. */
export function styledCharsToString(chars: StyledChar[]): string {
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (i === 0) {
      if (char.styles.length > 0) {
        out += ansiCodesToString(char.styles);
      }
    } else if (!isSameStyle(chars[i - 1]!.styles, char.styles)) {
      out += ansiCodesToString(diffAnsiCodes(chars[i - 1]!.styles, char.styles));
    }
    out += char.value;
    // Reset the active styles at the end of the string.
    if (i === chars.length - 1 && char.styles.length > 0) {
      out += ansiCodesToString(diffAnsiCodes(char.styles, NO_STYLES));
    }
  }
  return out;
}

// Replaces a partially visible wide character with a space that keeps its styles.
const blankCell = (cell: StyledChar): StyledChar => ({ ...cell, value: ' ', fullWidth: false });

const BLANK: StyledChar = Object.freeze({
  type: 'char',
  value: ' ',
  fullWidth: false,
  styles: NO_STYLES,
});

const intersectBound = (
  a: number | undefined,
  b: number | undefined,
  tighter: (a: number, b: number) => number,
): number | undefined => {
  if (a === undefined) {
    return b;
  }
  return b === undefined ? a : tighter(a, b);
};

// Bounds are half-open: `x2`/`y2` are exclusive.
const isClipEmpty = (clip: Clip): boolean =>
  (clip.x1 !== undefined && clip.x2 !== undefined && clip.x1 >= clip.x2) ||
  (clip.y1 !== undefined && clip.y2 !== undefined && clip.y1 >= clip.y2);

const intersectClips = (outer: Clip | undefined, inner: Clip): Clip => {
  if (!outer) {
    return inner;
  }
  return {
    x1: intersectBound(outer.x1, inner.x1, Math.max),
    x2: intersectBound(outer.x2, inner.x2, Math.min),
    y1: intersectBound(outer.y1, inner.y1, Math.max),
    y2: intersectBound(outer.y2, inner.y2, Math.min),
  };
};

/** The ported methods, to put on Ink's `Output.prototype`. */
export const leanOutputMethods: InkOutputMethods & ThisType<InkOutput> = {
  applyWriteOperation(output, operation, clip) {
    const { text, transformers } = operation;
    let { x, y } = operation;
    // Preserve styles across explicit newlines before clipping individual rows.
    const characterLines: StyledChar[][] = [[]];
    for (const character of getStyledChars(text)) {
      if (character.value === '\n') {
        characterLines.push([]);
      } else {
        characterLines.at(-1)!.push(character);
      }
    }
    let lines = characterLines.map((line) => styledCharsToString(line));
    if (clip) {
      // Two nested clips can intersect to nothing.
      if (isClipEmpty(clip)) {
        return;
      }
      const shouldClipHorizontally = typeof clip.x1 === 'number' && typeof clip.x2 === 'number';
      const shouldClipVertically = typeof clip.y1 === 'number' && typeof clip.y2 === 'number';
      if (shouldClipHorizontally) {
        const width = getWidestLine(text);
        if (x + width < clip.x1! || x > clip.x2!) {
          return;
        }
      }
      if (shouldClipVertically) {
        const height = lines.length;
        if (y + height < clip.y1! || y > clip.y2!) {
          return;
        }
      }
      if (shouldClipHorizontally) {
        lines = lines.map((line) => {
          const from = x < clip.x1! ? clip.x1! - x : 0;
          const width = getStringWidth(line);
          const to = x + width > clip.x2! ? clip.x2! - x : width;
          return this.sliceLineToColumns(line, from, to);
        });
        if (x < clip.x1!) {
          x = clip.x1!;
        }
      }
      if (shouldClipVertically) {
        const from = y < clip.y1! ? clip.y1! - y : 0;
        const height = lines.length;
        const to = y + height > clip.y2! ? clip.y2! - y : height;
        lines = lines.slice(from, to);
        if (y < clip.y1!) {
          y = clip.y1!;
        }
      }
    }
    for (let [index, line] of lines.entries()) {
      const currentLine = output[y + index];
      // Lines above or below the output area have no corresponding pre-initialized row.
      if (!currentLine) {
        continue;
      }
      for (const transformer of transformers) {
        line = transformer(line, index + y - operation.y);
      }
      const characters = getStyledChars(line);
      if (characters.length === 0) {
        continue;
      }
      let offsetX = x;
      // A wide character takes two cells, the second an empty placeholder. A write landing on
      // that placeholder blanks the character it belonged to, keeping its styles.
      if (
        currentLine[offsetX]?.value === '' &&
        offsetX > 0 &&
        getStringWidth(currentLine[offsetX - 1]?.value ?? '') > 1
      ) {
        currentLine[offsetX - 1] = blankCell(currentLine[offsetX - 1]!);
      }
      for (const character of characters) {
        currentLine[offsetX] = character;
        const characterWidth = Math.max(1, getStringWidth(character.value));
        // For multi-column characters, clear following cells to avoid stray spaces.
        for (let offset = 1; offset < characterWidth; offset++) {
          currentLine[offsetX + offset] = {
            type: 'char',
            // Preserve visible cells when the leading cell is outside the output.
            value: offsetX < 0 ? ' ' : '',
            fullWidth: false,
            styles: character.styles,
          };
        }
        offsetX += characterWidth;
      }
      if (currentLine[offsetX]?.value === '') {
        currentLine[offsetX] = blankCell(currentLine[offsetX]!);
      }
    }
  },

  // Clipping works in terminal columns: a wide character cut by a clip edge becomes a space that
  // keeps its styles.
  sliceLineToColumns(line, from, to) {
    if (from >= to) {
      return '';
    }
    const result: StyledChar[] = [];
    let column = 0;
    for (const character of getStyledChars(line)) {
      const width = getStringWidth(character.value);
      const start = column;
      column += width;
      if (column <= from) {
        continue;
      }
      if (start >= to) {
        break;
      }
      result.push(width > 1 && (start < from || column > to) ? blankCell(character) : character);
    }
    return styledCharsToString(result);
  },

  get() {
    // One row per line of height, so margin/padding at the bottom is preserved.
    const output: StyledChar[][] = [];
    for (let y = 0; y < this.height; y++) {
      const row: StyledChar[] = [];
      for (let x = 0; x < this.width; x++) {
        row.push(BLANK);
      }
      output.push(row);
    }
    const clips: Clip[] = [];
    for (const operation of this.operations) {
      if (operation.type === 'clip') {
        // Nested clips intersect, so an inner one can't let content escape an outer one.
        clips.push(intersectClips(clips.at(-1), operation.clip));
      } else if (operation.type === 'unclip') {
        clips.pop();
      } else {
        this.applyWriteOperation(output, operation, clips.at(-1));
      }
    }
    let generated = '';
    for (let y = 0; y < output.length; y++) {
      if (y > 0) {
        generated += '\n';
      }
      // A wide character at the edge can leave a hole past it (ink#564).
      generated += styledCharsToString(output[y]!.filter((cell) => cell !== undefined)).trimEnd();
    }
    return { output: generated, height: output.length };
  },
};

/** The `Output` class of the Ink that stackctl loads, with the version it came from. */
export async function loadInkOutput(): Promise<{
  version: string;
  Output: { prototype: InkOutput };
}> {
  // Ink's package exports only its entry, so its modules are reached through that entry's URL:
  // the same file, so the same module instance, that Ink itself renders with.
  const entry = import.meta.resolve('ink');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', entry), 'utf8')) as {
    version: string;
  };
  const mod = (await import(new URL('./output.js', entry).href)) as {
    default: { prototype: InkOutput };
  };
  return { version: pkg.version, Output: mod.default };
}

/**
 * Put the lean compositor in place of Ink's, when Ink is the version it was ported from. Returns
 * whether it did.
 */
export async function installLeanInkOutput(): Promise<boolean> {
  const { version, Output } = await loadInkOutput();
  if (version !== INK_VERSION) {
    return false;
  }
  Object.assign(Output.prototype, leanOutputMethods);
  return true;
}
