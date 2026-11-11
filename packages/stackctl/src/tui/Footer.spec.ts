import { Writable } from 'node:stream';
import React, { useLayoutEffect, useRef } from 'react';
import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize';
import chalk from 'chalk';
import { Box, type DOMElement, Text, measureElement, render } from 'ink';
import stringWidth from 'string-width';
import { describe, expect, test } from 'vitest';
import { LINK_COLOR, SELECTED_COLOR } from '../colors.js';
import type { SessionSnapshot } from '../session/session.js';
import { CommandsMenu } from './CommandsMenu.js';
import { Footer } from './Footer.js';
import type { Target } from './hit-test.js';
import { hitTest } from './hit-test.js';
import {
  type FooterLayout,
  type Segment,
  entriesOf,
  footerLayout,
  LINK_LABEL_MAX,
  hasBlinkingDot,
  menuLayout,
} from './layout.js';
import { type UiContext, type UiState, initialUiState, step } from './ui-state.js';

const h = React.createElement;
const MB = 2 ** 20;
const LOG = 'node_modules/.stackctl/logs/development/1794083196531.log';

type Service = SessionSnapshot['services'][number];
type Infra = SessionSnapshot['infra'][number];

function service(name: string, over: Partial<Service> = {}): Service {
  return {
    name,
    state: 'running',
    exitCode: null,
    ready: true,
    hasHealthcheck: true,
    waitsFor: [],
    links: [],
    ...over,
  };
}

function infra(name: string, over: Partial<Infra> = {}): Infra {
  return { name, provider: 'docker', state: 'running', links: [], ...over };
}

/** The example of the spec's Design A mockups, everything running. */
function running(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    phase: 'running',
    services: [
      service('api', { memory: 64 * MB, links: [[{ url: 'http://api.localhost:21050/todos' }]] }),
      service('web', { memory: 219 * MB }),
    ],
    infra: [
      // At runtime `detail` is only a startup step, cleared once healthy (S2-R26). It is set on a
      // running entry here only to reproduce mockup 2's `postgres on :21052`.
      infra('db', { memory: 23 * MB, detail: 'postgres on :21052' }),
      infra('mail', { memory: 7 * MB }),
    ],
    workspaceLinks: [
      [{ label: 'public', url: 'https://us-east.example.test' }],
      [{ label: 'web', url: 'http://localhost:21050' }],
    ],
    logFile: LOG,
    workspace: { name: 'example', branch: '1.0.0' },
    ...over,
  };
}

/** Startup, infra coming up: spec mockup 3. */
function startingUp(): SessionSnapshot {
  return running({
    phase: 'starting',
    services: [
      service('api', { state: 'pending', ready: false }),
      service('web', { state: 'pending', ready: false }),
    ],
    infra: [
      infra('db', { state: 'starting', detail: 'waiting for healthy' }),
      infra('mail', { state: 'starting', detail: 'waiting for healthy' }),
    ],
  });
}

const ui = (over: Partial<UiState> = {}): UiState => ({ ...initialUiState, ...over });

/** SGR colors and OSC 8 hyperlinks (BEL- or ST-terminated) removed. */
function strip(text: string): string {
  // oxlint-disable-next-line no-control-regex -- matches SGR and OSC 8 escape sequences
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

function fakeStdout(columns: number, rows = 40) {
  const frames: string[] = [];
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        frames.push(String(chunk));
        callback();
      },
    }),
    { columns, rows },
  );
  return { stdout: stdout as unknown as NodeJS.WriteStream, frames };
}

/** Renders `element` at `columns` and returns the frame's rows, raw and stripped. */
function frameOf(element: React.ReactElement, columns: number) {
  const { stdout, frames } = fakeStdout(columns);
  const instance = render(element, { stdout, debug: true });
  const raw = (frames[frames.length - 1] ?? '').replace(/\n$/, '').split('\n');
  instance.unmount();
  return { raw, rows: raw.map((r) => strip(r).trimEnd()) };
}

/** How many rows the keys row itself draws (not its padding). */
function layoutRowsOf(snap: SessionSnapshot, state: UiState, cols: number): number {
  const layout = footerLayout(snap, state, cols);
  return layout.rows
    .slice(layout.keysRow)
    .filter((r) => r.length > 0 && !r.some((seg) => seg.link !== undefined)).length;
}

/** The index of the links row, or the row count when the footer has none. */
function linksStart(layout: FooterLayout): number {
  const at = layout.rows.findIndex((r, i) => i >= layout.keysRow && r.some((seg) => seg.link));
  return at === -1 ? layout.rows.length : at;
}

function renderFooter(layout: FooterLayout, columns: number): string[] {
  return frameOf(h(Footer, { layout }), columns).rows;
}

const segmenter = new Intl.Segmenter();
/** The second cell of a wide character. */
const WIDE_TAIL = '\u0000';

