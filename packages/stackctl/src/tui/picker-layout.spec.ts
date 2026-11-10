import stringWidth from 'string-width';
import { describe, expect, test } from 'vitest';
import { BRANCH_COLOR, FOCUS_COLOR, NEEDED_COLOR, WARN_COLOR, WORKSPACE_COLOR } from '../colors.js';
import type { FooterRow } from './layout.js';
import { type PickerLayout, pickerLayout } from './picker-layout.js';
import {
  type PickerEvent,
  type PickerInput,
  type PickerService,
  type PickerState,
  createPickerState,
  pickerStep,
} from './picker-state.js';

const EXAMPLE: PickerService[] = [
  { name: 'backend', deps: [], dependents: ['frontend'], hasRow: true },
  { name: 'frontend', deps: ['backend'], dependents: [], hasRow: true },
  { name: 'worker', deps: [], dependents: [], hasRow: true },
];

function pickerInput(over: Partial<PickerInput> = {}): PickerInput {
  return {
    services: EXAMPLE,
    infra: ['db', 'mail'],
    saved: [],
    workspace: { name: 'example', branch: '1.0.0' },
    ...over,
  };
}

function key(input: string, flags: Record<string, boolean> = {}): PickerEvent {
  return { type: 'key', input, key: flags, at: 0 };
}

function after(state: PickerState, events: PickerEvent[]): PickerState {
  return events.reduce((s, e) => pickerStep(s, e).state, state);
}

function text(row: FooterRow): string {
  return row.map((s) => s.text).join('');
}

function frame(layout: PickerLayout): string {
  return layout.rows.map((r) => text(r).trimEnd()).join('\n');
}

const segmenter = new Intl.Segmenter();

/** What is drawn in the `w` cells from 1-based column `col` of `row`, by terminal cell width. */
function cellsAt(row: FooterRow, col: number, w: number): string {
  let out = '';
  let at = 1;
  for (const { segment } of segmenter.segment(text(row))) {
    if (at >= col && at < col + w) {
      out += segment;
    }
    at += stringWidth(segment);
  }
  return out;
}

/** The 1-based column `needle` starts at in `row`, in cells. */
function cellOf(row: FooterRow, needle: string): number {
  const t = text(row);
  return stringWidth(t.slice(0, t.indexOf(needle))) + 1;
}

/** Lays out, then feeds the list height back as the component does, and lays out again. */
function settled(state: PickerState, input: PickerInput, cols: number, rows: number) {
  const first = pickerLayout(state, input, cols, rows);
  const next = pickerStep(state, { type: 'resize', listRows: first.listRows }).state;
  return { state: next, layout: pickerLayout(next, input, cols, rows) };
}

