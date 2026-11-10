import { registerHooks } from 'node:module';
import { createElement as h, useState, type ReactElement } from 'react';
// Internal tool for choosing `FOCUS_COLOR` (`src/colors.ts`): the service picker and the run
// screen's commands menu, drawn by their real layouts, with the focus color swapped for one you
// tune live. `NEEDED_COLOR` follows it, derived the way `colors.ts` derives it.
//
//   ← →        hue −/+ 5°     (with shift: 1°)
//   ↑ ↓        lightness +/− 2
//   [ ]        saturation −/+ 2
//   1–8        a preset
//   tab        switch between the picker and the commands menu
//   f          open or close the picker's filter row
//   q          quit, printing the color as a paste-ready `FOCUS_COLOR`
//
// Like `palette-preview.ts`, it runs on Node's TypeScript support with no build, so the resolve
// hook below maps the `./x.js` specifiers the sources import each other by to their `.ts` files.
import chalk from 'chalk';
import { type HslColor, colord } from 'colord';
import { Box, Text, render, useApp, useInput, useWindowSize, type Key } from 'ink';
import { FOCUS_COLOR, NEEDED_COLOR, type Color } from '../src/colors.ts';
import type { SessionSnapshot } from '../src/session/session.ts';
import type { PickerEvent, PickerInput, PickerState } from '../src/tui/picker-state.ts';
import type { Segment } from '../src/tui/text-cells.ts';
import type { UiState } from '../src/tui/ui-state.ts';

const SOURCES = new URL('../src/', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(SOURCES)
      ? nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context)
      : nextResolve(specifier, context),
});
// Imported only once the hook is in place.
const { footerLayout, menuLayout } = await import('../src/tui/layout.ts');
const { pickerLayout } = await import('../src/tui/picker-layout.ts');
const { createPickerState, pickerStep } = await import('../src/tui/picker-state.ts');
const { initialUiState } = await import('../src/tui/ui-state.ts');

// ---------------------------------------------------------------------------
// The color
// ---------------------------------------------------------------------------

const PRESETS: { name: string; color: Color }[] = [
  { name: 'gold', color: '#ffbc40' },
  { name: 'coral', color: '#ff8a6b' },
  { name: 'rose', color: '#f38ba8' },
  { name: 'violet', color: '#b392f0' },
  { name: 'peach', color: '#fab387' },
  { name: 'lavender', color: '#b4befe' },
  { name: 'sky', color: '#89dceb' },
  { name: 'sand', color: '#e5c890' },
];