/** A line's cells: one per grapheme, and a wide one (CJK, emoji) followed by {@link WIDE_TAIL}. */
function chars(line: string): string[] {
  return Array.from(segmenter.segment(line), (s) => s.segment).flatMap((g) =>
    stringWidth(g) === 2 ? [g, WIDE_TAIL] : [g],
  );
}

/**
 * The text in the cells `rect` covers on `rows[rect.row]` (one row), blanks past the line's end
 * included. A rect that starts or ends inside a wide character reads `<split>`.
 */
function cells(rows: readonly string[], target: Target): string {
  const row = chars(rows[target.rect.row] ?? '');
  const from = target.rect.col - 1;
  const to = from + target.rect.width;
  while (row.length < to) {
    row.push(' ');
  }
  if (row[from] === WIDE_TAIL || row[to] === WIDE_TAIL) {
    return '<split>';
  }
  return row
    .slice(from, to)
    .filter((c) => c !== WIDE_TAIL)
    .join('');
}

function text(segments: readonly Segment[]): string {
  return segments.map((s) => s.text).join('');
}

function width(segments: readonly Segment[]): number {
  return chars(text(segments)).length;
}

/** The 1-based columns of the cells drawn as the focused name: white and bold. */
function focusSpan(segments: readonly Segment[]): [number, number] | null {
  let col = 1;
  let first = 0;
  let last = 0;
  for (const s of segments) {
    const w = chars(s.text).length;
    if (s.color === SELECTED_COLOR && s.bold) {
      first ||= col;
      last = col + w - 1;
    }
    col += w;
  }
  return first ? [first, last] : null;
}

// The spec's mockups, with the `[…]` focus brackets taken out: they stand for the entry's own
// padding cells and are never drawn, so focus moves no cell (S2-R14). Mockup 3's `infra` gap is
// 10, like the others.
const RULE = `── example ⎇ 1.0.0 ${'─'.repeat(85)}`;
const APPS = '● api 64M   ● web 219M';
const INFRA = 'infra: ● db 23M   ● mail 7M';

/** The links row of {@link running}: each service's links, then the workspace's. */
const LINKS = 'api ↗   public ↗   web ↗';

