/**
 * The colors of a formatted structured-log line, and the package palette services' labels wear:
 * part of the palette in `colors.ts` (which re-exports them). Kept apart because a config file
 * loads the first through `logging`, and a one-off command the second, and the rest of the
 * palette loads colord.
 */

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
export const PACKAGE_PALETTE: readonly string[] = [
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

/**
 * A service's label color: its own `color`, else the palette's at `position`, the service's
 * place among those labelled together, cycling.
 */
export function labelColorOf(color: string | undefined, position: number): string {
  return color ?? PACKAGE_PALETTE[position % PACKAGE_PALETTE.length]!;
}
