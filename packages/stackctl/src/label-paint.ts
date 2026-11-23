import chalk from 'chalk';

// How a service's `color` paints its label: shared by a session's log and the many form of
// `exec`/`run`, so it imports nothing but chalk and keeps a one-off command light.

/** Paints a label. */
export type Paint = (text: string) => string;

/** The color names a service's `color` may be: chalk's foreground colors, nothing else. */
const NAMED_COLORS = new Set([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'grey',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
]);

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
const RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
const ANSI256 = /^ansi256\(\s*(\d{1,3})\s*\)$/;

/**
 * How a service's `color` paints its label: a hex, `rgb(…)`, `ansi256(…)` or a chalk foreground
 * color name; `undefined` for anything else, which leaves the label uncolored.
 */
export function paintOfColor(color: string): Paint | undefined {
  const hex = HEX.exec(color);
  if (hex) {
    return chalk.hex(`#${hex[1]!}`);
  }
  const rgb = RGB.exec(color);
  if (rgb) {
    const [r, g, b] = rgb.slice(1).map(Number) as [number, number, number];
    return r <= 255 && g <= 255 && b <= 255 ? chalk.rgb(r, g, b) : undefined;
  }
  const ansi = ANSI256.exec(color);
  if (ansi) {
    const n = Number(ansi[1]);
    return n <= 255 ? chalk.ansi256(n) : undefined;
  }
  return NAMED_COLORS.has(color) ? chalk[color as 'red'] : undefined;
}