describe('Design A at 104 columns (S2-R14)', () => {
  test('mockup 1: running, api focused', () => {
    const layout = footerLayout(running(), ui(), 104);
    expect(renderFooter(layout, 104)).toEqual([
      RULE,
      APPS,
      INFRA,
      '←→ select   r restart   s stop   m commands  │  logs: f filter   c clear  │  ^c quit',
      LINKS,
    ]);
    // `● api 64M` from cell 1: the name, cells 3 through 5, in the focus color.
    expect(focusSpan(layout.rows[1]!)).toEqual([3, 5]);
  });

  test('mockup 2: running, db focused', () => {
    const layout = footerLayout(running(), ui({ focus: { kind: 'infra', name: 'db' } }), 104);
    expect(renderFooter(layout, 104)).toEqual([
      RULE,
      APPS,
      INFRA,
      '←→ select   r restart   s stop   R reset data  │  logs: f filter   c clear  │  ^c quit',
      LINKS,
    ]);
    // `● db 23M` from cell 8, after `infra: `: the name, cells 10 and 11.
    expect(focusSpan(layout.rows[2]!)).toEqual([10, 11]);
  });

  test('mockup 3: starting up', () => {
    // The mockup draws no links, so it has no links row.
    const layout = footerLayout({ ...startingUp(), workspaceLinks: [] }, ui(), 104);
    expect(renderFooter(layout, 104)).toEqual([
      RULE,
      '○ api   ○ web',
      'infra: ● db   ● mail',
      'logs: f filter   c clear  │  ^c quit',
    ]);
    expect(focusSpan(layout.rows[1]!)).toBeNull();
    expect(focusSpan(layout.rows[2]!)).toBeNull();
  });

  test('a service on its way has a yellow dot that blinks: dimmed while the blink is off', () => {
    const snap = { ...startingUp(), workspaceLinks: [] };
    expect(hasBlinkingDot(snap)).toBe(true);
    expect(hasBlinkingDot(running())).toBe(false);
    const dot = (blinkLit: boolean) =>
      footerLayout(snap, ui(), 104, { blinkLit }).rows[2]!.find((seg) => seg.text === '●')!;
    expect(dot(true)).toEqual({ text: '●', color: 'yellow' });
    expect(dot(false)).toEqual({ text: '●', color: 'yellow', dim: true });
    // A running, ready service never blinks.
    const ready = footerLayout(running(), ui(), 104, { blinkLit: false }).rows[1]!;
    expect(ready.find((seg) => seg.text === '●')).toEqual({ text: '●', color: 'green' });
  });

  test('focus moves no cell', () => {
    const snap = running();
    const texts = entriesOf(snap).map(({ kind, name }) =>
      footerLayout(snap, ui({ focus: { kind, name } }), 104)
        .rows.slice(1, 3)
        .map((row) => text(row).trimEnd())
        .join('\n'),
    );
    expect(new Set(texts)).toEqual(new Set([`${APPS}\n${INFRA}`]));
  });

  test('the raw frame draws the focused name white and bold, and nothing inverse', () => {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const { raw } = frameOf(h(Footer, { layout: footerLayout(running(), ui(), 104) }), 104);
      const chars = styledCharsFromTokens(tokenize(raw[1]!));
      expect(chars.some((c) => c.styles.some((st) => st.code === '\x1b[7m'))).toBe(false);
      const has = (code: string) => (c: (typeof chars)[number]) =>
        c.styles.some((st) => st.code === code);
      const focused = chars.flatMap((c, i) =>
        has('\x1b[1m')(c) && has('\x1b[37m')(c) && !has('\x1b[4m')(c) ? [i + 1] : [],
      );
      expect(focused).toEqual([3, 4, 5]);
      expect(
        chars
          .slice(2, 5)
          .map((c) => c.value)
          .join(''),
      ).toBe('api');
    } finally {
      chalk.level = level;
    }
  });

  test('styles: dots by state, the dim chrome, links in LINK_COLOR as hyperlinks', () => {
    const layout = footerLayout(running(), ui(), 104);
    const [rule, servicesRow, infraRow] = layout.rows;
    expect(rule![0]).toMatchObject({ text: '──', dim: true });
    expect(rule!.find((s) => s.text === 'example')).toMatchObject({ color: 'cyan' });
    expect(rule!.find((s) => s.text === '1.0.0')).toMatchObject({ color: 'blue' });
    expect(rule!.find((s) => s.text === '⎇')).toMatchObject({ dim: true });
    expect(infraRow!.find((s) => s.text === 'infra:')).toMatchObject({ dim: true });
    expect(servicesRow!.find((s) => s.text === '●')).toMatchObject({ color: 'green' });
    expect(servicesRow!.find((s) => s.text === '64M')).toMatchObject({ dim: true });
    const linksRow = layout.rows[layout.keysRow + 1]!;
    expect(linksRow.find((s) => s.text === 'public ↗')).toMatchObject({
      color: '#58a6ff',
      link: 'https://us-east.example.test',
    });
    const { raw } = frameOf(h(Footer, { layout }), 104);
    expect(raw[layout.keysRow + 1]).toContain('\x1b]8;;http://api.localhost:21050/todos\x07');
  });
});

