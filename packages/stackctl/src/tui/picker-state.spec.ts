import { describe, expect, test } from 'vitest';
import type { KeyFlags } from './keymap.js';
import { pickerLayout } from './picker-layout.js';
import {
  type PickerAction,
  type PickerEffect,
  type PickerEvent,
  type PickerInput,
  type PickerService,
  type PickerState,
  createPickerState,
  isLocked,
  pickerHints,
  pickerStep,
  resolvePickerKey,
  visibleRows,
  willStart,
  windowTop,
} from './picker-state.js';

/** The example's app services, in the order the rows appear. */
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

function stateOf(over: Partial<PickerInput> = {}): PickerState {
  return createPickerState(pickerInput(over));
}

type Press = string | { input?: string; key: KeyFlags };

const KEYS = {
  space: ' ',
  up: { key: { upArrow: true } },
  down: { key: { downArrow: true } },
  enter: { key: { return: true } },
  esc: { key: { escape: true } },
  backspace: { key: { delete: true } },
  ctrlC: { input: 'c', key: { ctrl: true } },
} satisfies Record<string, Press>;

function keyEvent(press: Press): PickerEvent {
  return typeof press === 'string'
    ? { type: 'key', input: press, key: {}, at: 0 }
    : { type: 'key', input: press.input ?? '', key: press.key, at: 0 };
}

