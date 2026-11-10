/**
 * A minimal VT screen: enough of a terminal emulator to know what is on a fullscreen Ink TUI's
 * screen right now, cell by cell. Ink repaints only what changed, so the raw stream never holds a
 * whole frame as one string, and a click needs a row and a column.
 *
 * It keeps the characters and each cell's foreground color (as its SGR code), and implements the cursor moves, erases, scrolls and
 * private modes the TUI emits. The private modes are kept as set or reset, which is how a test
 * checks that mouse reporting was switched off.
 */
import stringWidth from 'string-width';

/** A cell's text: one character, or `''` for the right half of a wide one. */
type Row = string[];

const blankRow = (cols: number): Row => Array.from({ length: cols }, () => ' ');

/**
 * Each row's foreground colors, cell by cell, as the SGR code that set it (`'32'`, `'38;2;…'`), or
 * `''` for the default. Kept beside the row rather than in it, so a whole row moved by a scroll or
 * an insert takes its colors along.
 */
const colorsOf = new WeakMap<Row, string[]>();
function colors(row: Row): string[] {
  let c = colorsOf.get(row);
  if (!c) {
    c = Array.from({ length: row.length }, () => '');
    colorsOf.set(row, c);
  }
  return c;
}

export class Screen {
  rows: number;
  cols: number;
  private grid: Row[];
  private r = 0;
  private c = 0;
  private saved: [number, number] = [0, 0];
  private pending = '';
  /** The foreground color the next character is drawn in. */
  private fg = '';
  private readonly decoder = new TextDecoder('utf-8');
  /** Every private mode (`ESC[?<n>h` / `ESC[?<n>l`) the program has set (`true`) or reset. */
  readonly modes = new Map<number, boolean>();
  /** Called as each synchronized update (`ESC[?2026h` … `ESC[?2026l`), a frame, is complete. */
  onFrameEnd: (() => void) | undefined;

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.grid = Array.from({ length: rows }, () => blankRow(cols));
  }

  /** A copy of the screen as it is now, which further output doesn't change. */
  clone(): Screen {
    const copy = new Screen(this.rows, this.cols);
    copy.grid = this.grid.map((row) => {
      const next = [...row];
      colorsOf.set(next, [...colors(row)]);
      return next;
    });
    copy.r = this.r;
    copy.c = this.c;
    copy.saved = [...this.saved];
    this.modes.forEach((on, mode) => copy.modes.set(mode, on));
    return copy;
  }

  resize(rows: number, cols: number): void {
    const grid = Array.from({ length: rows }, (_, i) =>
      Array.from({ length: cols }, (_, j) => this.grid[i]?.[j] ?? ' '),
    );
    this.grid = grid;
    this.rows = rows;
    this.cols = cols;
    this.r = Math.min(this.r, rows - 1);
    this.c = Math.min(this.c, cols - 1);
  }

  /** The screen as text: each row with its trailing blanks trimmed, then trailing blank rows. */
  dump(): string {
    const lines = this.lines();
    while (lines.length > 0 && lines.at(-1) === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  /** The foreground color of each cell of row `i` (0-based), as {@link colorsOf} keeps it. */
  colorsAt(i: number): readonly string[] {
    const row = this.grid[i];
    return row ? colors(row) : [];
  }

  /** Each row as text, trailing blanks trimmed. */
  lines(): string[] {
    return this.grid.map((row) => row.join('').trimEnd());
  }

  /**
   * Where `text` last appears on the screen (the lowest row holding it, its last occurrence
   * there), as the 1-based row and column a mouse event names; `null` when it isn't on screen.
   */
  find(text: string): { row: number; col: number } | null {
    for (let i = this.grid.length - 1; i >= 0; i--) {
      const row = this.grid[i]!;
      // The row as a string, and the column each of its UTF-16 units starts in.
      let line = '';
      const columnAt: number[] = [];
      row.forEach((cell, col) => {
        for (let k = 0; k < cell.length; k++) {
          columnAt.push(col);
        }
        line += cell;
      });
      const at = line.lastIndexOf(text);
      if (at >= 0) {
        return { row: i + 1, col: columnAt[at]! + 1 };
      }
    }
    return null;
  }

  feed(data: Uint8Array): void {
    const s = this.pending + this.decoder.decode(data, { stream: true });
    this.pending = '';
    let i = 0;
    const n = s.length;
    while (i < n) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        if (i + 1 >= n) {
          this.pending = s.slice(i);
          return;
        }
        const next = s[i + 1]!;
        if (next === '[') {
          let j = i + 2;
          while (j < n && !(s[j]! >= '@' && s[j]! <= '~')) {
            j++;
          }
          if (j >= n) {
            this.pending = s.slice(i);
            return;
          }
          this.csi(s.slice(i + 2, j), s[j]!);
          i = j + 1;
          continue;
        }
        if (next === ']') {
          // An OSC string (a title, an OSC-8 link), ended by BEL or ST (ESC \).
          let j = i + 2;
          while (j < n && s[j] !== '\x07' && s[j] !== '\x1b') {
            j++;
          }
          if (j >= n || (s[j] === '\x1b' && j + 1 >= n)) {
            this.pending = s.slice(i);
            return;
          }
          i = j + (s[j] === '\x07' ? 1 : s[j + 1] === '\\' ? 2 : 0);
          continue;
        }
        if (next === '(' || next === ')') {
          if (i + 2 >= n) {
            this.pending = s.slice(i);
            return;
          }
          i += 3;
          continue;
        }
        if (next === '7') {
          this.saved = [this.r, this.c];
        } else if (next === '8') {
          [this.r, this.c] = this.saved;
        }
        i += 2;
        continue;
      }
      if (ch === '\r') {
        this.c = 0;
      } else if (ch === '\n') {
        this.lineFeed();
      } else if (ch === '\b') {
        this.c = Math.max(0, this.c - 1);
      } else if (ch === '\t') {
        this.c = Math.min(this.cols - 1, (Math.floor(this.c / 8) + 1) * 8);
      } else if (ch >= ' ' && ch !== '\x7f') {
        const cp = s.codePointAt(i)!;
        const glyph = String.fromCodePoint(cp);
        this.put(glyph);
        i += glyph.length;
        continue;
      }
      i++;
    }
  }

  private lineFeed(): void {
    if (this.r === this.rows - 1) {
      this.grid.shift();
      this.grid.push(blankRow(this.cols));
    } else {
      this.r++;
    }
  }

  private put(glyph: string): void {
    const w = stringWidth(glyph);
    if (w === 0) {
      return;
    }
    if (this.c + w > this.cols) {
      this.c = 0;
      this.lineFeed();
    }
    const row = this.grid[this.r]!;
    row[this.c] = glyph;
    colors(row)[this.c] = this.fg;
    if (w === 2 && this.c + 1 < this.cols) {
      row[this.c + 1] = '';
      colors(row)[this.c + 1] = this.fg;
    }
    // Past the last column, the wrap is deferred to the next character.
    this.c += w;
  }

  private csi(params: string, final: string): void {
    const priv = /^[?<>=]/.test(params);
    const nums = params
      .replace(/^[?<>=]/, '')
      .split(/[;:]/)
      .filter((x) => x !== '')
      .map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
    const a = nums[0] ?? 0;
    const one = a || 1;
    const row = this.grid[this.r]!;
    if (priv) {
      if (final === 'h' || final === 'l') {
        for (const mode of nums) {
          this.modes.set(mode, final === 'h');
        }
        if (final === 'l' && nums.includes(2026)) {
          this.onFrameEnd?.();
        }
        if (final === 'h' && nums.includes(1049)) {
          this.grid = Array.from({ length: this.rows }, () => blankRow(this.cols));
          this.r = 0;
          this.c = 0;
        }
      }
      return;
    }
    switch (final) {
      case 'H':
      case 'f':
        this.r = Math.min(this.rows - 1, Math.max(1, nums[0] ?? 1) - 1);
        this.c = Math.min(this.cols - 1, Math.max(1, nums[1] ?? 1) - 1);
        break;
      case 'A':
        this.r = Math.max(0, this.r - one);
        break;
      case 'B':
        this.r = Math.min(this.rows - 1, this.r + one);
        break;
      case 'C':
        this.c = Math.min(this.cols - 1, this.c + one);
        break;
      case 'D':
        this.c = Math.max(0, Math.min(this.c, this.cols - 1) - one);
        break;
      case 'G':
        this.c = Math.min(this.cols - 1, one - 1);
        break;
      case 'd':
        this.r = Math.min(this.rows - 1, one - 1);
        break;
      case 'J':
        if (a === 0) {
          this.erase(row, Math.min(this.c, this.cols));
          for (let k = this.r + 1; k < this.rows; k++) {
            this.grid[k] = blankRow(this.cols);
          }
        } else if (a === 1) {
          for (let k = 0; k < this.r; k++) {
            this.grid[k] = blankRow(this.cols);
          }
          this.erase(row, 0, Math.min(this.c + 1, this.cols));
        } else {
          this.grid = Array.from({ length: this.rows }, () => blankRow(this.cols));
        }
        break;
      case 'K':
        if (a === 0) {
          this.erase(row, Math.min(this.c, this.cols));
        } else if (a === 1) {
          this.erase(row, 0, Math.min(this.c + 1, this.cols));
        } else {
          this.erase(row, 0);
        }
        break;
      case 'L':
        for (let k = 0; k < one; k++) {
          this.grid.splice(this.r, 0, blankRow(this.cols));
          this.grid.pop();
        }
        break;
      case 'M':
        for (let k = 0; k < one; k++) {
          this.grid.splice(this.r, 1);
          this.grid.push(blankRow(this.cols));
        }
        break;
      case 'S':
        for (let k = 0; k < one; k++) {
          this.grid.shift();
          this.grid.push(blankRow(this.cols));
        }
        break;
      case 'T':
        for (let k = 0; k < one; k++) {
          this.grid.unshift(blankRow(this.cols));
          this.grid.pop();
        }
        break;
      case 'P':
        row.splice(this.c, one);
        colors(row).splice(this.c, one);
        while (row.length < this.cols) {
          row.push(' ');
          colors(row).push('');
        }
        break;
      case 'X':
        this.erase(row, this.c, Math.min(this.c + one, this.cols));
        break;
      case 's':
        this.saved = [this.r, this.c];
        break;
      case 'u':
        [this.r, this.c] = this.saved;
        break;
      case 'm':
        this.sgr(params);
        break;
      default:
        // Anything else: no effect on the characters.
        break;
    }
  }

  /** Blanks cells `from` up to `to` (the row's end by default), color and all. */
  private erase(row: Row, from: number, to = row.length): void {
    row.fill(' ', from, to);
    colors(row).fill('', from, to);
  }

  /** Tracks the foreground color through an SGR sequence's parameters. */
  private sgr(params: string): void {
    const parts = params === '' ? ['0'] : params.split(';');
    for (let i = 0; i < parts.length; i++) {
      const n = Number(parts[i]);
      if (n === 0 || n === 39) {
        this.fg = '';
      } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
        this.fg = String(n);
      } else if (n === 38) {
        const span = parts[i + 1] === '2' ? 5 : 3;
        this.fg = parts.slice(i, i + span).join(';');
        i += span - 1;
      }
    }
  }
}
