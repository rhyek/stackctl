import { describe, expect, test } from 'vitest';
import { type Action, type Entry, hintsFor, resolveKey } from './keymap.js';
import {
  type Effect,
  QUIT_CONFIRM_MS,
  RESET_CONFIRM_MS,
  type UiContext,
  type UiState,
  focusIndex,
  initialUiState,
  keyContext,
  nextExpiry,
  step,
} from './ui-state.js';

const ENTRIES: Entry[] = [
  { kind: 'app', name: 'api', state: 'running' },
  { kind: 'app', name: 'web', state: 'running' },
  { kind: 'infra', name: 'db', state: 'running' },
  { kind: 'infra', name: 'mail', state: 'running' },
];

function context(over: Partial<UiContext> = {}): UiContext {
  return {
    phase: 'running',
    entries: ENTRIES,
    // `● api` `● web` on row 1, then `infra   ● db   ● mail` wrapped to row 2.
    rects: [
      { col: 2, row: 1 },
      { col: 10, row: 1 },
      { col: 10, row: 2 },
      { col: 17, row: 2 },
    ],
    commands: { api: ['add-random-todo'], web: ['build', 'preview'] },
    hasSelection: false,
    hasStickyToast: false,
    ...over,
  };
}

/** Runs events in order; returns the last state and every effect, in order. */
function run(
  state: UiState,
  events: ({ key: Action } | { click: Action | null } | { expire: true })[],
  { at = 0, ctx = context() }: { at?: number; ctx?: UiContext } = {},
): { state: UiState; effects: Effect[] } {
  const effects: Effect[] = [];
  for (const e of events) {
    const event =
      'key' in e
        ? ({ type: 'key', action: e.key, at, ctx } as const)
        : 'click' in e
          ? ({ type: 'click', action: e.click, at, ctx } as const)
          : ({ type: 'expire', at } as const);
    const next = step(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const QUIT: Action = { type: 'quit' };
const RESET: Action = { type: 'reset-infra' };
const focusOn = (name: string): UiState => ({
  ...initialUiState,
  focus: { kind: ENTRIES.find((e) => e.name === name)!.kind, name },
});

describe('the quit confirmation', () => {
  test('a second quit within expiry confirms', () => {
    const first = run(initialUiState, [{ key: QUIT }], { at: 1_000 });
    expect(first.effects).toEqual([{ type: 'arm', kind: 'quit', ms: QUIT_CONFIRM_MS }]);
    expect(first.state.pending).toEqual([{ kind: 'quit', expiresAt: 1_000 + QUIT_CONFIRM_MS }]);

    const second = run(first.state, [{ key: QUIT }], { at: 1_000 + QUIT_CONFIRM_MS - 1 });
    expect(second.effects).toEqual([{ type: 'disarm', kind: 'quit' }, { type: 'shutdown' }]);
    expect(second.state.pending).toEqual([]);
  });

  test('a quit at or after expiry arms again instead, even before the expiry event', () => {
    const first = run(initialUiState, [{ key: QUIT }], { at: 0 });
    const late = run(first.state, [{ key: QUIT }], { at: QUIT_CONFIRM_MS });
    expect(late.effects).toEqual([
      { type: 'disarm', kind: 'quit' },
      { type: 'arm', kind: 'quit', ms: QUIT_CONFIRM_MS },
    ]);
    expect(late.state.pending).toEqual([{ kind: 'quit', expiresAt: 2 * QUIT_CONFIRM_MS }]);
  });

  test('expiry disarms and dismisses the toast, exactly at its time', () => {
    const armed = run(initialUiState, [{ key: QUIT }], { at: 0 }).state;
    expect(nextExpiry(armed)).toBe(QUIT_CONFIRM_MS);
    expect(run(armed, [{ expire: true }], { at: QUIT_CONFIRM_MS - 1 }).state.pending).toHaveLength(
      1,
    );
    const expired = run(armed, [{ expire: true }], { at: QUIT_CONFIRM_MS });
    expect(expired.effects).toEqual([{ type: 'disarm', kind: 'quit' }]);
    expect(expired.state.pending).toEqual([]);
    expect(nextExpiry(expired.state)).toBeNull();
    // A quit after the expiry arms, not confirms.
    expect(run(expired.state, [{ key: QUIT }], { at: QUIT_CONFIRM_MS }).effects).toEqual([
      { type: 'arm', kind: 'quit', ms: QUIT_CONFIRM_MS },
    ]);
  });

  test('a confirmation armed by a click expires like one armed by a key', () => {
    const byKey = run(initialUiState, [{ key: QUIT }], { at: 500 }).state;
    const byClick = run(initialUiState, [{ click: QUIT }], { at: 500 }).state;
    expect(byClick).toEqual(byKey);
    for (const armed of [byKey, byClick]) {
      expect(nextExpiry(armed)).toBe(500 + QUIT_CONFIRM_MS);
      expect(run(armed, [{ expire: true }], { at: 500 + QUIT_CONFIRM_MS }).state.pending).toEqual(
        [],
      );
    }
    // The same holds for the reset confirmation.
    const resetByKey = run(focusOn('db'), [{ key: RESET }], { at: 500 }).state;
    const resetByClick = run(focusOn('db'), [{ click: RESET }], { at: 500 }).state;
    expect(resetByClick).toEqual(resetByKey);
    expect(nextExpiry(resetByClick)).toBe(500 + RESET_CONFIRM_MS);
    expect(run(resetByClick, [{ expire: true }], { at: 500 + RESET_CONFIRM_MS }).effects).toEqual([
      { type: 'disarm', kind: 'reset-infra', target: 'db' },
    ]);
  });

  test('a click on ^c quit confirms a quit armed by Ctrl+C, and the reverse', () => {
    const keyThenClick = run(initialUiState, [{ key: QUIT }, { click: QUIT }]);
    expect(keyThenClick.effects.at(-1)).toEqual({ type: 'shutdown' });
    const clickThenKey = run(initialUiState, [{ click: QUIT }, { key: QUIT }]);
    expect(clickThenKey.effects.at(-1)).toEqual({ type: 'shutdown' });
  });

  test('other keys do not disarm it', () => {
    const { state, effects } = run(initialUiState, [
      { key: QUIT },
      { key: { type: 'clear-log' } },
      { key: { type: 'focus-next' } },
      { key: QUIT },
    ]);
    expect(effects.at(-1)).toEqual({ type: 'shutdown' });
    expect(state.pending).toEqual([]);
  });

  test('a click anywhere else disarms it and dismisses its toast', () => {
    for (const elsewhere of [
      null,
      { type: 'clear-log' },
      { type: 'focus-index', index: 1 },
    ] as const) {
      const { state, effects } = run(initialUiState, [{ key: QUIT }, { click: elsewhere }]);
      expect(state.pending, JSON.stringify(elsewhere)).toEqual([]);
      expect(effects).toContainEqual({ type: 'disarm', kind: 'quit' });
      expect(run(state, [{ key: QUIT }]).effects).toEqual([
        { type: 'arm', kind: 'quit', ms: QUIT_CONFIRM_MS },
      ]);
    }
  });

  test('one quit shuts down during startup and after a startup failure', () => {
    for (const phase of ['starting', 'failed'] as const) {
      const { state, effects } = run(initialUiState, [{ key: QUIT }], { ctx: context({ phase }) });
      expect(effects).toEqual([{ type: 'shutdown' }]);
      expect(state.pending).toEqual([]);
    }
  });

  test('a quit while shutting down is the second request', () => {
    const ctx = context({ phase: 'stopping' });
    expect(run(initialUiState, [{ key: QUIT }], { ctx }).effects).toEqual([{ type: 'shutdown' }]);
  });

  test('quit works in filter and commands mode, and leaves the mode alone', () => {
    const inFilter = run(initialUiState, [{ key: { type: 'open-filter' } }, { key: QUIT }]);
    expect(inFilter.state.mode).toBe('filter');
    expect(inFilter.state.pending).toHaveLength(1);
    const inMenu = run(focusOn('api'), [
      { key: { type: 'open-commands' } },
      { key: QUIT },
      { click: QUIT },
    ]);
    expect(inMenu.state.mode).toBe('commands');
    expect(inMenu.effects.at(-1)).toEqual({ type: 'shutdown' });
  });
});

describe('the infra reset confirmation', () => {
  test('a second reset on the same entry within the window resets it', () => {
    const { state, effects } = run(focusOn('db'), [{ key: RESET }, { key: RESET }], { at: 0 });
    expect(effects).toEqual([
      { type: 'arm', kind: 'reset-infra', target: 'db', ms: RESET_CONFIRM_MS },
      { type: 'disarm', kind: 'reset-infra', target: 'db' },
      { type: 'reset-infra', target: 'db' },
    ]);
    expect(state.pending).toEqual([]);
  });

  test('a reset on another entry arms that one instead', () => {
    const armed = run(focusOn('db'), [{ key: RESET }]).state;
    const moved = run(armed, [{ key: { type: 'focus-next' } }, { key: RESET }]);
    expect(moved.effects).toEqual([
      { type: 'disarm', kind: 'reset-infra', target: 'db' },
      { type: 'arm', kind: 'reset-infra', target: 'mail', ms: RESET_CONFIRM_MS },
    ]);
    expect(moved.state.pending).toEqual([
      { kind: 'reset-infra', target: 'mail', expiresAt: RESET_CONFIRM_MS },
    ]);
  });

  test('the toast button confirms its own entry, wherever the focus went', () => {
    const armed = run(focusOn('db'), [
      { key: RESET },
      { key: { type: 'focus-index', index: 0 } },
    ]).state;
    const { effects } = run(armed, [{ click: { type: 'reset-infra', target: 'db' } }]);
    expect(effects).toEqual([
      { type: 'disarm', kind: 'reset-infra', target: 'db' },
      { type: 'reset-infra', target: 'db' },
    ]);
  });

  test('a click on the R reset data hint of the armed entry confirms; any other click disarms', () => {
    const armed = run(focusOn('db'), [{ click: RESET }]).state;
    expect(run(armed, [{ click: RESET }]).effects.at(-1)).toEqual({
      type: 'reset-infra',
      target: 'db',
    });
    const away = run(armed, [{ click: { type: 'restart' } }]);
    expect(away.state.pending).toEqual([]);
    expect(away.effects[0]).toEqual({ type: 'disarm', kind: 'reset-infra', target: 'db' });
  });

  test('a busy entry neither arms nor confirms', () => {
    const busy = context({
      entries: ENTRIES.map((e) =>
        e.name === 'db' ? { ...e, kind: 'infra', state: 'resetting' } : e,
      ),
    });
    expect(run(focusOn('db'), [{ key: RESET }], { ctx: busy }).effects).toEqual([]);
    const armed = run(focusOn('db'), [{ key: RESET }]).state;
    expect(run(armed, [{ key: RESET }], { ctx: busy }).effects).toEqual([]);
  });

  test('quit and reset are armed independently', () => {
    const { state } = run(focusOn('db'), [{ key: RESET }, { key: QUIT }]);
    expect(state.pending.map((p) => p.kind).sort()).toEqual(['quit', 'reset-infra']);
    const confirmed = run(state, [{ key: QUIT }]);
    expect(confirmed.state.pending.map((p) => p.kind)).toEqual(['reset-infra']);
    // A click elsewhere disarms both.
    const away = run(state, [{ click: null }]);
    expect(away.state.pending).toEqual([]);
    expect(away.effects.filter((e) => e.type === 'disarm')).toHaveLength(2);
  });
});

describe('the [reset] button in every mode', () => {
  const button: Action = { type: 'reset-infra', target: 'db' };
  // Armed on db, then the focus moved to web.
  const armed = run(focusOn('db'), [
    { key: RESET },
    { key: { type: 'focus-index', index: 1 } },
  ]).state;
  const confirmed: Effect[] = [
    { type: 'disarm', kind: 'reset-infra', target: 'db' },
    { type: 'reset-infra', target: 'db' },
  ];

  test('in normal mode it resets the armed entry', () => {
    const { state, effects } = run(armed, [{ click: button }]);
    expect(effects).toEqual(confirmed);
    expect(state.pending).toEqual([]);
  });

  test('with the commands menu open it resets, and the menu stays open', () => {
    const inMenu = run(armed, [{ key: { type: 'open-commands' } }]).state;
    expect(inMenu.mode).toBe('commands');
    const { state, effects } = run(inMenu, [{ click: button }]);
    expect(effects).toEqual(confirmed);
    expect(state).toMatchObject({ mode: 'commands', menu: inMenu.menu, pending: [] });
  });

  test('in filter mode it resets, and the input keeps the typing', () => {
    const typing = run(armed, [
      { key: { type: 'open-filter' } },
      { key: { type: 'filter-input', text: 'err' } },
    ]).state;
    const { state, effects } = run(typing, [{ click: button }]);
    expect(effects).toEqual(confirmed);
    expect(state).toMatchObject({ mode: 'filter', filterDraft: 'err', pending: [] });
  });

  test('once its confirmation has expired it neither resets nor arms', () => {
    const late = run(armed, [{ click: button }], { at: RESET_CONFIRM_MS });
    expect(late.effects).toEqual([{ type: 'disarm', kind: 'reset-infra', target: 'db' }]);
    expect(late.state.pending).toEqual([]);
    const gone = run(late.state, [{ click: button }], { at: RESET_CONFIRM_MS });
    expect(gone).toEqual({ state: late.state, effects: [] });
  });
});

describe('clicks in filter mode', () => {
  const typing = run(initialUiState, [
    { key: { type: 'open-filter' } },
    { key: { type: 'filter-input', text: 'err' } },
  ]).state;

  test('the jump row still does its action', () => {
    const cases: [Action, Effect][] = [
      [{ type: 'scroll-newest' }, { type: 'scroll', to: 'newest' }],
    ];
    for (const [click, effect] of cases) {
      const { state, effects } = run(typing, [{ click }]);
      expect(effects, click.type).toEqual([effect]);
      expect(state).toEqual(typing);
    }
  });

  test('they disarm a confirmation, like any click that is not its own', () => {
    const armed = run(typing, [{ key: QUIT }]).state;
    const { state, effects } = run(armed, [{ click: { type: 'scroll-newest' } }]);
    expect(effects).toEqual([
      { type: 'disarm', kind: 'quit' },
      { type: 'scroll', to: 'newest' },
    ]);
    expect(state.pending).toEqual([]);
  });

  test('every other click only disarms', () => {
    const armed = run(typing, [{ key: QUIT }]).state;
    for (const click of [
      null,
      { type: 'focus-index', index: 1 },
      { type: 'restart' },
      { type: 'scroll-page-older' },
    ] as const) {
      const { state, effects } = run(armed, [{ click }]);
      expect(effects, JSON.stringify(click)).toEqual([{ type: 'disarm', kind: 'quit' }]);
      expect(state).toEqual(typing);
    }
  });

  test('with the menu open, the same clicks close the menu instead', () => {
    const inMenu = run(focusOn('api'), [{ key: { type: 'open-commands' } }]).state;
    const click = { type: 'scroll-newest' } as const;
    const { state, effects } = run(inMenu, [{ click }]);
    expect(effects).toEqual([]);
    expect(state).toMatchObject({ mode: 'normal', menu: null });
  });
});

describe('the Esc chain', () => {
  const ESC: Action = { type: 'escape' };
  const filtered: UiState = { ...initialUiState, filter: 'error', filterDraft: 'error' };

  test('clears the selection first, then the newest sticky toast, then the filter, one per press', () => {
    const all = context({ hasSelection: true, hasStickyToast: true });
    expect(run(filtered, [{ key: ESC }], { ctx: all })).toEqual({
      state: filtered,
      effects: [{ type: 'clear-selection' }],
    });
    const sticky = context({ hasStickyToast: true });
    expect(run(filtered, [{ key: ESC }], { ctx: sticky }).effects).toEqual([
      { type: 'dismiss-sticky-toast' },
    ]);
    const last = run(filtered, [{ key: ESC }]);
    expect(last.effects).toEqual([{ type: 'filter', filter: '' }]);
    expect(last.state.filter).toBe('');
    expect(run(last.state, [{ key: ESC }]).effects).toEqual([]);
  });

  test('a click on esc clear filter runs the same chain', () => {
    const hint = hintsFor(keyContext(filtered, context())).find((h) => h.key === 'esc')!;
    expect(run(filtered, [{ click: hint.action }]).effects).toEqual([
      { type: 'filter', filter: '' },
    ]);
  });
});

describe('filter mode', () => {
  const type = (text: string): Action => ({ type: 'filter-input', text });

  test('opens with the applied terms, applies the trimmed input, and toasts only a change', () => {
    const typed = run(initialUiState, [
      { key: { type: 'open-filter' } },
      { key: type('  error ') },
      { key: type('x') },
      { key: { type: 'filter-backspace' } },
      { key: { type: 'apply-filter' } },
    ]);
    expect(typed.state).toMatchObject({ mode: 'normal', filter: 'error', filterDraft: 'error' });
    expect(typed.effects).toEqual([{ type: 'filter', filter: 'error' }]);

    const reopened = run(typed.state, [{ key: { type: 'open-filter' } }]).state;
    expect(reopened).toMatchObject({ mode: 'filter', filterDraft: 'error' });
    expect(run(reopened, [{ key: { type: 'apply-filter' } }]).effects).toEqual([]);
  });

  test('Enter on an empty input clears, and Esc clears and leaves', () => {
    const filtered: UiState = { ...initialUiState, filter: 'error', filterDraft: 'error' };
    const emptied = run(filtered, [
      { key: { type: 'open-filter' } },
      ...Array.from({ length: 5 }, () => ({ key: { type: 'filter-backspace' } as Action })),
      { key: { type: 'apply-filter' } },
    ]);
    expect(emptied.state).toMatchObject({ mode: 'normal', filter: '' });
    expect(emptied.effects).toEqual([{ type: 'filter', filter: '' }]);

    const escaped = run(filtered, [
      { key: { type: 'open-filter' } },
      { key: type('s') },
      { key: { type: 'clear-filter' } },
    ]);
    expect(escaped.state).toMatchObject({ mode: 'normal', filter: '', filterDraft: '' });
    expect(escaped.effects).toEqual([{ type: 'filter', filter: '' }]);
    // Nothing filtered: Esc leaves without a toast.
    expect(
      run(initialUiState, [{ key: { type: 'open-filter' } }, { key: { type: 'clear-filter' } }])
        .effects,
    ).toEqual([]);
  });

  test('a key action of another mode does nothing in filter mode: c types, clear-log is gated', () => {
    const typing = run(initialUiState, [
      { key: { type: 'open-filter' } },
      { key: type('err') },
    ]).state;
    // The key gate, not the table: an action from normal mode reaching filter mode is dropped.
    const gated = run(typing, [{ key: { type: 'clear-log' } }]);
    expect(gated.state).toBe(typing);
    expect(gated.effects).toEqual([]);
    // And the table never resolves `c` to it there: it is typed.
    const kc = keyContext(typing, context());
    expect(resolveKey(kc, 'c', {})).toEqual({ type: 'filter-input', text: 'c' });
  });

  test('a click on anything but its own hints is ignored, and the input keeps the typing', () => {
    const typing = run(initialUiState, [
      { key: { type: 'open-filter' } },
      { key: type('err') },
    ]).state;
    for (const click of [null, { type: 'focus-index', index: 1 }, { type: 'clear-log' }] as const) {
      const after = run(typing, [{ click }]);
      expect(after.state).toEqual(typing);
      expect(after.effects).toEqual([]);
    }
    expect(run(typing, [{ click: { type: 'apply-filter' } }]).state.filter).toBe('err');
  });
});

describe('focus', () => {
  test('nothing is focused until the session runs, then the first entry', () => {
    expect(focusIndex(initialUiState, context({ phase: 'starting' }))).toBeNull();
    expect(focusIndex(initialUiState, context({ phase: 'failed' }))).toBeNull();
    expect(focusIndex(initialUiState, context({ entries: [] }))).toBeNull();
    expect(focusIndex(initialUiState, context())).toBe(0);
    const starting = context({ phase: 'starting' });
    for (const action of [{ type: 'focus-next' }, { type: 'focus-index', index: 2 }] as const) {
      expect(
        run(initialUiState, [{ key: action }, { click: action }], { ctx: starting }).state,
      ).toEqual(initialUiState);
    }
  });

  test('← and → wrap over app services then infra entries', () => {
    const ctx = context();
    const prev = run(initialUiState, [{ key: { type: 'focus-prev' } }]).state;
    expect(focusIndex(prev, ctx)).toBe(3);
    const next = run(prev, [
      { key: { type: 'focus-next' } },
      { key: { type: 'focus-next' } },
    ]).state;
    expect(focusIndex(next, ctx)).toBe(1);
  });

  test('↑ and ↓ move between wrapped rows through verticalTarget', () => {
    const ctx = context();
    // A row's first entry counts as starting where the rows start, so db sits under api.
    expect(focusIndex(run(focusOn('api'), [{ key: { type: 'focus-down' } }]).state, ctx)).toBe(2);
    expect(focusIndex(run(focusOn('web'), [{ key: { type: 'focus-down' } }]).state, ctx)).toBe(3);
    expect(focusIndex(run(focusOn('mail'), [{ key: { type: 'focus-up' } }]).state, ctx)).toBe(1);
    const oneRow = context({ rects: ENTRIES.map((_, i) => ({ col: 2 + 8 * i, row: 1 })) });
    expect(
      focusIndex(
        run(focusOn('web'), [{ key: { type: 'focus-down' } }], { ctx: oneRow }).state,
        oneRow,
      ),
    ).toBe(1);
  });

  test('a click on an entry focuses it, app service or infra', () => {
    const ctx = context();
    expect(
      focusIndex(run(initialUiState, [{ click: { type: 'focus-index', index: 2 } }]).state, ctx),
    ).toBe(2);
    expect(
      focusIndex(run(initialUiState, [{ click: { type: 'focus-index', index: 1 } }]).state, ctx),
    ).toBe(1);
  });

  test('the focus stays on its entry when an app service is added before the infra group', () => {
    const onDb = focusOn('db');
    const grown = context({
      entries: [
        ...ENTRIES.slice(0, 2),
        { kind: 'app', name: 'worker', state: 'pending' },
        ...ENTRIES.slice(2),
      ],
    });
    expect(focusIndex(onDb, grown)).toBe(3);
  });

  test('a focused entry that is gone falls back to the first, and Esc still closes the menu', () => {
    const inMenu = run(focusOn('web'), [{ key: { type: 'open-commands' } }]).state;
    const infraOnly = context({ entries: ENTRIES.slice(2) });
    expect(focusIndex(inMenu, infraOnly)).toBe(0);
    expect(run(inMenu, [{ key: { type: 'close-menu' } }], { ctx: infraOnly }).state).toMatchObject({
      mode: 'normal',
      menu: null,
    });
  });
});

describe('starting up', () => {
  const starting = context({
    phase: 'starting',
    entries: ENTRIES.map(
      (e) => ({ ...e, state: e.kind === 'app' ? 'pending' : 'starting' }) as Entry,
    ),
  });

  test('the key context names the entry focused once the session runs', () => {
    expect(keyContext(initialUiState, starting).focused).toMatchObject({
      kind: 'app',
      name: 'api',
    });
    expect(keyContext(focusOn('db'), starting).focused).toMatchObject({
      kind: 'infra',
      name: 'db',
    });
  });

  test('its keys do nothing until then', () => {
    const actions: Action[] = [
      { type: 'focus-next' },
      { type: 'restart' },
      { type: 'stop-start' },
      { type: 'open-commands' },
    ];
    for (const action of actions) {
      for (const event of [{ key: action }, { click: action }]) {
        const { state, effects } = run(initialUiState, [event], { ctx: starting });
        expect(effects, action.type).toEqual([]);
        expect(state, action.type).toEqual(initialUiState);
      }
    }
  });
});

describe('service actions', () => {
  const withState = (name: string, state: Entry['state']) =>
    context({ entries: ENTRIES.map((e) => (e.name === name ? ({ ...e, state } as Entry) : e)) });

  test('restart acts only on an active app service or an up, idle infra entry', () => {
    expect(run(focusOn('api'), [{ key: { type: 'restart' } }]).effects).toEqual([
      { type: 'restart', entry: { kind: 'app', name: 'api' } },
    ]);
    for (const state of ['stopped', 'crashed', 'waiting', 'pending'] as const) {
      expect(
        run(focusOn('api'), [{ key: { type: 'restart' } }], { ctx: withState('api', state) })
          .effects,
      ).toEqual([]);
    }
    for (const state of ['stopped', 'stopping', 'resetting'] as const) {
      expect(
        run(focusOn('db'), [{ key: { type: 'restart' } }], { ctx: withState('db', state) }).effects,
      ).toEqual([]);
    }
  });

  test('s stops an active service and starts any other but a waiting one; an infra entry not while busy', () => {
    const ss: Action = { type: 'stop-start' };
    expect(run(focusOn('api'), [{ key: ss }]).effects).toEqual([
      { type: 'stop', entry: { kind: 'app', name: 'api' } },
    ]);
    for (const state of ['stopped', 'crashed', 'pending'] as const) {
      expect(
        run(focusOn('api'), [{ key: ss }], { ctx: withState('api', state) }).effects,
        state,
      ).toEqual([{ type: 'start', entry: { kind: 'app', name: 'api' } }]);
    }
    // It waits for its deps, and starts once they're ready.
    expect(
      run(focusOn('api'), [{ key: ss }], { ctx: withState('api', 'waiting') }).effects,
    ).toEqual([]);
    expect(run(focusOn('db'), [{ key: ss }], { ctx: withState('db', 'stopped') }).effects).toEqual([
      { type: 'start', entry: { kind: 'infra', name: 'db' } },
    ]);
    expect(run(focusOn('db'), [{ key: ss }], { ctx: withState('db', 'stopping') }).effects).toEqual(
      [],
    );
  });

  test('a dimmed hint dispatches its action, which does nothing', () => {
    const ctx = withState('api', 'stopped');
    const restart = hintsFor(keyContext(focusOn('api'), ctx)).find((h) => h.key === 'r')!;
    expect(restart.disabled).toBe(true);
    expect(run(focusOn('api'), [{ click: restart.action }], { ctx }).effects).toEqual([]);
  });
});

describe('the commands menu', () => {
  const open = (name = 'web') => run(focusOn(name), [{ key: { type: 'open-commands' } }]).state;

  test('opens on an app service with the first row highlighted, never on infra', () => {
    expect(open()).toMatchObject({ mode: 'commands', menu: { selected: 0, custom: '' } });
    expect(run(focusOn('db'), [{ key: { type: 'open-commands' } }]).state.mode).toBe('normal');
  });

  test('↑ and ↓ wrap over the scripts and the custom row', () => {
    const up = run(open(), [{ key: { type: 'menu-move', delta: -1 } }]).state;
    expect(up.menu?.selected).toBe(2);
    expect(keyContext(up, context()).menu?.customSelected).toBe(true);
    expect(run(up, [{ key: { type: 'menu-move', delta: 1 } }]).state.menu?.selected).toBe(0);
  });

  test('← and → switch over app services only, the focus following, the menu reset', () => {
    const typed = run(open(), [{ key: { type: 'menu-move', delta: 1 } }]).state;
    const next = run(typed, [{ key: { type: 'menu-service', delta: 1 } }]).state;
    expect(next.focus).toEqual({ kind: 'app', name: 'api' });
    expect(next.menu).toEqual({ selected: 0, custom: '' });
    const prev = run(next, [{ key: { type: 'menu-service', delta: -1 } }]).state;
    expect(prev.focus).toEqual({ kind: 'app', name: 'web' });
  });

  test('switching service is blocked while the custom command has text', () => {
    const typing = run(open(), [
      { key: { type: 'custom-command' } },
      { key: { type: 'custom-input', text: 'echo hi' } },
    ]).state;
    expect(run(typing, [{ key: { type: 'menu-service', delta: 1 } }]).state).toEqual(typing);
  });

  test('Enter runs the highlighted script and closes the menu', () => {
    const { state, effects } = run(open(), [
      { key: { type: 'menu-move', delta: 1 } },
      { key: { type: 'run-command' } },
    ]);
    expect(effects).toEqual([{ type: 'run-script', service: 'web', script: 'preview' }]);
    expect(state).toMatchObject({
      mode: 'normal',
      menu: null,
      focus: { kind: 'app', name: 'web' },
    });
  });

  test('a click on a script runs it', () => {
    expect(run(open(), [{ click: { type: 'run-command', row: 0 } }]).effects).toEqual([
      { type: 'run-script', service: 'web', script: 'build' },
    ]);
  });

  test('the custom command runs trimmed; empty, Enter only closes', () => {
    const custom = run(open(), [{ click: { type: 'custom-command' } }]).state;
    expect(custom.menu?.selected).toBe(2);
    const ran = run(custom, [
      { key: { type: 'custom-input', text: ' echo hix ' } },
      { key: { type: 'custom-backspace' } },
      { key: { type: 'custom-backspace' } },
      { key: { type: 'run-command' } },
    ]);
    expect(ran.effects).toEqual([{ type: 'run-custom', service: 'web', command: 'echo hi' }]);
    const empty = run(custom, [{ key: { type: 'run-command' } }]);
    expect(empty.effects).toEqual([]);
    expect(empty.state.mode).toBe('normal');
  });

  test('typing reaches the custom command only while its row is selected', () => {
    const menu = open();
    expect(run(menu, [{ key: { type: 'custom-input', text: 'x' } }]).state).toEqual(menu);
  });

  test('Esc closes the menu and discards the custom command', () => {
    const typing = run(open(), [
      { key: { type: 'custom-command' } },
      { key: { type: 'custom-input', text: 'ls' } },
    ]).state;
    const closed = run(typing, [{ key: { type: 'close-menu' } }]);
    expect(closed.state).toMatchObject({ mode: 'normal', menu: null });
    expect(run(closed.state, [{ key: { type: 'open-commands' } }]).state.menu).toEqual({
      selected: 0,
      custom: '',
    });
  });

  test('a click outside the menu closes it and is consumed', () => {
    for (const click of [
      null,
      { type: 'focus-index', index: 2 },
      { type: 'clear-log' },
      { type: 'scroll-newest' },
    ] as const) {
      const { state, effects } = run(open(), [{ click }]);
      expect(state, JSON.stringify(click)).toMatchObject({
        mode: 'normal',
        menu: null,
        focus: { kind: 'app', name: 'web' },
      });
      expect(effects).toEqual([]);
    }
  });

  test('a click on ↑ ↓ choose moves the highlight down one row', () => {
    const hint = hintsFor(keyContext(open(), context()), 'menu').find((h) => h.key === '↑ ↓')!;
    expect(run(open(), [{ click: hint.action }]).state.menu?.selected).toBe(1);
  });
});

describe('the reducer', () => {
  test('an event that does nothing returns the same state and no effects', () => {
    const armed = run(initialUiState, [{ key: QUIT }]).state;
    const next = step(armed, { type: 'expire', at: 1 });
    expect(next.state).toBe(armed);
    expect(next.effects).toEqual([]);
  });

  test('while shutting down, every key action but quit does nothing', () => {
    const ctx = context({ phase: 'stopping' });
    const actions: Action[] = [
      { type: 'clear-log' },
      { type: 'open-filter' },
      { type: 'focus-next' },
    ];
    expect(
      run(
        focusOn('api'),
        actions.map((key) => ({ key })),
        { ctx },
      ),
    ).toEqual({
      state: focusOn('api'),
      effects: [],
    });
    expect(run(focusOn('api'), [{ key: QUIT }], { ctx }).effects).toEqual([{ type: 'shutdown' }]);
  });

  test('while shutting down, clicks do nothing', () => {
    const armed = run(initialUiState, [{ key: QUIT }]).state;
    const ctx = context({ phase: 'stopping' });
    expect(
      run(armed, [{ click: null }, { click: { type: 'focus-index', index: 1 } }], { ctx }),
    ).toEqual({
      state: armed,
      effects: [],
    });
  });

  test('a key resolved from the table drives the reducer end to end', () => {
    const ctx = context();
    let state = focusOn('db');
    const press = (input: string, key = {}) => {
      const action = resolveKey(keyContext(state, ctx), input, key)!;
      const next = step(state, { type: 'key', action, at: 0, ctx });
      state = next.state;
      return next.effects;
    };
    expect(press('R', { shift: true })).toEqual([
      { type: 'arm', kind: 'reset-infra', target: 'db', ms: RESET_CONFIRM_MS },
    ]);
    expect(press('c')).toEqual([{ type: 'clear-log' }]);
    expect(press('R', { shift: true }).at(-1)).toEqual({ type: 'reset-infra', target: 'db' });
  });
});
