import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { stripAnsi } from '../format.js';
import { MOUSE_DISABLE, MOUSE_ENABLE } from '../mouse.js';
import type { PickerInput, PickerService, SelectionRuns } from './picker-state.js';
import { Picker, type PickerProps } from './Picker.js';

// A handler fault goes to the internal debug log; keep it in memory.
const debug = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock(import('../internal-logger.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  debugLog: (...args: unknown[]) => debug.lines.push(args.map(String).join(' ')),
}));

const h = React.createElement;

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

/** The selection plan over EXAMPLE: the picks, then each pick's direct deps. */
function examplePlan(picked: readonly string[]): SelectionRuns {
  const deps = EXAMPLE.filter((s) => picked.includes(s.name)).flatMap((s) => s.deps);
  return [
    ...picked.map((name) => ({ name, why: null })),
    ...deps
      .filter((d) => !picked.includes(d))
      .map((name) => ({ name, why: `runtime dep of ${picked[0]!}` })),
  ];
}

interface Mounted {
  /** Every write to stdout, frames and mode switches alike. */
  writes: string[];
  /** The latest frame, ANSI stripped, trailing blanks trimmed. */
  frame(): string;
  calls: string[];
  /** Keys or mouse reports, as the terminal sends them. */
  send(data: string): Promise<void>;
  click(col: number, row: number): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  unmount(): void;
}

let mounted: Mounted | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  debug.lines.length = 0;
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

/** Mounts the picker over a fake TTY at `columns` × `rows`. */
async function mount(
  over: Partial<PickerProps> = {},
  { columns = 104, rows = 14 } = {},
): Promise<Mounted> {
  const writes: string[] = [];
  const calls: string[] = [];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  });
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows,
    isTTY: true,
    write: (data: string, cb?: () => void) => {
      writes.push(String(data));
      cb?.();
      return true;
    },
  });
  const props: PickerProps = {
    input: pickerInput(),
    plan: examplePlan,
    onSave: (names) => calls.push(`save ${names.join(',')}`),
    onStart: (names) => calls.push(`start ${names.join(',')}`),
    onExit: () => calls.push('quit'),
    ...over,
  };
  const instance = render(h(Picker, props), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await settle();
  const frames = () => writes.filter((w) => w !== MOUSE_ENABLE && w !== MOUSE_DISABLE);
  const m: Mounted = {
    writes,
    calls,
    frame: () =>
      stripAnsi(frames().at(-1) ?? '')
        .split('\n')
        .map((row) => row.trimEnd())
        .join('\n')
        .trimEnd(),
    send: async (data) => {
      stdin.write(data);
      await settle();
    },
    click: async (col, row) => {
      stdin.write(`\x1b[<0;${String(col)};${String(row)}M\x1b[<0;${String(col)};${String(row)}m`);
      await settle();
    },
    resize: async (c, r) => {
      stdout.columns = c;
      stdout.rows = r;
      stdout.emit('resize');
      await settle();
    },
    unmount: () => instance.unmount(),
  };
  mounted = m;
  return m;
}

/** 1-based (row, col) of the first cell of `text` in the frame. */
function positionOf(frame: string, text: string): { row: number; col: number } {
  const rows = frame.split('\n');
  const row = rows.findIndex((r) => r.includes(text));
  expect(row, `${text} on screen:\n${frame}`).toBeGreaterThanOrEqual(0);
  return { row: row + 1, col: rows[row]!.indexOf(text) + 1 };
}