/** `NEEDED_COLOR` for a focus color, as `colors.ts` derives it. */
function neededFor(focus: Color): Color {
  return colord(focus).desaturate(0.54).darken(0.3).toHex();
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function hexOf(hsl: HslColor): Color {
  return colord(hsl).toHex();
}

// ---------------------------------------------------------------------------
// Sample data — neutral names only
// ---------------------------------------------------------------------------

const WORKSPACE = { name: 'example', branch: 'main' };
const LOG_PATH = 'node_modules/.stackctl/modes/development/logs/session.log';
const SCRIPTS = ['build', 'lint', 'test', 'db:migrate'];

/** `web` picked, so `api` and `auth` show as needed; the cursor on `api`. */
const PICKER_INPUT: PickerInput = {
  services: [
    { name: 'api', deps: [], dependents: ['web', 'admin'], hasRow: true },
    { name: 'auth', deps: [], dependents: ['web', 'admin'], hasRow: true },
    { name: 'admin', deps: ['api', 'auth'], dependents: [], hasRow: true },
    { name: 'web', deps: ['api', 'auth'], dependents: [], hasRow: true },
    { name: 'web-storybook', deps: [], dependents: [], hasRow: true },
    { name: 'worker', deps: [], dependents: [], hasRow: true },
  ],
  infra: ['db', 'mail'],
  saved: ['web'],
  workspace: WORKSPACE,
};

function pickerState(filtering: boolean): PickerState {
  const state = createPickerState(PICKER_INPUT);
  const keys: PickerEvent[] = filtering
    ? [
        { type: 'key', input: '/', key: {}, at: 0 },
        { type: 'key', input: 'a', key: {}, at: 0 },
      ]
    : [];
  return keys.reduce((s, e) => pickerStep(s, e).state, state);
}

const SNAPSHOT: SessionSnapshot = {
  phase: 'running',
  services: ['web', 'api', 'worker'].map((name) => ({
    name,
    state: 'running',
    ready: true,
    exitCode: null,
    waitsFor: [],
    hasHealthcheck: true,
    links: [],
  })),
  infra: [{ name: 'db', provider: 'docker-compose', state: 'running', memory: 0, links: [] }],
  workspaceLinks: [],
  logFile: LOG_PATH,
  workspace: WORKSPACE,
} as unknown as SessionSnapshot;

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** `segments` with the real focus and needed colors swapped for the candidate's. */
function recolor(segments: readonly Segment[], focus: Color, needed: Color): Segment[] {
  return segments.map((s) =>
    s.color === FOCUS_COLOR
      ? { ...s, color: focus }
      : s.color === NEEDED_COLOR
        ? { ...s, color: needed }
        : s,
  );
}

function segmentLine(segments: readonly Segment[], key: number): ReactElement {
  return h(
    Text,
    { key, wrap: 'truncate-end' },
    segments.length === 0
      ? ' '
      : segments.map((segment, i) =>
          h(
            Text,
            {
              key: i,
              color: segment.color,
              bold: segment.bold,
              dimColor: segment.dim,
              inverse: segment.inverse,
            },
            segment.text,
          ),
        ),
  );
}

function header(hsl: HslColor, focus: Color, cols: number): ReactElement[] {
  const needed = neededFor(focus);
  const presets = PRESETS.map((p, i) => `${String(i + 1)} ${chalk.hex(p.color)(p.name)}`).join(
    '  ',
  );
  const line = (text: string, key: number) =>
    h(Text, { key, wrap: 'truncate-end' }, text.length === 0 ? ' ' : text);
  return [
    line(
      `${chalk.hex(focus)('████')} ${chalk.bold(focus)}  hsl(${String(Math.round(hsl.h))}, ${String(Math.round(hsl.s))}%, ${String(Math.round(hsl.l))}%)    needed ${chalk.hex(needed)('████')} ${needed}`,
      0,
    ),
    line(chalk.dim('←→ hue  ↑↓ lightness  [ ] saturation  tab picker/menu  f filter  q quit'), 1),
    line(presets, 2),
    line(chalk.dim('─'.repeat(cols)), 3),
  ];
}

function pickerView(focus: Color, filtering: boolean, cols: number, rows: number): ReactElement {
  const layout = pickerLayout(pickerState(filtering), PICKER_INPUT, cols, rows);
  const needed = neededFor(focus);
  return h(
    Box,
    { flexDirection: 'column', height: rows },
    layout.rows.map((r, i) => segmentLine(recolor(r, focus, needed), i)),
  );
}

function menuView(focus: Color, cols: number, rows: number): ReactElement {
  const ui: UiState = { ...initialUiState, mode: 'commands', menu: { selected: 1, custom: '' } };
  const commands = Object.fromEntries(SNAPSHOT.services.map((s) => [s.name, SCRIPTS]));
  const footer = footerLayout(SNAPSHOT, ui, cols, { commands });
  const menu = menuLayout(SNAPSHOT, ui, cols, {
    commands,
    rects: footer.rects,
    maxRows: rows - footer.height,
  });
  const needed = neededFor(focus);
  return h(
    Box,
    { flexDirection: 'column', height: rows, justifyContent: 'flex-end' },
    menu &&
      h(
        Box,
        { flexDirection: 'column', marginLeft: menu.left - 1, width: menu.width },
        menu.rows.map((r, i) => segmentLine(recolor(r, focus, needed), i)),
      ),
    h(
      Box,
      { flexDirection: 'column', flexShrink: 0 },
      footer.rows.map((r, i) => segmentLine(recolor(r, focus, needed), i)),
    ),
  );
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

type View = 'picker' | 'menu';
interface State {
  hsl: HslColor;
  /** The exact hex while untouched (the real color, or a preset); HSL rounds a hex off by one. */
  exact: Color | null;
  view: View;
  filtering: boolean;
}

let lastState: State = {
  hsl: colord(FOCUS_COLOR).toHsl(),
  exact: FOCUS_COLOR,
  view: 'picker',
  filtering: false,
};

function FocusPreview(): ReactElement {
  const app = useApp();
  const { columns, rows } = useWindowSize();
  const [state, setState] = useState(lastState);
  // oxlint-disable-next-line react/globals
  lastState = state;
  const nudge = (change: Partial<Record<'h' | 's' | 'l', number>>) =>
    setState((s) => ({
      ...s,
      exact: null,
      hsl: {
        ...s.hsl,
        h: (((s.hsl.h + (change.h ?? 0)) % 360) + 360) % 360,
        s: clamp(s.hsl.s + (change.s ?? 0), 0, 100),
        l: clamp(s.hsl.l + (change.l ?? 0), 0, 100),
      },
    }));

  useInput((input: string, key: Key) => {
    const step = key.shift ? 1 : 5;
    if ((key.ctrl && input === 'c') || input === 'q') {
      app.exit();
    } else if (key.leftArrow) {
      nudge({ h: -step });
    } else if (key.rightArrow) {
      nudge({ h: step });
    } else if (key.upArrow) {
      nudge({ l: 2 });
    } else if (key.downArrow) {
      nudge({ l: -2 });
    } else if (input === '[') {
      nudge({ s: -2 });
    } else if (input === ']') {
      nudge({ s: 2 });
    } else if (key.tab) {
      setState((s) => ({ ...s, view: s.view === 'picker' ? 'menu' : 'picker' }));
    } else if (input === 'f') {
      setState((s) => ({ ...s, filtering: !s.filtering }));
    } else if (/^[1-8]$/.test(input)) {
      const preset = PRESETS[Number(input) - 1]!;
      setState((s) => ({ ...s, hsl: colord(preset.color).toHsl(), exact: preset.color }));
    }
  });

  const focus = state.exact ?? hexOf(state.hsl);
  const head = header(state.hsl, focus, columns);
  const below = Math.max(0, rows - head.length);
  return h(
    Box,
    { flexDirection: 'column', width: '100%', height: rows, overflow: 'hidden' },
    h(Box, { flexDirection: 'column', flexShrink: 0 }, head),
    state.view === 'picker'
      ? pickerView(focus, state.filtering, columns, below)
      : menuView(focus, columns, below),
  );
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('focus-preview is interactive: run it in a terminal.');
  process.exit(1);
}

const app = render(h(FocusPreview), { exitOnCtrlC: false, alternateScreen: true });
await app.waitUntilExit();

const chosen = lastState.exact ?? hexOf(lastState.hsl);
console.log(
  [
    `${chalk.hex(chosen)('████')} ${chosen}   needed ${chalk.hex(neededFor(chosen))('████')} ${neededFor(chosen)}`,
    '',
    `export const FOCUS_COLOR: Color = '${chosen}';`,
  ].join('\n'),
);