describe('frames', () => {
  // The spec's mockup: `frontend` picked, `backend` pulled in and locked, the cursor on `backend`.
  const mockup = createPickerState(pickerInput({ saved: ['frontend'] }));

  test('the mockup at 104 columns', () => {
    const layout = pickerLayout(mockup, pickerInput(), 104, 12);
    expect(frame(layout)).toBe(
      [
        '── example ⎇ 1.0.0 ────────────────────────────────────────────────────────────────── choose services ──',
        '  space select   ↑↓ move   / filter   n none   ⏎ start   ^c quit',
        '',
        '  ❯ ◉ backend     needed by frontend',
        '    ◉ frontend',
        '    ○ worker',
        '',
        '',
        '',
        '',
        '────────────────────────────────────────────────────────────────────────────────────────────────────────',
        '  will start  frontend · backend   │   infra: db · mail',
      ].join('\n'),
    );
    expect(layout.rows).toHaveLength(12);
    expect(layout.rows.every((r) => stringWidth(text(r)) <= 104)).toBe(true);
    expect(stringWidth(text(layout.rows[0]!))).toBe(104);
  });

  test('the mockup at 61 columns', () => {
    const layout = pickerLayout(mockup, pickerInput(), 61, 12);
    expect(frame(layout)).toBe(
      [
        '── example ⎇ 1.0.0 ─────────────────────── choose services ──',
        '  space select   ↑↓ move   / filter   n none   ⏎ start',
        '  ^c quit',
        '',
        '  ❯ ◉ backend     needed by frontend',
        '    ◉ frontend',
        '    ○ worker',
        '',
        '',
        '',
        '─────────────────────────────────────────────────────────────',
        '  will start  frontend · backend   │   infra: db · mail',
      ].join('\n'),
    );
  });

  test('styles: markers, cursor, notes, rules', () => {
    const rows = pickerLayout(mockup, pickerInput(), 104, 12).rows;
    const seg = (row: FooterRow, t: string) => row.find((s) => s.text === t)!;
    expect(seg(rows[3]!, '❯').color).toBe(FOCUS_COLOR);
    expect(seg(rows[3]!, 'backend').color).toBe(FOCUS_COLOR);
    expect(seg(rows[3]!, '◉')).toEqual({ text: '◉', color: NEEDED_COLOR });
    expect(seg(rows[4]!, '◉')).toEqual({ text: '◉', color: FOCUS_COLOR });
    expect(seg(rows[4]!, 'frontend')).toEqual({ text: 'frontend' });
    expect(seg(rows[5]!, '○')).toEqual({ text: '○' });
    expect(seg(rows[3]!, 'needed by frontend').dim).toBe(true);
    expect(seg(rows[0]!, 'example').color).toBe(WORKSPACE_COLOR);
    expect(seg(rows[0]!, '1.0.0').color).toBe(BRANCH_COLOR);
    expect(seg(rows[0]!, '⎇').dim).toBe(true);
    expect(seg(rows[0]!, 'choose services').bold).toBe(true);
    expect(rows[10]![0]!.dim).toBe(true);
    expect(seg(rows[11]!, 'will start').dim).toBe(true);
    expect(seg(rows[11]!, 'infra:').dim).toBe(true);
    expect(seg(rows[11]!, ' · ').dim).toBe(true);
    expect(seg(rows[11]!, 'frontend')).toEqual({ text: 'frontend' });
  });

  test('the picker fills the viewport, the keys under the rule line, the bottom block pinned to the bottom', () => {
    const layout = pickerLayout(mockup, pickerInput(), 80, 30);
    expect(layout.rows).toHaveLength(30);
    expect(text(layout.rows[1]!)).toContain('^c quit');
    expect(text(layout.rows[29]!)).toContain('will start');
    expect(layout.listRows).toBe(30 - 3 - 3);
  });

  test('bottomRule is the row of the bottom rule, where the bottom block starts', () => {
    for (const [cols, rows] of [
      [104, 12],
      [61, 12],
      [38, 20],
    ] as const) {
      const layout = pickerLayout(mockup, pickerInput(), cols, rows);
      expect(text(layout.rows[layout.bottomRule]!)).toBe('─'.repeat(cols));
      expect(text(layout.rows[layout.bottomRule + 1]!)).toContain('will start');
      // Only the "will start" line follows the bottom rule.
      const after = layout.rows.slice(layout.bottomRule + 1).map(text);
      expect(after.every((r) => !r.includes('space select'))).toBe(true);
      expect(text(layout.rows[1]!)).toContain('space select');
    }
  });
});

describe('notes', () => {
  // `web` → `api` → `db`: deps are one level, so picking `web` runs `api` only.
  const CHAIN: PickerService[] = [
    { name: 'db', deps: [], dependents: ['api'], hasRow: true },
    { name: 'api', deps: ['db'], dependents: ['web'], hasRow: true },
    { name: 'web', deps: ['api'], dependents: [], hasRow: true },
  ];

  function rowOf(layout: PickerLayout, name: string): string {
    return text(layout.rows.find((r) => new RegExp(`[◉○] ${name}( |$)`).test(text(r)))!).trimEnd();
  }

  test('no row has a note while nothing is picked', () => {
    const layout = pickerLayout(
      createPickerState(pickerInput({ services: CHAIN })),
      pickerInput(),
      80,
      12,
    );
    expect(rowOf(layout, 'db')).toBe('  ❯ ○ db');
    expect(rowOf(layout, 'api')).toBe('    ○ api');
    expect(rowOf(layout, 'web')).toBe('    ○ web');
  });

  test('a locked row says which picks need it, picked or not', () => {
    const webOnly = createPickerState(pickerInput({ services: CHAIN, saved: ['web'] }));
    let layout = pickerLayout(webOnly, pickerInput(), 80, 12);
    expect(rowOf(layout, 'api')).toBe('    ◉ api    needed by web');
    // `db` is not pulled in: deps are one level.
    expect(rowOf(layout, 'db')).toBe('  ❯ ○ db');
    expect(text(layout.rows[11]!).trimEnd()).toBe('  will start  web · api   │   infra: db · mail');

    const both = createPickerState(pickerInput({ services: CHAIN, saved: ['web', 'api'] }));
    layout = pickerLayout(both, pickerInput(), 80, 12);
    expect(rowOf(layout, 'api')).toBe('    ◉ api    needed by web');
    expect(rowOf(layout, 'db')).toBe('  ❯ ◉ db     needed by api');
  });

  test('a note that does not fit is cut at the edge; the name is not', () => {
    const state = createPickerState(pickerInput({ saved: ['frontend'] }));
    const rows = pickerLayout(state, pickerInput(), 26, 14).rows;
    const at = rows.findIndex((r) => text(r).includes('❯'));
    expect(text(rows[at]!)).toBe('  ❯ ◉ backend     needed…');
    expect(text(rows[at + 1]!).trimEnd()).toBe('    ◉ frontend');
    expect(rows.every((r) => stringWidth(text(r)) <= 26)).toBe(true);
  });

  test('the notes column stays put while filtering', () => {
    const state = createPickerState(pickerInput({ saved: ['frontend'] }));
    const filtered = after(state, [key('/'), key('b')]);
    const row = pickerLayout(filtered, pickerInput(), 80, 12).rows[3]!;
    expect(text(row).trimEnd()).toBe('  ❯ ◉ backend     needed by frontend');
  });
});