describe('Picker', () => {
  test('draws the layout filling the screen, and takes the mouse on mount', async () => {
    const m = await mount({ input: pickerInput({ saved: ['frontend'] }) });
    expect(m.writes.filter((w) => w === MOUSE_ENABLE)).toHaveLength(1);
    expect(m.frame()).toBe(
      [
        '── example ⎇ 1.0.0 ────────────────────────────────────────────────────────────────── choose services ──',
        '  space select  ↑ ↓ move  / filter  n none  ⏎ start  ^c quit',
        '',
        '  ❯ ◉ backend     needed by frontend',
        '    ◉ frontend',
        '    ○ worker',
        '',
        '',
        '',
        '',
        '',
        '',
        '────────────────────────────────────────────────────────────────────────────────────────────────────────',
        '  will start  frontend · backend   │   infra: db · mail',
      ].join('\n'),
    );
  });

  test('the "will start" line follows the selection plan it is given', async () => {
    // A plan that also runs `worker`, which no service's `deps` name: only the plan says so.
    const plan = (picked: readonly string[]): SelectionRuns => [
      ...examplePlan(picked),
      ...(picked.length > 0 ? [{ name: 'worker', why: 'runtime dep of frontend' }] : []),
    ];
    const m = await mount({ plan, input: pickerInput({ saved: ['frontend'] }) });
    expect(m.frame()).toContain('will start  frontend · backend · worker');
  });

  test('space toggles the cursor row, and Enter saves, then starts, with the picks', async () => {
    const m = await mount();
    await m.send(' ');
    expect(m.frame()).toContain('❯ ◉ backend');
    await m.send('\x1b[B');
    await m.send(' ');
    await m.send('\r');
    expect(m.calls).toEqual(['save backend,frontend', 'start backend,frontend']);
  });

  test('a second start before the picker goes saves nothing more and starts nothing more', async () => {
    const m = await mount({ input: pickerInput({ saved: ['worker'] }) });
    await m.send('\r');
    await m.send('\r');
    const start = positionOf(m.frame(), '⏎ start');
    await m.click(start.col, start.row);
    expect(m.calls).toEqual(['save worker', 'start worker']);
  });

  test('a click on a row toggles it; on a locked dependency it toasts, once however often', async () => {
    const m = await mount();
    const frontend = positionOf(m.frame(), 'frontend');
    await m.click(frontend.col, frontend.row);
    expect(m.frame()).toContain('◉ frontend');
    expect(m.frame()).toContain('needed by frontend');

    const backend = positionOf(m.frame(), '◉ backend');
    await m.click(backend.col, backend.row);
    // The cursor moved to it; nothing changed but the toast.
    expect(m.frame()).toContain('❯ ◉ backend');
    expect(m.frame()).toContain('backend is needed by frontend');
    await m.click(backend.col, backend.row);
    await m.send(' ');
    const toasts = m
      .frame()
      .split('\n')
      .filter((row) => row.includes('backend is needed by'));
    expect(toasts).toHaveLength(1);
    // The toast floats just above the bottom rule, adding no row.
    const rows = m.frame().split('\n');
    const rule = rows.findIndex((row) => /^─+$/.test(row));
    expect(rows[rule - 1]).toContain('backend is needed by frontend');
    expect(rows).toHaveLength(14);
  });

  test('hints are clickable: n none, / filter, ⏎ start, ^c quit', async () => {
    const m = await mount({ input: pickerInput({ saved: ['worker'] }) });
    const none = positionOf(m.frame(), 'n none');
    await m.click(none.col, none.row);
    expect(m.frame()).toContain('will start  nothing selected');

    await m.send(' ');
    const start = positionOf(m.frame(), '⏎ start');
    await m.click(start.col + 2, start.row);
    expect(m.calls).toEqual(['save backend', 'start backend']);

    const filter = positionOf(m.frame(), '/ filter');
    await m.click(filter.col, filter.row);
    await m.send('wor');
    expect(m.frame()).toContain('filter › wor▏');
    expect(m.frame()).not.toContain('○ backend');
    await m.send('\r');
    expect(m.frame()).toContain('/ filter: wor');

    const quit = positionOf(m.frame(), '^c quit');
    await m.click(quit.col, quit.row);
    expect(m.calls.at(-1)).toBe('quit');
  });

  test('Ctrl+C quits, in the list and in the filter input', async () => {
    const m = await mount();
    await m.send('\x03');
    await m.send('/');
    await m.send('\x03');
    expect(m.calls).toEqual(['quit', 'quit']);
  });

  test('the wheel moves the cursor without wrapping', async () => {
    const m = await mount();
    await m.send('\x1b[<65;5;5M');
    await m.send('\x1b[<65;5;5M');
    await m.send('\x1b[<65;5;5M');
    expect(m.frame()).toContain('❯ ○ worker');
    await m.send('\x1b[<64;5;5M');
    expect(m.frame()).toContain('❯ ○ frontend');
  });

  test('a shorter screen scrolls the list to keep the cursor in view', async () => {
    const m = await mount({}, { columns: 104, rows: 14 });
    await m.resize(104, 7);
    // Seven rows leave one list row: the cursor's.
    expect(m.frame()).toContain('❯ ○ backend');
    expect(m.frame()).toContain('↓ 2 more');
    await m.send('\x1b[B');
    await m.send('\x1b[B');
    expect(m.frame()).toContain('❯ ○ worker');
    expect(m.frame()).toContain('↑ 2 more');
    expect(m.frame()).not.toContain('frontend');
  });

  test('unmounting releases the mouse', async () => {
    const m = await mount();
    m.unmount();
    const modes = m.writes.filter((w) => w === MOUSE_ENABLE || w === MOUSE_DISABLE);
    expect(modes).toEqual([MOUSE_ENABLE, MOUSE_DISABLE]);
    mounted = undefined;
  });

  test('a failing effect is logged, and the picker stays up', async () => {
    const m = await mount({
      onSave: () => {
        throw new Error('disk full');
      },
    });
    await m.send(' ');
    await m.send('\r');
    expect(m.calls).toEqual(['start backend']);
    expect(debug.lines).toEqual(['picker: save the selection failed: disk full']);
    expect(m.frame()).toContain('❯ ◉ backend');
  });
});
