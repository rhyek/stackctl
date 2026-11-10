/**
 * Mouse handling for the fullscreen TUI: SGR mouse reporting, so we can drive an
 * app-managed drag-to-select-and-copy. The terminal's own text selection can't
 * survive our in-place repaints (scrolling and new log lines rewrite the cells
 * under the highlight), so we replace it with a selection anchored to the log
 * content — see docs/architecture/rendering.md.
 *
 * We enable button-event tracking (`?1002h` — reports press, drag-motion while a
 * button is held, and release) with SGR extended coordinates (`?1006h` — 1-based,
 * and free of the legacy 223-column cap). The mouse wheel arrives as button 64
 * (up) / 65 (down). Enabling reporting means the terminal no longer runs its own
 * click-drag selection; ours replaces it (power users can hold Option/Alt in most
 * terminals to force native selection). Both modes MUST be disabled on teardown,
 * or the terminal is left capturing the mouse.
 */
const ESC = String.fromCharCode(27);

/** Enable SGR mouse reporting (button-event tracking + SGR coords). Write on mount. */
export const MOUSE_ENABLE = `${ESC}[?1002h${ESC}[?1006h`;
/** Disable SGR mouse reporting. Write on unmount / before exit. */
export const MOUSE_DISABLE = `${ESC}[?1006l${ESC}[?1002l`;

/** A decoded SGR mouse report. Coordinates are 1-based terminal cells. */
export type MouseReport =
  | { type: 'down' | 'up' | 'move'; button: number; col: number; row: number }
  | { type: 'wheel'; dir: 'up' | 'down'; col: number; row: number };

// SGR mouse report: ESC[<Cb;Cx;Cy(M|m).
// oxlint-disable-next-line no-control-regex -- matches SGR mouse-report escape sequences
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Decode every SGR mouse report in `data`, in order (a fast drag can pack several
 * into one read). Non-mouse bytes are ignored.
 *
 * The button byte `Cb` encodes: the low two bits are the button (0 = left), bit
 * 5 (32) marks drag-motion, bits 6–7 (64) mark the wheel (64 = up, 65 = down),
 * and the final `M`/`m` distinguishes press-or-motion from release.
 */
export function parseMouseEvents(data: string): MouseReport[] {
  const events: MouseReport[] = [];
  SGR_MOUSE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_MOUSE.exec(data)) !== null) {
    const cb = Number(match[1]);
    const col = Number(match[2]);
    const row = Number(match[3]);
    const release = match[4] === 'm';
    if (cb & 64) {
      events.push({ type: 'wheel', dir: cb & 1 ? 'down' : 'up', col, row });
    } else if (release) {
      events.push({ type: 'up', button: cb & 3, col, row });
    } else if (cb & 32) {
      events.push({ type: 'move', button: cb & 3, col, row });
    } else {
      events.push({ type: 'down', button: cb & 3, col, row });
    }
  }
  return events;
}

/**
 * The header of a **legacy X10** mouse report, `ESC[M`, which is followed by three coordinate
 * bytes (button, column, row, each offset by 32).
 *
 * We never ask for this encoding — `MOUSE_ENABLE` requests SGR (`?1006h`) — so one
 * showing up means the terminal dropped our encoding mode behind our back and fell
 * back to the default. The VS Code integrated terminal does exactly that on "Reload
 * Window": a reattached terminal is restored from a serialized snapshot that
 * re-emits the mouse *tracking* mode (`?1002h`) but not the *encoding* mode, so
 * reports resume in X10 and stop decoding — the wheel and drag-select go dead while
 * the keyboard keeps working.
 *
 * Treat one as a signal to re-assert `MOUSE_ENABLE`, not as an event to handle:
 * X10 caps coordinates at column 223 and encodes them as raw bytes that UTF-8
 * decoding mangles past column 95, so the report itself isn't worth decoding when
 * re-asserting brings SGR straight back.
 */
const LEGACY_HEADER = `${ESC}[M`;

// The start of a mouse report a read ended in the middle of: ESC, ESC[, or ESC[ and an
// unterminated SGR report.
// oxlint-disable-next-line no-control-regex -- matches the start of a mouse-report escape sequence
const PARTIAL_REPORT = /\x1b(?:\[(?:<[\d;]*)?)?$/;

/** What one stdin chunk carried: its SGR reports, and whether a legacy X10 report started in it. */
export type MouseChunk = { reports: MouseReport[]; legacy: boolean };

/**
 * A decoder for raw stdin chunks, which is where mouse reports are read: Ink never hands one
 * to `useInput`, as it drops terminal sequences that map to no key. A chunk is whatever one read
 * returned, so it can mix reports with keys, and a report can be split across two reads — the
 * decoder keeps a report's unfinished start and decodes it with the next chunk.
 */
export function createMouseDecoder(): (chunk: string) => MouseChunk {
  let carry = '';
  return (chunk) => {
    const data = carry + chunk;
    SGR_MOUSE.lastIndex = 0;
    let rest = 0;
    while (SGR_MOUSE.exec(data) !== null) {
      rest = SGR_MOUSE.lastIndex;
    }
    carry = PARTIAL_REPORT.exec(data.slice(rest))?.[0] ?? '';
    return { reports: parseMouseEvents(data), legacy: data.includes(LEGACY_HEADER) };
  };
}