describe('the "will start" line', () => {
  test('nothing picked', () => {
    const rows = pickerLayout(createPickerState(pickerInput()), pickerInput(), 80, 12).rows;
    expect(text(rows[11]!)).toBe('  will start  nothing selected');
  });

  test('no infra group when the config declares none', () => {
    const input = pickerInput({ infra: [], saved: ['worker'] });
    const rows = pickerLayout(createPickerState(input), input, 80, 12).rows;
    expect(text(rows[11]!)).toBe('  will start  worker');
  });

  test('a pulled-in service with no row is listed; a pick that does not launch is stopped', () => {
    const services: PickerService[] = [
      { name: 'proxy', deps: [], dependents: ['web'], hasRow: false },
      { name: 'docs', deps: [], dependents: ['web'], hasRow: true, launches: false },
      { name: 'web', deps: ['proxy', 'docs'], dependents: [], hasRow: true },
      { name: 'cron', deps: [], dependents: [], hasRow: true, launches: false },
    ];
    const input = pickerInput({ services, saved: ['web', 'cron'] });
    const layout = pickerLayout(createPickerState(input), input, 80, 12);
    // `cron` is picked but won't launch; `docs` is pulled in and won't launch, so it is left out.
    expect(text(layout.rows[11]!)).toBe(
      '  will start  web · cron (stopped) · proxy   │   infra: db · mail',
    );
    expect(layout.rows[11]!.find((s) => s.text === ' (stopped)')!.dim).toBe(true);
    // `proxy` has no row and no marker.
    expect(layout.rows.some((r) => text(r).includes('◉ proxy'))).toBe(false);
  });

  test('a pick that does not launch still counts as selected, and infra still shows', () => {
    const services = EXAMPLE.map((s) => (s.name === 'worker' ? { ...s, launches: false } : s));
    const input = pickerInput({ services, saved: ['worker'] });
    const rows = pickerLayout(createPickerState(input), input, 80, 12).rows;
    expect(text(rows[11]!)).toBe('  will start  worker (stopped)   │   infra: db · mail');
  });

  test('continuation rows start at cell 15, under the first name', () => {
    const input = pickerInput({ saved: ['frontend', 'worker'] });
    const rows = pickerLayout(createPickerState(input), input, 34, 16).rows;
    const at = rows.findIndex((r) => text(r).startsWith('  will start'));
    expect(cellOf(rows[at]!, 'frontend')).toBe(15);
    expect(cellOf(rows[at + 1]!, 'backend')).toBe(15);
    expect(cellOf(rows[at + 2]!, 'infra')).toBe(15);
  });

  test('wraps between names, with `infra` on the row of the first infra name', () => {
    const input = pickerInput({ saved: ['frontend', 'worker'] });
    const rows = pickerLayout(createPickerState(input), input, 34, 16).rows.map((r) =>
      text(r).trimEnd(),
    );
    const at = rows.findIndex((r) => r.startsWith('  will start'));
    expect(rows.slice(at, at + 3)).toEqual([
      '  will start  frontend · worker',
      '              backend',
      '              infra: db · mail',
    ]);
  });
});