describe('the footer', () => {
  test('filter mode replaces the keys row', () => {
    // At 61 columns the normal keys row takes two rows, and the filter row keeps both.
    for (const cols of [104, 61]) {
      const normal = footerLayout(running(), ui(), cols);
      const layout = footerLayout(
        running(),
        ui({ mode: 'filter', filterDraft: 'error api' }),
        cols,
      );
      // Ink's frame leaves off trailing blank rows; the footer's box still takes them.
      const rows = renderFooter(layout, cols);
      while (rows.length < layout.height) {
        rows.push('');
      }
      expect(layout.height).toBe(normal.height);
      expect(layout.keysRow).toBe(normal.keysRow);
      expect(rows.slice(0, layout.keysRow)).toEqual(
        renderFooter(normal, cols).slice(0, layout.keysRow),
      );
      // The filter row keeps the keys rows' height, and the links row stays below it.
      const keysRows = linksStart(normal) - normal.keysRow;
      expect(rows.slice(layout.keysRow)).toEqual([
        'filter › error api▏      ⏎ apply   esc clear',
        ...Array.from({ length: keysRows - 1 }, () => ''),
        ...renderFooter(normal, cols).slice(linksStart(normal)),
      ]);
      const hints = layout.targets.filter((t) => t.id.startsWith('hint:'));
      expect(hints.map((t) => t.action)).toEqual([
        { type: 'apply-filter' },
        { type: 'clear-filter' },
      ]);
      expect(hints.map((t) => cells(rows, t))).toEqual(['⏎ apply', 'esc clear']);
    }
  });

  test('an applied filter shows on the keys row', () => {
    const layout = footerLayout(running(), ui({ filter: 'error api' }), 104);
    expect(renderFooter(layout, 104).slice(layout.keysRow)).toEqual([
      '←→ select   r restart   s stop   m commands',
      'logs: f filter: error api   esc clear filter   c clear  │  ^c quit',
      LINKS,
    ]);
  });

  test("services rows wrap at 20 columns and each entry's target matches its cells", () => {
    const layout = footerLayout(running(), ui(), 20);
    const rows = renderFooter(layout, 20);
    expect(rows.slice(1, 5)).toEqual(['● api 64M', '● web 219M', 'infra: ● db 23M', '● mail 7M']);
    const entries = layout.targets.filter((t) => t.id.startsWith('entry:'));
    expect(entries.map((t) => cells(rows, t))).toEqual([
      '● api 64M',
      '● web 219M',
      '● db 23M',
      '● mail 7M',
    ]);
    expect(entries.map((t) => t.action)).toEqual(
      [0, 1, 2, 3].map((index) => ({ type: 'focus-index', index })),
    );
    // ↑/↓ reads the same cells: each entry's first cell and its row.
    expect(layout.rects).toEqual(entries.map((t) => ({ col: t.rect.col, row: t.rect.row })));
  });

  test('the infra take a row of their own under the application services', () => {
    const rows = renderFooter(footerLayout(running(), ui(), 104), 104);
    expect(rows[1]).toBe(APPS);
    expect(rows[2]).toBe(INFRA);
    // With no application service, infra is the first services row.
    const infraOnly = footerLayout(running({ services: [] }), ui(), 104);
    expect(renderFooter(infraOnly, 104)[1]).toBe(INFRA);
  });

  test('every hint has a target covering key plus label', () => {
    const contexts: [string, SessionSnapshot, UiState][] = [
      ['app', running(), ui()],
      ['infra', running(), ui({ focus: { kind: 'infra', name: 'mail' } })],
      ['filtered', running(), ui({ filter: 'error' })],
      ['starting', startingUp(), ui()],
      ['menu open', running(), ui({ mode: 'commands', menu: { selected: 0, custom: '' } })],
    ];
    for (const [, snap, state] of contexts) {
      for (const cols of [104, 61, 40]) {
        const layout = footerLayout(snap, state, cols);
        const rows = renderFooter(layout, cols);
        const hints = layout.targets.filter((t) => t.id.startsWith('hint:keys:'));
        const keysText = rows.slice(layout.keysRow, linksStart(layout)).join(' ');
        expect(hints.length).toBeGreaterThan(0);
        for (const t of hints) {
          const label = t.id.slice('hint:keys:'.length);
          const drawn = cells(rows, t);
          // `f filter:` carries the applied terms as its detail.
          expect(drawn.startsWith(label)).toBe(true);
          expect(drawn).toBe(label === 'f filter:' ? 'f filter: error' : label);
          expect(t.rect.row).toBeGreaterThanOrEqual(layout.keysRow);
        }
        // Every hint drawn on the keys row is a target: nothing between them but gaps and │.
        const covered = hints.map((t) => cells(rows, t)).join(' ');
        expect(
          keysText
            .replace(/logs:|[│\s]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
        ).toBe(covered.replace(/\s+/g, ' ').trim());
      }
    }
  });

  test('the keys row wraps between groups, and a │ never begins or ends a row', () => {
    const layout = footerLayout(running(), ui(), 61);
    const rows = renderFooter(layout, 61).slice(layout.keysRow, linksStart(layout));
    expect(rows).toEqual([
      '←→ select   r restart   s stop   m commands',
      'logs: f filter   c clear  │  ^c quit',
    ]);
  });

  test("the session's keys never wrap onto a row of their own: the log's keys go with them", () => {
    // 80 columns fit the select keys and the log's keys, but not `^c quit` after them.
    const layout = footerLayout(running(), ui(), 80);
    const rows = renderFooter(layout, 80).slice(layout.keysRow, linksStart(layout));
    expect(rows).toEqual([
      '←→ select   r restart   s stop   m commands',
      'logs: f filter   c clear  │  ^c quit',
    ]);
  });

  test('a failed startup shows the startup keys', () => {
    const snap = startingUp();
    snap.phase = 'failed';
    snap.failure = { message: 'infra service db never became healthy\nlast output: …' };
    snap.infra = [infra('db', { state: 'failed' }), infra('mail', { state: 'running' })];
    const layout = footerLayout(snap, ui(), 104);
    expect(renderFooter(layout, 104).slice(1)).toEqual([
      '○ api   ○ web',
      'infra: ○ db   ● mail',
      'logs: f filter   c clear  │  ^c quit',
      'public ↗   web ↗',
    ]);
    expect(layout.rows[1]!.find((s) => s.text === '○')).toMatchObject({ color: 'gray' });
  });

  test('the rule line has no target', () => {
    const layout = footerLayout(running(), ui(), 104);
    expect(layout.targets.some((t) => t.rect.row === 0)).toBe(false);
  });
});

describe('the links row', () => {
  const linksOf = (snap: SessionSnapshot, cols: number) => {
    const layout = footerLayout(snap, ui(), cols);
    return layout.rows.slice(linksStart(layout)).map(text);
  };

  test('it is the last row: services, then infra, then the workspace links', () => {
    const snap = running({
      infra: [infra('db', { links: [[{ label: 'console', url: 'http://localhost:21052' }]] })],
    });
    expect(linksOf(snap, 104)).toEqual(['api ↗   console ↗   public ↗   web ↗']);
    const layout = footerLayout(running(), ui(), 104);
    expect(renderFooter(layout, 104).at(-1)).toBe(LINKS);
  });

  test('a link with no label is named for its service, or its host; labels are cut to 20 cells', () => {
    const snap = running({
      services: [
        service('console-desktop-storybook', {
          links: [
            [
              { url: 'http://localhost:21050' },
              { label: 'a-label-that-is-much-longer', url: 'http://localhost:21051' },
            ],
          ],
        }),
      ],
      infra: [],
      workspaceLinks: [[{ url: 'https://docs.example.test/guide' }]],
    });
    const [row] = linksOf(snap, 104);
    expect(row).toBe('console-desktop-sto… ↗   a-label-that-is-muc… ↗   docs.example.test ↗');
    expect(LINK_LABEL_MAX).toBe(20);
    // Each label is at most 20 cells, plus ` ↗`.
    for (const piece of row!.split('   ')) {
      expect(stringWidth(piece)).toBeLessThanOrEqual(LINK_LABEL_MAX + 2);
    }
  });

  test('each link is LINK_COLOR with its url as an OSC 8 hyperlink', () => {
    const layout = footerLayout(running(), ui(), 104);
    const links = layout.rows[linksStart(layout)]!.filter((s) => s.link);
    expect(links).toEqual([
      { text: 'api ↗', color: LINK_COLOR, link: 'http://api.localhost:21050/todos' },
      { text: 'public ↗', color: LINK_COLOR, link: 'https://us-east.example.test' },
      { text: 'web ↗', color: LINK_COLOR, link: 'http://localhost:21050' },
    ]);
    const { raw } = frameOf(h(Footer, { layout }), 104);
    expect(raw.at(-1)).toContain('\x1b]8;;https://us-east.example.test\x07');
  });

  test('links wrap onto another row at a narrow width, and no row is wider than the screen', () => {
    // `api ↗   public ↗   web ↗` is 24 cells; `web ↗` does not fit after `public ↗` at 20.
    expect(linksOf(running(), 20)).toEqual(['api ↗   public ↗', 'web ↗']);
    for (const cols of [104, 40, 24, 20, 12, 8]) {
      const layout = footerLayout(running(), ui(), cols);
      for (const row of layout.rows) {
        expect(width(row)).toBeLessThanOrEqual(cols);
      }
    }
  });

  test('they are not clickable: no target lies on the links rows', () => {
    for (const cols of [104, 20]) {
      const layout = footerLayout(running(), ui(), cols);
      expect(layout.targets.some((t) => t.id.startsWith('link:'))).toBe(false);
      expect(layout.targets.some((t) => t.rect.row >= linksStart(layout))).toBe(false);
    }
  });

  test('with no links there is no links row', () => {
    const snap = running({
      services: [service('api'), service('web')],
      infra: [infra('db')],
      workspaceLinks: [],
    });
    const layout = footerLayout(snap, ui(), 104);
    expect(linksStart(layout)).toBe(layout.rows.length);
    expect(layout.height).toBe(layout.keysRow + 1);
    expect(renderFooter(layout, 104).at(-1)).toContain('^c quit');
  });
});

describe('wide characters', () => {
  /** CJK and emoji names and links, which take two cells a character. */
  function wide(): SessionSnapshot {
    return running({
      services: [
        service('日本', {
          memory: 64 * MB,
          links: [[{ label: 'ドキュ', url: 'http://localhost:21050/docs' }]],
        }),
        service('🚀web', { memory: 7 * MB, links: [[{ url: 'http://localhost:21050/🚀' }]] }),
      ],
      infra: [infra('メール', { memory: 23 * MB })],
      workspaceLinks: [[{ label: '👩‍💻dev', url: 'https://dev.example.test' }]],
      logFile: 'node_modules/.stackctl/logs/ログ.log',
      workspace: { name: '例', branch: 'ブランチ' },
    });
  }

  test('every target covers exactly its cells', () => {
    for (const cols of [104, 61, 40]) {
      for (const focus of [
        { kind: 'app' as const, name: '日本' },
        { kind: 'app' as const, name: '🚀web' },
        { kind: 'infra' as const, name: 'メール' },
      ]) {
        const layout = footerLayout(wide(), ui({ focus }), cols);
        const rows = renderFooter(layout, cols);
        const drawn = (id: string) => {
          const t = layout.targets.find((x) => x.id === id);
          return t ? cells(rows, t) : undefined;
        };
        expect(drawn('entry:app:日本')).toBe('● 日本 64M');
        expect(drawn('entry:app:🚀web')).toBe('● 🚀web 7M');
        expect(drawn('entry:infra:メール')).toBe('● メール 23M');
        for (const t of layout.targets.filter((x) => x.id.startsWith('hint:keys:'))) {
          expect(cells(rows, t)).toBe(t.id.slice('hint:keys:'.length));
        }
        for (const row of rows) {
          expect(stringWidth(row)).toBeLessThanOrEqual(cols);
        }
      }
    }
    const layout = footerLayout(wide(), ui(), 104);
    expect(layout.rows.slice(linksStart(layout)).map(text)).toEqual([
      'ドキュ ↗   🚀web ↗   👩‍💻dev ↗',
    ]);
  });

  test('the focused wide entry has its name in the focus color, on whole cells', () => {
    const layout = footerLayout(wide(), ui({ focus: { kind: 'infra', name: 'メール' } }), 104);
    const entry = layout.targets.find((t) => t.id === 'entry:infra:メール')!;
    // The dot and a space, then the three wide characters: six cells.
    expect(focusSpan(layout.rows[entry.rect.row]!)).toEqual([
      entry.rect.col + 2,
      entry.rect.col + 7,
    ]);
  });

  test('the rule line cuts a wide branch and name on whole characters', () => {
    const snap = { ...wide(), workspace: { name: '例', branch: 'ブランチ名前長い' } };
    const at = (cols: number) => renderFooter(footerLayout(snap, ui(), cols), cols)[0]!;
    expect(at(26)).toBe('── 例 ⎇ ブランチ名前長… ──');
    expect(at(20)).toBe('── 例 ⎇ ブランチ… ──');
    for (const cols of [26, 20]) {
      expect(stringWidth(at(cols))).toBe(cols);
    }
  });
});

describe('truncation at 61 columns', () => {
  test('the rule line is the fill and the workspace, with no target', () => {
    const layout = footerLayout(running(), ui(), 61);
    expect(renderFooter(layout, 61)[0]).toBe(`── example ⎇ 1.0.0 ${'─'.repeat(42)}`);
  });

  test('the branch is cut, then dropped, then the name is cut', () => {
    const branch = 'feature/long-branch-name';
    const at = (cols: number) =>
      renderFooter(
        footerLayout(running({ workspace: { name: 'example', branch } }), ui(), cols),
        cols,
      )[0]!;
    expect(at(64)).toBe(`── example ⎇ feature/long-branch-name ${'─'.repeat(26)}`);
    expect(at(45)).toBe('── example ⎇ feature/long-branch-name ───────');
    expect(at(36)).toBe('── example ⎇ feature/long-branch… ──');
    expect(at(26)).toBe('── example ⎇ feature/l… ──');
    expect(at(23)).toBe(`── example ${'─'.repeat(12)}`);
    expect(at(20)).toBe('── example ─────────');
    expect(at(12)).toBe('── examp… ──');
    for (const cols of [64, 45, 36, 26, 23, 20, 12]) {
      expect(stringWidth(at(cols))).toBe(cols);
    }
    expect(
      renderFooter(
        footerLayout(running({ workspace: { name: 'example', branch: null } }), ui(), 40),
        40,
      )[0],
    ).toBe(`── example ${'─'.repeat(29)}`);
  });

  test('a narrower screen never gives the branch more room', () => {
    const branch = 'feature/long-branch';
    const shown = (cols: number) => {
      const row = renderFooter(
        footerLayout(running({ workspace: { name: 'example', branch } }), ui(), cols),
        cols,
      )[0]!;
      return stringWidth(/ ⎇ (\S+) /.exec(row)?.[1] ?? '');
    };
    let last = shown(120);
    for (let cols = 119; cols >= 17; cols--) {
      const now = shown(cols);
      expect(now, `branch at ${String(cols)}`).toBeLessThanOrEqual(last);
      last = now;
    }
  });

  test('no row and no target is wider than the screen', () => {
    for (const cols of [104, 61, 40, 24, 20]) {
      for (const state of [
        ui(),
        ui({ focus: { kind: 'infra', name: 'db' } }),
        ui({ mode: 'filter' }),
      ]) {
        const layout = footerLayout(running(), state, cols);
        for (const row of layout.rows) {
          expect(width(row)).toBeLessThanOrEqual(cols);
        }
        for (const t of layout.targets) {
          expect(t.rect.col + t.rect.width - 1, t.id).toBeLessThanOrEqual(cols);
        }
      }
    }
  });
});

describe('the commands menu', () => {
  const commands = { api: ['add-random-todo'], web: ['build', 'preview'] };
  const open = (over: Partial<NonNullable<UiState['menu']>> = {}) =>
    ui({ mode: 'commands', menu: { selected: 0, custom: '', ...over } });

  /** The screen: a log pane that fills what the footer leaves, then the footer and the menu. */
  function screen(state: UiState, cols: number, height: number) {
    const snap = running();
    const layout = footerLayout(snap, state, cols);
    const menu = menuLayout(snap, state, cols, {
      commands,
      rects: layout.rects,
      maxRows: height - layout.height,
    });
    const measured: { pane?: number } = {};
    function Screen() {
      const pane = useRef<DOMElement>(null);
      useLayoutEffect(() => {
        measured.pane = measureElement(pane.current!).height;
      });
      return h(
        Box,
        { flexDirection: 'column', width: '100%', height },
        h(
          Box,
          { ref: pane, flexGrow: 1, flexDirection: 'column', overflow: 'hidden' },
          ...Array.from({ length: height - layout.height }, (_, i) =>
            h(Text, { key: i }, `log line ${String(i)}`),
          ),
        ),
        h(Footer, { layout }, h(CommandsMenu, { menu })),
      );
    }
    const { rows } = frameOf(h(Screen), cols);
    return { rows, layout, menu, pane: measured.pane };
  }

  test("the menu does not change the log pane's height", () => {
    // At 61 columns the normal keys row wraps to two rows; the menu's `^c quit` keeps both.
    for (const cols of [104, 61]) {
      const closed = screen(ui(), cols, 16);
      const opened = screen(open(), cols, 16);
      expect(opened.menu).not.toBeNull();
      expect(opened.pane).toBe(closed.pane);
      expect(opened.layout.height).toBe(closed.layout.height);
      const footerTop = 16 - closed.layout.height;
      expect(opened.rows.slice(footerTop, footerTop + closed.layout.keysRow)).toEqual(
        closed.rows.slice(footerTop, footerTop + closed.layout.keysRow),
      );
    }
  });

  test("it floats on the footer's top edge under the focused entry, opaque", () => {
    const { rows, menu } = screen(open(), 104, 16);
    const top = rows.length - 5 - menu!.rows.length;
    expect(rows.slice(top, top + menu!.rows.length)).toEqual([
      '╭ api · run ──────────────────────────────╮',
      '│ ❯ add-random-todo                       │',
      '│   custom command…                       │',
      '│ ↑↓ choose  ←→ service  ⏎ run  esc close │',
      '╰─────────────────────────────────────────╯',
    ]);
    expect(rows[top - 1]).toBe(`log line ${String(top - 1)}`);
    expect(menu).toMatchObject({ left: 1, width: 43 });
    // The keys row offers only quit while the menu is open.
    expect(rows[rows.length - 2]).toBe('^c quit');
  });

  test('its targets cover their cells: rows inside the walls, and each hint', () => {
    const { rows, menu } = screen(open({ selected: 1 }), 104, 16);
    // Footer row 0 (the rule line) is the frame's fifth row from the bottom.
    const base = rows.length - 5;
    const at = (t: Target) => cells(rows, { ...t, rect: { ...t.rect, row: base + t.rect.row } });
    expect(
      menu!.targets.map((t) => [t.id, t.rect.height === 1 ? at(t) : t.rect, t.action]),
    ).toEqual([
      ['menu:box', { col: 1, row: -5, width: 43, height: 5 }, { type: 'custom-input', text: '' }],
      ['menu:row:0', '   add-random-todo'.padEnd(41), { type: 'run-command', row: 0 }],
      ['menu:custom', ' ❯ $ ▏custom command…'.padEnd(41), { type: 'custom-command' }],
      ['hint:menu:↑↓ choose', '↑↓ choose', { type: 'menu-move', delta: 1 }],
      ['hint:menu:←→ service', '←→ service', { type: 'menu-service', delta: 1 }],
      ['hint:menu:⏎ run', '⏎ run', { type: 'run-command' }],
      ['hint:menu:esc close', 'esc close', { type: 'close-menu' }],
    ]);
  });

  test('it moves with the focus, clamped on screen, and drops ←→ with one app service', () => {
    const state = ui({
      mode: 'commands',
      menu: { selected: 0, custom: 'echo hi' },
      focus: { kind: 'app', name: 'web' },
    });
    const snap = running();
    const layout = footerLayout(snap, state, 50);
    const menu = menuLayout(snap, state, 50, { commands, rects: layout.rects })!;
    expect(menu.left + menu.width - 1).toBe(50);
    const one = running({ services: [service('api')] });
    const single = menuLayout(one, open(), 104, {
      commands,
      rects: footerLayout(one, open(), 104).rects,
    })!;
    expect(single.rows.map(text)).toContain('│ ↑↓ choose  ⏎ run  esc close │');
  });

  test('a long list scrolls inside the box and keeps the highlight in view', () => {
    const many = { api: Array.from({ length: 8 }, (_, i) => `script-${String(i)}`) };
    const snap = running();
    const state = open({ selected: 6 });
    const menu = menuLayout(snap, state, 104, {
      commands: many,
      rects: footerLayout(snap, state, 104).rects,
      maxRows: 7,
    })!;
    expect(menu.rows.map(text)).toEqual([
      '╭ api · run ──────────────────────────────╮',
      '│   script-3                              │',
      '│   script-4                              │',
      '│   script-5                              │',
      '│ ❯ script-6                              │',
      '│ ↑↓ choose  ←→ service  ⏎ run  esc close │',
      '╰─────────────────────────────────────────╯',
    ]);
  });

  test('the custom row shows its typing behind $ and the cursor', () => {
    const snap = running();
    const state = open({ selected: 1, custom: 'echo hi' });
    const menu = menuLayout(snap, state, 104, {
      commands,
      rects: footerLayout(snap, state, 104).rects,
    })!;
    expect(text(menu.rows[2]!)).toBe('│ ❯ $ echo hi▏                            │');
  });

  test("a click inside the box that misses a row or a hint is the menu's own", () => {
    const snap = running();
    const state = open({ selected: 1, custom: 'echo hi' });
    const layout = footerLayout(snap, state, 104, { commands });
    const menu = menuLayout(snap, state, 104, { commands, rects: layout.rects })!;
    expect(menu.rect).toEqual({ col: 1, row: -5, width: 43, height: 5 });
    // The jump row's `Click here`, right above the footer, under the menu's bottom border.
    const jump: Target = {
      id: 'jump',
      rect: { col: 1, row: -1, width: 104, height: 1 },
      action: { type: 'scroll-newest' },
    };
    const targets = [...layout.targets, jump, ...menu.targets];
    // The bottom border, the title row, a wall, and the gap between `↑↓ choose` and `←→ service`.
    for (const [col, row] of [
      [10, -1],
      [10, -5],
      [1, -3],
      [43, -3],
      [12, -2],
    ] as const) {
      expect(hitTest(targets, col, row)?.id, `${String(col)},${String(row)}`).toBe('menu:box');
    }
    expect(hitTest(targets, 44, -1)?.id).toBe('jump');
    expect(hitTest(targets, 3, -2)?.id).toBe('hint:menu:↑↓ choose');
    // Clicked, it changes nothing: the menu stays open with its typing, and nothing runs.
    const ctx: UiContext = {
      phase: snap.phase,
      entries: layout.entries,
      rects: layout.rects,
      commands,
      hasSelection: false,
      hasStickyToast: false,
    };
    const box = hitTest(targets, 10, -1)!;
    for (const s of [state, open({ selected: 0 })]) {
      const next = step(s, { type: 'click', action: box.action, at: 0, ctx });
      expect(next.state).toEqual(s);
      expect(next.effects).toEqual([]);
    }
    // A click outside the box still closes it.
    expect(step(state, { type: 'click', action: null, at: 0, ctx }).state.menu).toBeNull();
  });

  test('on a screen too short for it, the box keeps its borders and a row, and drops its hints', () => {
    const snap = running();
    const state = open();
    const rects = footerLayout(snap, state, 104).rects;
    const at = (maxRows: number) => menuLayout(snap, state, 104, { commands, rects, maxRows })!;
    expect(at(4).rows.map(text)).toEqual([
      '╭ api · run ──────────────────────────────╮',
      '│ ❯ add-random-todo                       │',
      '│ ↑↓ choose  ←→ service  ⏎ run  esc close │',
      '╰─────────────────────────────────────────╯',
    ]);
    expect(at(3).rows.map(text)).toEqual([
      '╭ api · run ──────────────────────────────╮',
      '│ ❯ add-random-todo                       │',
      '╰─────────────────────────────────────────╯',
    ]);
    expect(at(3).targets.map((t) => t.id)).toEqual(['menu:box', 'menu:row:0']);
  });

  test("←/→ in the menu never changes the footer's height", () => {
    // At 90 columns `s stop`'s keys row fits on one row and `s start`'s, one cell wider, wraps.
    const snap = running({
      services: [service('api'), service('web', { state: 'stopped' })],
    });
    const at = (state: UiState) => footerLayout(snap, state, 90, { commands }).height;
    const onApi = { kind: 'app' as const, name: 'api' };
    const onWeb = { kind: 'app' as const, name: 'web' };
    expect(
      layoutRowsOf(snap, ui({ focus: onApi }), 90),
      'the running service alone fits one keys row',
    ).toBe(1);
    const heights = [
      at(ui({ focus: onApi })),
      at(ui({ focus: onWeb })),
      at({ ...open(), focus: onApi }),
      at({ ...open(), focus: onWeb }),
    ];
    expect(new Set(heights).size).toBe(1);
  });

  test('it is not laid out unless the menu is open on an app service', () => {
    const snap = running();
    expect(menuLayout(snap, ui(), 104, { commands, rects: [] })).toBeNull();
  });
});
