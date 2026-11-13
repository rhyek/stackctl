#!/usr/bin/env node
// Writes stackctl's file icon for VS Code's two most used icon themes into
// maintenance/icon-themes/, from the icon's small version, docs/public/logo-small.svg.
//
//   node maintenance/scripts/icon-themes.ts
//
// Each theme has its own rules, so each gets its own drawing of the same geometry:
//
// - vscode-icons: the icon as it is, tile and brand colors, on the 32-unit canvas its svglint
//   requires, inset 2 units like the theme's other icons, at most 3 decimals.
// - Material Icon Theme: the prompt and the three lines without the tile, filling the canvas
//   but a 2.5-unit margin, in colors from the Material palette its color linter allows, with a
//   darker copy for light themes (`_light`), at most 2 decimals.
//
// Run it after a change to logo-small.svg, and commit what it writes with that change.
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '../..');
const source = path.join(root, 'docs/public/logo-small.svg');
const out = path.join(root, 'maintenance/icon-themes');

type Element = { tag: 'rect' | 'path'; attrs: Record<string, string> };

const svg = fs.readFileSync(source, 'utf8');
const elements: Element[] = [...svg.matchAll(/<(rect|path)\b([^>]*?)\/>/g)].map(
  ([, tag, body]) => ({
    tag: tag as Element['tag'],
    attrs: Object.fromEntries(
      [...body!.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name!, value!]),
    ),
  }),
);
const isTile = ({ tag, attrs }: Element) =>
  tag === 'rect' && attrs.width === '64' && attrs.height === '64';
const tile = elements.find(isTile);
const glyph = elements.filter((element) => !isTile(element));
if (!tile || glyph.length === 0) {
  throw new Error(`icon-themes: ${source} has no 64-unit tile, or nothing on it`);
}

/** The points of a path drawn with absolute `M`/`L` commands, the only ones the icon uses. */
function points(d: string): [number, number][] {
  if (!/^[ML\d.\s-]+$/.test(d)) {
    throw new Error(`icon-themes: path "${d}" uses more than absolute M and L`);
  }
  return [...d.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)]);
}

/** The glyph's extent, strokes included: [minX, minY, maxX, maxY]. */
function bounds(parts: Element[]): [number, number, number, number] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const { tag, attrs } of parts) {
    if (tag === 'rect') {
      const [x, y] = [Number(attrs.x ?? 0), Number(attrs.y ?? 0)];
      xs.push(x, x + Number(attrs.width));
      ys.push(y, y + Number(attrs.height));
    } else {
      const half = Number(attrs['stroke-width'] ?? 0) / 2;
      for (const [x, y] of points(attrs.d!)) {
        xs.push(x - half, x + half);
        ys.push(y - half, y + half);
      }
    }
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Draws the parts scaled by `scale`, moved by `offset`, recolored through `color`. */
function draw(
  parts: Element[],
  scale: number,
  offset: [number, number],
  precision: number,
  color: (hex: string) => string,
): string {
  const n = (value: number) => String(Math.round(value * 10 ** precision) / 10 ** precision);
  const x = (value: number) => n(value * scale + offset[0]);
  const y = (value: number) => n(value * scale + offset[1]);
  const length = (value: string) => n(Number(value) * scale);
  return parts
    .map(({ tag, attrs }) => {
      if (tag === 'rect') {
        const rx = attrs.rx ? ` rx="${length(attrs.rx)}"` : '';
        return (
          `<rect width="${length(attrs.width!)}" height="${length(attrs.height!)}"` +
          ` x="${x(Number(attrs.x ?? 0))}" y="${y(Number(attrs.y ?? 0))}"` +
          ` fill="${color(attrs.fill!)}"${rx}/>`
        );
      }
      const d = points(attrs.d!)
        .map(([px, py], i) => `${i === 0 ? 'M' : ''}${x(px)} ${y(py)}`)
        .join(' ');
      return (
        `<path fill="none" stroke="${color(attrs.stroke!)}" stroke-linecap="round"` +
        ` stroke-linejoin="round" stroke-width="${length(attrs['stroke-width']!)}" d="${d}"/>`
      );
    })
    .join('');
}

const wrap = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>\n`;

function write(file: string, content: string) {
  const target = path.join(out, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  console.log(`icon-themes: wrote ${path.relative(root, target)}`);
}

// vscode-icons: the whole 64-unit icon into 2..30.
write(
  'vscode-icons/file_type_stackctl.svg',
  wrap(draw(elements, 28 / 64, [2, 2], 3, (hex) => hex)),
);

// Material Icon Theme: the glyph alone, centered, its longer side 27 units.
const [minX, minY, maxX, maxY] = bounds(glyph);
const scale = 27 / Math.max(maxX - minX, maxY - minY);
const offset: [number, number] = [
  16 - ((minX + maxX) / 2) * scale,
  16 - ((minY + maxY) / 2) * scale,
];
// The icon's colors and their nearest in the Material palette: for dark themes, then light.
const material: Record<string, [dark: string, light: string]> = {
  '#a8b1ff': ['#9fa8da', '#5c6bc0'], // the prompt: indigo 200, indigo 400
  '#e4e4e7': ['#e0e0e0', '#757575'], // the outer lines: grey 300, grey 600
  '#facc15': ['#ffca28', '#ffb300'], // the middle line: amber 400, amber 600
};
const shade = (theme: 0 | 1) => (hex: string) => {
  const mapped = material[hex.toLowerCase()];
  if (!mapped) {
    throw new Error(`icon-themes: no Material palette color for ${hex}; add it to the table`);
  }
  return mapped[theme];
};
write('material-icon-theme/stackctl.svg', wrap(draw(glyph, scale, offset, 2, shade(0))));
write('material-icon-theme/stackctl_light.svg', wrap(draw(glyph, scale, offset, 2, shade(1))));