describe('scrolling', () => {
  const MANY: PickerService[] = Array.from({ length: 10 }, (_, i) => ({
    name: `svc-${i}`,
    deps: [],
    dependents: [],
    hasRow: true,
  }));
  const input = pickerInput({ services: MANY });

  test('the list scrolls to keep the cursor visible', () => {
    // 10 rows: the rule, keys, the ↑ row, 4 list rows, the ↓ row, the bottom rule, "will start".
    let { state, layout } = settled(createPickerState(input), input, 80, 10);
    expect(layout.listRows).toBe(4);
    expect(text(layout.rows[2]!)).toBe('');
    expect(text(layout.rows[7]!)).toBe('  ↓ 6 more');
    for (let i = 0; i < 6; i++) {
      state = pickerStep(state, key('', { downArrow: true })).state;
    }
    layout = pickerLayout(state, input, 80, 10);
    expect(layout.rows.slice(2, 8).map((r) => text(r).trimEnd())).toEqual([
      '  ↑ 3 more',
      '    ○ svc-3',
      '    ○ svc-4',
      '    ○ svc-5',
      '  ❯ ○ svc-6',
      '  ↓ 3 more',
    ]);
    expect(layout.rows[2]![1]!.dim).toBe(true);
    // Row targets follow the window.
    expect(layout.targets.find((t) => t.id === 'row:svc-6')!.rect.row).toBe(7);
    expect(layout.targets.some((t) => t.id === 'row:svc-0')).toBe(false);
    expect(layout.rows).toHaveLength(10);
  });

  test('a stale scroll is clamped so the cursor stays in view before the next event', () => {
    let state = createPickerState(input);
    for (let i = 0; i < 9; i++) {
      state = pickerStep(state, key('', { downArrow: true })).state;
    }
    // The state has never heard the list's height: the layout still shows the cursor.
    const layout = pickerLayout(state, input, 80, 10);
    expect(layout.rows.some((r) => text(r).includes('❯ ○ svc-9'))).toBe(true);
    expect(text(layout.rows[2]!)).toBe('  ↑ 6 more');
  });

  test('a terminal too short gives the list no rows and clips at the bottom', () => {
    const layout = pickerLayout(createPickerState(input), input, 80, 4);
    expect(layout.listRows).toBe(0);
    expect(layout.rows).toHaveLength(4);
    expect(layout.targets.every((t) => t.rect.row <= 4)).toBe(true);
  });
});

describe('empty lists', () => {
  test('no rows at all', () => {
    const input = pickerInput({ services: [] });
    const layout = pickerLayout(createPickerState(input), input, 80, 10);
    expect(text(layout.rows[1]!)).toBe('  ^c quit');
    expect(text(layout.rows[3]!)).toBe('  No selectable services configured.');
    expect(layout.rows[3]![1]!.color).toBe(WARN_COLOR);
    expect(text(layout.rows[9]!)).toBe('  will start  nothing selected');
    expect(layout.targets.map((t) => t.id)).toEqual(['hint:^c quit']);
  });

  test('no row matches the filter', () => {
    const state = after(createPickerState(pickerInput()), [key('/'), key('z')]);
    const rows = pickerLayout(state, pickerInput(), 80, 10).rows;
    expect(text(rows[3]!)).toBe('  no services match');
    expect(rows[3]![1]!.dim).toBe(true);
  });
});

describe('the filter row', () => {
  test('replaces the keys row while the input is open, and keeps the row count', () => {
    const state = after(createPickerState(pickerInput()), [key('/'), key('f'), key('r')]);
    const layout = pickerLayout(state, pickerInput(), 61, 12);
    expect(text(layout.rows[1]!)).toBe('  filter › fr▏      ⏎ done   esc clear');
    expect(layout.rows[1]!.find((seg) => seg.text === '▏')!.color).toBe(FOCUS_COLOR);
    // The keys row takes two rows at 61 columns; the filter row keeps both.
    expect(text(layout.rows[2]!)).toBe('');
    const targets = layout.targets.filter((t) => t.id.startsWith('hint:'));
    expect(targets.map((t) => [t.id, t.action])).toEqual([
      ['hint:⏎ done', { type: 'filter-done' }],
      ['hint:esc clear', { type: 'filter-cancel' }],
    ]);
    for (const t of targets) {
      expect(cellsAt(layout.rows[t.rect.row - 1]!, t.rect.col, t.rect.width)).toBe(
        t.id.slice('hint:'.length),
      );
    }
  });

  test('a long text is cut from its start, keeping the newest typing', () => {
    const typing = 'x'
      .repeat(40)
      .split('')
      .map((c) => key(c));
    const state = after(createPickerState(pickerInput()), [key('/'), ...typing, key('y')]);
    const row = text(pickerLayout(state, pickerInput(), 50, 12).rows[1]!);
    expect(row).toBe('  filter › …xxxxxxxxxxxxy▏      ⏎ done   esc clear');
    expect(stringWidth(row)).toBeLessThanOrEqual(50);
  });
});

