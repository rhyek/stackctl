/**
 * The colors of a formatted structured-log line, part of the palette in `colors.ts` (which
 * re-exports them). Kept apart because a config file loads them through `logging`, and the rest of
 * the palette loads colord.
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