/** Runs events in order; returns the last state and every effect, in order. */
function run(
  state: PickerState,
  events: (Press | { click: PickerAction | null } | PickerEvent)[],
): { state: PickerState; effects: PickerEffect[] } {
  const effects: PickerEffect[] = [];
  for (const e of events) {
    const event: PickerEvent =
      typeof e === 'string' || 'key' in e
        ? keyEvent(e)
        : 'click' in e
          ? { type: 'click', action: e.click, at: 0 }
          : e;
    const next = pickerStep(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

/** Types `text` one character at a time. */
function typed(text: string): string[] {
  return Array.from(text);
}

describe('pre-selection', () => {
  test('the saved names are picked, in list order, and the cursor starts on the first row', () => {
    const state = stateOf({ saved: ['worker', 'frontend'] });
    expect(state.picked).toEqual(['frontend', 'worker']);
    expect(state.cursor).toBe('backend');
  });

  test('a stale saved name is ignored', () => {
    const services: PickerService[] = [
      ...EXAMPLE,
      // A service that is registered but has no row (`selectable: false`, or not startable).
      { name: 'hidden', deps: [], dependents: [], hasRow: false },
    ];
    let state!: PickerState;
    expect(() => {
      state = stateOf({ services, saved: ['gone', 'frontend', 'hidden'] });
    }).not.toThrow();
    expect(state.picked).toEqual(['frontend']);
    expect(() => pickerLayout(state, pickerInput({ services }), 104, 12)).not.toThrow();
    const { effects } = run(state, [KEYS.enter]);
    expect(effects).toEqual([
      { type: 'save-selection', names: ['frontend'] },
      { type: 'start', names: ['frontend'] },
    ]);
  });
});

describe('picks and locking', () => {
  test('space toggles the cursor row', () => {
    const { state } = run(stateOf(), [KEYS.down, KEYS.space]);
    expect(state.picked).toEqual(['frontend']);
    expect(run(state, [KEYS.space]).state.picked).toEqual([]);
  });

  test('picking a service locks its direct deps, and unpicking it unlocks them', () => {
    const picked = run(stateOf(), [KEYS.down, KEYS.space]).state;
    expect(isLocked(picked, 'backend')).toBe(true);
    expect(isLocked(picked, 'worker')).toBe(false);
    expect(willStart(picked).map((w) => w.name)).toEqual(['frontend', 'backend']);
    const unpicked = run(picked, [KEYS.space]).state;
    expect(isLocked(unpicked, 'backend')).toBe(false);
    expect(unpicked.picked).toEqual([]);
  });

  test('given the selection plan, "will start" lists its picks, then its deps, in list order', () => {
    const state = stateOf({ saved: ['frontend', 'worker'] });
    // The plan's own order is the most depended-on first; the line keeps picks first.
    const runs = [
      { name: 'backend', why: 'runtime dep of frontend' },
      { name: 'frontend', why: null },
      { name: 'worker', why: null },
    ];
    expect(willStart(state, runs).map((w) => w.name)).toEqual(['frontend', 'worker', 'backend']);
    // Only the plan decides what runs: a dep it doesn't list is left out.
    expect(willStart(state, runs.slice(1)).map((w) => w.name)).toEqual(['frontend', 'worker']);
  });

  test('space on a locked row changes nothing and shows the toast', () => {
    const state = stateOf({ saved: ['frontend'] });
    const { state: next, effects } = run(state, [KEYS.space]);
    expect(next).toEqual(state);
    expect(effects).toEqual([
      { type: 'toast', text: 'backend is needed by frontend', tone: 'info' },
    ]);
  });

  test('clicking a locked dependency toasts "backend is needed by frontend"', () => {
    const state = run(stateOf({ saved: ['frontend'] }), [KEYS.up]).state;
    expect(state.cursor).toBe('worker');
    const { state: next, effects } = run(state, [{ click: { type: 'row', name: 'backend' } }]);
    expect(next.picked).toEqual(['frontend']);
    expect(next.cursor).toBe('backend');
    expect(effects).toEqual([
      { type: 'toast', text: 'backend is needed by frontend', tone: 'info' },
    ]);
  });

  test('the toast names every picked dependent', () => {
    const services: PickerService[] = [
      { name: 'api', deps: [], dependents: ['web', 'admin'], hasRow: true },
      { name: 'admin', deps: ['api'], dependents: [], hasRow: true },
      { name: 'web', deps: ['api'], dependents: [], hasRow: true },
    ];
    const { effects } = run(stateOf({ services, saved: ['web', 'admin'] }), [KEYS.space]);
    expect(effects).toEqual([
      { type: 'toast', text: 'api is needed by admin and web', tone: 'info' },
    ]);
  });

  test('a dep picked by hand stays selected when its dependent goes', () => {
    // Picked by hand, then its dependent picked: it locks, and stays picked underneath.
    const both = run(stateOf(), [KEYS.space, KEYS.down, KEYS.space]).state;
    expect(both.picked).toEqual(['backend', 'frontend']);
    expect(isLocked(both, 'backend')).toBe(true);
    const handPicked = run(both, [KEYS.space]).state;
    expect(handPicked.picked).toEqual(['backend']);
    expect(isLocked(handPicked, 'backend')).toBe(false);

    // Only pulled in: unpicking its dependent leaves it unpicked.
    const pulled = run(stateOf(), [KEYS.down, KEYS.space, KEYS.space]).state;
    expect(pulled.picked).toEqual([]);
    expect(isLocked(pulled, 'backend')).toBe(false);
  });

  test('a row click moves the cursor to it, then toggles it', () => {
    const { state, effects } = run(stateOf(), [{ click: { type: 'row', name: 'worker' } }]);
    expect(state.cursor).toBe('worker');
    expect(state.picked).toEqual(['worker']);
    expect(effects).toEqual([]);
    // A double-click is two clicks.
    expect(run(state, [{ click: { type: 'row', name: 'worker' } }]).state.picked).toEqual([]);
  });

  test('n clears the selection', () => {
    const state = stateOf({ saved: ['frontend', 'worker'] });
    const { state: next, effects } = run(state, ['n']);
    expect(next.picked).toEqual([]);
    expect(isLocked(next, 'backend')).toBe(false);
    expect(effects).toEqual([]);
    // With nothing picked, `n` does nothing.
    expect(run(next, ['n']).state).toBe(next);
  });

  test('n clears picks the filter hides', () => {
    const state = run(stateOf({ saved: ['frontend', 'worker'] }), [
      '/',
      ...typed('work'),
      KEYS.enter,
    ]).state;
    expect(visibleRows(state).map((s) => s.name)).toEqual(['worker']);
    expect(run(state, ['n']).state.picked).toEqual([]);
  });

  test('c does nothing in the picker', () => {
    const state = stateOf({ saved: ['frontend'] });
    expect(run(state, ['c']).state).toBe(state);
  });
});

describe('start and quit', () => {
  test('Enter saves the picks, then starts them, in list order', () => {
    const state = run(stateOf(), [KEYS.up, KEYS.space, KEYS.up, KEYS.space]).state;
    expect(state.picked).toEqual(['frontend', 'worker']);
    expect(run(state, [KEYS.enter]).effects).toEqual([
      { type: 'save-selection', names: ['frontend', 'worker'] },
      { type: 'start', names: ['frontend', 'worker'] },
    ]);
  });

  test('Enter with nothing picked does nothing', () => {
    const state = stateOf();
    const { state: next, effects } = run(state, [KEYS.enter]);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  test('Ctrl+C quits, from the list and from the filter input', () => {
    expect(run(stateOf(), [KEYS.ctrlC]).effects).toEqual([{ type: 'quit' }]);
    expect(run(stateOf(), ['/', KEYS.ctrlC]).effects).toEqual([{ type: 'quit' }]);
  });

  test('expire changes nothing', () => {
    const state = stateOf({ saved: ['frontend'] });
    expect(pickerStep(state, { type: 'expire', at: 1_000 })).toEqual({ state, effects: [] });
  });
});

describe('the filter', () => {
  test('/ opens the filter, ready to type', () => {
    const open = run(stateOf(), ['/']).state;
    expect(open.input).toBe('');
    // Letters that are keys in the list, and space, are typed.
    const typing = run(open, typed('n t')).state;
    expect(typing.input).toBe('n t');
    expect(typing.picked).toEqual([]);
    // The list filters at once: `n` and `t` are both in `frontend` only.
    expect(visibleRows(typing).map((s) => s.name)).toEqual(['frontend']);
    expect(typing.cursor).toBe('frontend');
  });

  test('/ opens holding the applied filter', () => {
    const applied = run(stateOf(), ['/', ...typed('work'), KEYS.enter]).state;
    expect(applied.filter).toBe('work');
    expect(applied.input).toBeNull();
    expect(run(applied, ['/']).state.input).toBe('work');
  });

  test('space while filtered toggles the visible row', () => {
    const state = run(stateOf(), ['/', ...typed('wor'), KEYS.enter]).state;
    expect(visibleRows(state).map((s) => s.name)).toEqual(['worker']);
    const { state: next } = run(state, [KEYS.space]);
    // Not `backend`, the first row of the full list.
    expect(next.picked).toEqual(['worker']);
  });

  test('↑ and ↓ wrap among the visible rows only', () => {
    const state = run(stateOf(), ['/', 'e', 'n', 'd', KEYS.enter]).state;
    expect(visibleRows(state).map((s) => s.name)).toEqual(['backend', 'frontend']);
    expect(run(state, [KEYS.down]).state.cursor).toBe('frontend');
    expect(run(state, [KEYS.down, KEYS.down]).state.cursor).toBe('backend');
    expect(run(state, [KEYS.up]).state.cursor).toBe('frontend');
  });

  test('↑ and ↓ move the cursor while the input is open', () => {
    const state = run(stateOf(), ['/', 'e', KEYS.down]).state;
    expect(state.input).toBe('e');
    expect(state.cursor).toBe('frontend');
  });

  test('matching ignores case and accents, and every term must match', () => {
    expect(visibleRows(run(stateOf(), ['/', ...typed('FRÖ')]).state).map((s) => s.name)).toEqual([
      'frontend',
    ]);
    expect(visibleRows(run(stateOf(), ['/', ...typed('back end')]).state)).toHaveLength(1);
    expect(visibleRows(run(stateOf(), ['/', ...typed('back worker')]).state)).toHaveLength(0);
  });

  test('the cursor stays on its service while it is visible, else goes to the first visible row', () => {
    const onFrontend = run(stateOf(), [KEYS.down]).state;
    expect(run(onFrontend, ['/', 'n']).state.cursor).toBe('frontend');
    expect(run(onFrontend, ['/', 'w']).state.cursor).toBe('worker');
  });

  test('no visible row means no cursor: space does nothing, and clearing goes to the first row', () => {
    const none = run(stateOf(), ['/', ...typed('zzz')]).state;
    expect(none.cursor).toBeNull();
    const closed = run(none, [KEYS.enter]).state;
    expect(closed.filter).toBe('zzz');
    expect(run(closed, [KEYS.space]).state).toBe(closed);
    expect(pickerHints(closed).find((h) => h.key === 'space')?.disabled).toBe(true);
    const cleared = run(closed, [KEYS.esc]).state;
    expect(cleared.filter).toBe('');
    expect(cleared.cursor).toBe('backend');
  });

  test('clearing the filter leaves the cursor on its service', () => {
    const state = run(stateOf(), ['/', 'w', KEYS.enter]).state;
    expect(state.cursor).toBe('worker');
    expect(run(state, [KEYS.esc]).state.cursor).toBe('worker');
  });

  test('Esc in the input clears the text and closes it; Backspace removes the last character', () => {
    const state = run(stateOf(), ['/', ...typed('wox'), KEYS.backspace]).state;
    expect(state.input).toBe('wo');
    const closed = run(state, [KEYS.esc]).state;
    expect(closed.input).toBeNull();
    expect(closed.filter).toBe('');
    expect(visibleRows(closed)).toHaveLength(3);
  });

  test('Enter with an empty text clears the filter', () => {
    const state = run(stateOf(), ['/', 'w', KEYS.enter, '/', KEYS.backspace, KEYS.enter]).state;
    expect(state.filter).toBe('');
    expect(state.input).toBeNull();
  });

  test('Esc without an applied filter does nothing', () => {
    const state = stateOf();
    expect(run(state, [KEYS.esc]).state).toBe(state);
  });

  test('pasted text is appended whole, line breaks dropped', () => {
    expect(run(stateOf(), ['/', 'fr\non']).state.input).toBe('fron');
  });

  test('the filter hides rows but never changes the picks', () => {
    const state = run(stateOf({ saved: ['frontend'] }), ['/', ...typed('work'), KEYS.enter]).state;
    expect(state.picked).toEqual(['frontend']);
    expect(isLocked(state, 'backend')).toBe(true);
    expect(willStart(state).map((w) => w.name)).toEqual(['frontend', 'backend']);
  });

  test('while the input is open, a row click toggles it and other list clicks are ignored', () => {
    const open = run(stateOf(), ['/', 'e']).state;
    const clicked = run(open, [{ click: { type: 'row', name: 'frontend' } }]).state;
    expect(clicked.picked).toEqual(['frontend']);
    expect(clicked.input).toBe('e');
    expect(run(open, [{ click: { type: 'none' } }, { click: { type: 'start' } }]).state).toBe(open);
    expect(run(open, [{ click: null }]).state).toBe(open);
  });
});

describe('scrolling', () => {
  const MANY: PickerService[] = Array.from({ length: 10 }, (_, i) => ({
    name: `svc-${i}`,
    deps: [],
    dependents: [],
    hasRow: true,
  }));

  test('the list scrolls to keep the cursor visible', () => {
    let state = run(stateOf({ services: MANY }), [{ type: 'resize', listRows: 3 }]).state;
    expect(state.scroll).toBe(0);
    state = run(state, [KEYS.down, KEYS.down]).state;
    expect(state.scroll).toBe(0);
    state = run(state, [KEYS.down, KEYS.down]).state;
    expect(state.cursor).toBe('svc-4');
    expect(state.scroll).toBe(2);
    // Up within the window doesn't move it.
    state = run(state, [KEYS.up, KEYS.up]).state;
    expect(state.scroll).toBe(2);
    state = run(state, [KEYS.up]).state;
    expect(state.scroll).toBe(1);
  });

  test('a wrap jumps the window to that end', () => {
    const state = run(stateOf({ services: MANY }), [
      { type: 'resize', listRows: 3 },
      KEYS.up,
    ]).state;
    expect(state.cursor).toBe('svc-9');
    expect(state.scroll).toBe(7);
    expect(run(state, [KEYS.down]).state.scroll).toBe(0);
  });

  test('a resize keeps the cursor in view', () => {
    let state = run(stateOf({ services: MANY }), [{ type: 'resize', listRows: 8 }]).state;
    state = run(
      state,
      Array.from({ length: 6 }, () => KEYS.down),
    ).state;
    expect(state.scroll).toBe(0);
    state = run(state, [{ type: 'resize', listRows: 4 }]).state;
    expect(state.scroll).toBe(3);
    // Growing again shows rows above rather than blank rows below.
    expect(run(state, [{ type: 'resize', listRows: 8 }]).state.scroll).toBe(2);
  });

  test('a wheel notch moves the cursor one row, without wrapping', () => {
    const state = run(stateOf({ services: MANY }), [{ type: 'resize', listRows: 3 }]).state;
    expect(pickerStep(state, { type: 'wheel', delta: -1, at: 0 }).state).toBe(state);
    const down = run(
      state,
      Array.from({ length: 4 }, () => ({ type: 'wheel', delta: 1, at: 0 }) as const),
    ).state;
    expect(down.cursor).toBe('svc-4');
    expect(down.scroll).toBe(2);
  });

  test('the window helper never leaves the cursor out', () => {
    expect(windowTop(0, 5, 3, 10)).toBe(3);
    expect(windowTop(6, 2, 3, 10)).toBe(2);
    expect(windowTop(9, 9, 3, 10)).toBe(7);
    expect(windowTop(4, -1, 3, 2)).toBe(0);
  });
});

describe('no rows', () => {
  test('only ^c quit is offered, and it works', () => {
    const state = stateOf({ services: [] });
    expect(state.cursor).toBeNull();
    expect(pickerHints(state).map((h) => `${h.key} ${h.label}`)).toEqual(['^c quit']);
    for (const press of [KEYS.space, KEYS.down, '/', 'n', KEYS.enter]) {
      expect(run(state, [press])).toEqual({ state, effects: [] });
    }
    expect(run(state, [KEYS.ctrlC]).effects).toEqual([{ type: 'quit' }]);
  });
});

describe('hints', () => {
  /** The press each hint advertises. `↑↓` is ↓'s hint. */
  const PRESS_FOR: Record<string, Press> = {
    space: KEYS.space,
    '↑↓': KEYS.down,
    '/': '/',
    esc: KEYS.esc,
    n: 'n',
    '⏎': KEYS.enter,
    '^c': KEYS.ctrlC,
  };

  const STATES: [string, PickerState][] = [
    ['nothing picked', stateOf()],
    ['frontend picked', stateOf({ saved: ['frontend'] })],
    ['a filter applied', run(stateOf({ saved: ['worker'] }), ['/', 'w', KEYS.enter]).state],
    ['the filter input open', run(stateOf({ saved: ['worker'] }), ['/', 'w']).state],
    ['no rows', stateOf({ services: [] })],
  ];

  test.each(STATES)(
    "every hint's target dispatches the same action as its key (%s)",
    (_, state) => {
      const layout = pickerLayout(state, pickerInput({ services: state.services }), 104, 14);
      const hints = layout.targets.filter((t) => t.id.startsWith('hint:'));
      expect(hints.map((t) => t.id.slice('hint:'.length))).toEqual(
        pickerHints(state).map((h) => `${h.key} ${h.label}`),
      );
      for (const target of hints) {
        const key = target.id.slice('hint:'.length).split(' ')[0]!;
        const press = PRESS_FOR[key]!;
        expect(press, key).toBeDefined();
        const event = keyEvent(press);
        if (event.type !== 'key') {
          throw new Error('not a key');
        }
        expect(resolvePickerKey(state, event.input, event.key)).toEqual(target.action);
        expect(pickerStep(state, { type: 'click', action: target.action, at: 0 })).toEqual(
          pickerStep(state, event),
        );
      }
    },
  );

  test('the keys row reads as the spec lists it', () => {
    const labels = (state: PickerState) =>
      pickerHints(state).map((h) => `${h.key} ${h.label}${h.detail ? ` ${h.detail}` : ''}`);
    expect(labels(stateOf())).toEqual([
      'space select',
      '↑↓ move',
      '/ filter',
      'n none',
      '⏎ start',
      '^c quit',
    ]);
    expect(labels(run(stateOf(), ['/', 'w', KEYS.enter]).state)).toEqual([
      'space select',
      '↑↓ move',
      '/ filter: w',
      'esc clear filter',
      'n none',
      '⏎ start',
      '^c quit',
    ]);
    expect(labels(run(stateOf(), ['/']).state)).toEqual(['⏎ done', 'esc clear']);
  });

  test('⏎ start is dim while nothing is picked', () => {
    const start = (state: PickerState) => pickerHints(state).find((h) => h.key === '⏎')!;
    expect(start(stateOf()).disabled).toBe(true);
    expect(start(stateOf({ saved: ['worker'] })).disabled).toBe(false);
  });

  test('↑↓ move moves the cursor down one row', () => {
    const { state } = run(stateOf(), [{ click: { type: 'move', delta: 1 } }]);
    expect(state.cursor).toBe('frontend');
  });
});