describe('the rule line', () => {
  test('outside a git repository the branch is left out', () => {
    const input = pickerInput({ workspace: { name: 'example', branch: null } });
    const row = text(pickerLayout(createPickerState(input), input, 40, 10).rows[0]!);
    expect(row).toBe('── example ────────── choose services ──');
    expect(stringWidth(row)).toBe(40);
  });

  test('truncates the branch, then drops it, then cuts the name', () => {
    const at = (cols: number, branch: string) => {
      const input = pickerInput({ workspace: { name: 'example', branch } });
      return text(pickerLayout(createPickerState(input), input, cols, 10).rows[0]!);
    };
    // The branch cut from its end, down to 8 cells.
    expect(at(46, 'feature/long-branch-name')).toBe(
      '── example ⎇ feature/lo… ── choose services ──',
    );
    expect(stringWidth(at(46, 'feature/long-branch-name'))).toBe(46);
    expect(at(43, 'feature/long-branch-name')).toBe('── example ⎇ feature… ── choose services ──');
    // Below 8 cells of branch it goes; the name stays whole while it fits.
    expect(at(42, 'feature/long-branch-name')).toBe('── example ──────────── choose services ──');
    // Then the name is cut.
    expect(at(28, 'main')).toBe('── ex… ── choose services ──');
    // Below that the row is clipped at the right.
    expect(stringWidth(at(20, 'main'))).toBe(20);
  });

  test('is no click target', () => {
    const layout = pickerLayout(createPickerState(pickerInput()), pickerInput(), 80, 10);
    expect(layout.targets.some((t) => t.rect.row === 1)).toBe(false);
  });
});

describe('targets match the drawn cells', () => {
  // A wide (CJK) name: two cells per character.
  const WIDE: PickerService[] = [
    { name: '数据库', deps: [], dependents: ['api'], hasRow: true },
    { name: 'api', deps: ['数据库'], dependents: [], hasRow: true },
    { name: 'web', deps: [], dependents: [], hasRow: true },
  ];
  const input = pickerInput({ services: WIDE, saved: ['api'] });

  test('the notes column follows the widest name, in cells', () => {
    const rows = pickerLayout(createPickerState(input), input, 80, 12).rows;
    expect(text(rows[3]!).trimEnd()).toBe('  ❯ ◉ 数据库    needed by api');
    expect(text(rows[4]!).trimEnd()).toBe('    ◉ api');
    // The widest name ends at cell 12, so notes start 4 cells later, at 17.
    expect(cellOf(rows[3]!, 'needed')).toBe(17);
  });

  test('row targets span the whole row; hint targets sit on their key and label', () => {
    const state = after(createPickerState(input), [key('/'), key('数'), key('', { return: true })]);
    const layout = pickerLayout(state, input, 80, 12);
    const row = layout.targets.find((t) => t.id === 'row:数据库')!;
    // The applied filter's hint wraps the keys onto two rows, so the list starts at row 5.
    expect(row.rect).toEqual({ col: 1, row: 5, width: 80, height: 1 });
    expect(row.action).toEqual({ type: 'row', name: '数据库' });
    const hints = layout.targets.filter((t) => t.id.startsWith('hint:'));
    expect(hints.map((t) => t.id)).toContain('hint:esc clear filter');
    for (const t of hints) {
      const drawn = cellsAt(layout.rows[t.rect.row - 1]!, t.rect.col, t.rect.width);
      expect(drawn.startsWith(t.id.slice('hint:'.length)), t.id).toBe(true);
    }
    // The hint after the wide filter text starts where the cells say, not where the string does.
    const filter = hints.find((t) => t.id === 'hint:/ filter:')!;
    expect(cellsAt(layout.rows[filter.rect.row - 1]!, filter.rect.col, filter.rect.width)).toBe(
      '/ filter: 数',
    );
    const esc = hints.find((t) => t.id === 'hint:esc clear filter')!;
    expect(esc.rect.col).toBe(filter.rect.col + filter.rect.width + 3);
  });
});
