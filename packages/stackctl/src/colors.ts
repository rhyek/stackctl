/**
 * Every color stackctl paints its own interface with, in one place.
 *
 * Constants here are **values, not styling**: a color spec, never a chalk formatter
 * or an Ink element. Callers decide how to apply one (Ink's `color=` prop, a
 * `chalk.hex(...)` call, bold or not), which keeps this file free of both React and
 * chalk and makes the whole palette readable at a glance.
 *
 * Two things deliberately live elsewhere:
 *
 * - **Which role a thing plays** — e.g. that a `starting` package is "warning". Those
 *   mappings sit next to the code that draws them (a toast tone's color in
 *   `ToastStack`), so this file answers "what color is that?" and never "what does it mean?".
 * - **The allowlist of color names a user may set** via a package's `color:` option
 *   (`NAMED_COLORS` in `session/supervisor.ts`). That's input validation over chalk's
 *   surface, not part of stackctl's palette.
 */

import { colord } from 'colord';

/** An Ink/chalk color: a name (`'cyan'`) or a hex string (`'#58a6ff'`). */
export type Color = string;

// ---------------------------------------------------------------------------
// Roles — the basic vocabulary the UI is drawn in.
// ---------------------------------------------------------------------------

/** Headings, labels, banners, and the active row in the package selector. */
export const ACCENT_COLOR: Color = 'cyan';
/** Text drawn *on top of* `ACCENT_COLOR` as a background (the phase banners). */
export const ON_ACCENT_COLOR: Color = 'black';
/** Success. */
export const OK_COLOR: Color = 'green';
/**
 * The workspace's name on the rule lines, in the terminal's own cyan, as a shell prompt draws
 * the directory.
 */
export const WORKSPACE_COLOR: Color = 'cyan';
/** The checked-out git branch beside it, in the terminal's own blue, as a prompt's `git:`. */
export const BRANCH_COLOR: Color = 'blue';
/** In-progress and advisory states. */
export const WARN_COLOR: Color = 'yellow';
/** Failures. */
export const DANGER_COLOR: Color = 'red';
/** De-emphasized text that is still content, not chrome. */
export const MUTED_COLOR: Color = 'gray';

// ---------------------------------------------------------------------------
// Footer affordances
// ---------------------------------------------------------------------------

/**
 * An informational toast — "copied N chars to clipboard" is the archetype (see
 * `TONE_COLORS` in `components/ToastStack.tsx`). A warm yellow-orange: it has to
 * carry no alarm (it's good news) while staying legible against a wall of log
 * text, and it must not read as any of the basic-ANSI status colors, since
 * green/cyan/yellow/red/gray all mean something about a package (and green is also
 * the branch). Truecolor rather than a color name for exactly that reason —
 * it sits beside plain `yellow`, not on it. Never bold.
 *
 * Hue ~39°: amber, between orange (30°) and yellow (60°). Tuned by moving the green
 * channel alone, so saturation and brightness are untouched and the shift reads as
 * hue rather than as a different-intensity color.
 */
export const NOTICE_COLOR: Color = '#ffbc40';

/**
 * Whatever the cursor is on: the picker's `❯`, the name beside it and the filter's text cursor,
 * and the selected row in the commands menu and the border stackctl draws around that mode. A
 * soft periwinkle: cool against the warm {@link NOTICE_COLOR}, so where you are never reads as
 * something stackctl is telling you.
 *
 * Not bold: the color alone carries it, and the `❯` marker already says which row.
 */
export const FOCUS_COLOR: Color = '#8185f3';

/**
 * The focused service's name in the run screen's footer, drawn bold too: plain
 * white, since every hue down there already says something about a service.
 */
export const SELECTED_COLOR: Color = 'white';

/**
 * A dependency a picked service needs, in the picker: its `◉`. {@link FOCUS_COLOR} muted and
 * darkened, so it reads as the same family as a pick, a step back.
 */
export const NEEDED_COLOR: Color = colord(FOCUS_COLOR).desaturate(0.54).darken(0.3).toHex();

/**
 * Every clickable affordance: the footer's URL links, the ⧉ copy glyph, and the
 * ↓ indicator's "Click here". A brighter blue than Ink's default, which is too dark
 * to read on a dark background.
 */
export const LINK_COLOR: Color = '#58a6ff';

/** The key in a `key: label` hotkey hint — brightest, since it's what you press. */
export const HOTKEY_KEY_COLOR: Color = 'white';
/** The label after a hotkey's key: readable, but a step down from the key itself. */
export const HOTKEY_LABEL_COLOR: Color = '#bbbbbb';

// ---------------------------------------------------------------------------
// Log prefixes
// ---------------------------------------------------------------------------

/**
 * stackctl's own log channels (`[stackctl]`, `[dt:control]`) — a warm gold that reads
 * as the tool's own voice, distinct from the per-package prefix colors.
 */
export const STACKCTL_LABEL_COLOR: Color = '#d7af5f';

/**
 * Package-identity colors for log prefixes. Vivid truecolor shades — deliberately
 * distinct from the dull basic-ANSI colors the status text and dots use — and no pink
 * or pastels.
 *
 * The order is a priority order, not a walk around the color wheel: a workspace of N
 * packages wears the first N, so the leading entries are the ones most workspaces
 * ever show. Preview a change — to the colors or to their order — with `pnpm palette`
 * (`scripts/palette-preview.ts`) before making it.
 */
export const PACKAGE_PALETTE: readonly Color[] = [
  '#1FC5DA', // cyan
  '#E74F62', // crimson
  '#7898FC', // periwinkle
  '#1FB5FA', // blue
  '#FEBF33', // gold
  '#5BCD4F', // green
  '#BF98FD', // lavender
  '#FE8445', // orange
  '#07CEA9', // teal
  '#D8D100', // yellow
];

// ---------------------------------------------------------------------------
// Structured-log formatting
// ---------------------------------------------------------------------------

/**
 * The bracketed `[LEVEL]` token of a recognized level. Unknown levels stay uncolored.
 * `FATAL` shares `ERROR`'s red and is distinguished by bold at the point of use.
 */
export const LOG_LEVEL_COLORS = {
  TRACE: 'gray',
  DEBUG: 'cyan',
  INFO: 'green',
  WARN: 'yellow',
  ERROR: 'red',
  FATAL: 'red',
} as const;

/**
 * The `key` of a rendered `key: value` property line — muted so it reads as a label
 * and the value (the data) stands out in the normal foreground.
 */
export const LOG_PROPERTY_KEY_COLOR = 'gray' as const;
