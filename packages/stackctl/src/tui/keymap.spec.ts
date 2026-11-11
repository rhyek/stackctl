import { describe, expect, test } from 'vitest';
import type { SessionInfraState } from '../session/session.js';
import type { ServiceState } from '../session/supervisor.js';
import {
  type Action,
  type Entry,
  type Hint,
  type KeyContext,
  type KeyFlags,
  type Mode,
  type Phase,
  KEY_TABLE,
  hintsFor,
  resolveKey,
} from './keymap.js';

const APP_STATES: ServiceState[] = [
  'pending',
  'waiting',
  'starting',
  'running',
  'restarting',
  'stopped',
  'crashed',
];
const INFRA_STATES: SessionInfraState[] = [
  'pending',
  'starting',
  'running',
  'stopped',
  'stopping',
  'restarting',
  'resetting',
  'failed',
];
const MODES: Mode[] = ['normal', 'filter', 'commands'];
const PHASES: Phase[] = ['starting', 'running', 'failed', 'stopping'];

function ctx(over: Partial<KeyContext> = {}): KeyContext {
  return { mode: 'normal', phase: 'running', focused: null, filter: '', menu: null, ...over };
}

const appFocused = (state: ServiceState = 'running'): Entry => ({
  kind: 'app',
  name: 'api',
  state,
});
const infraFocused = (state: SessionInfraState = 'running'): Entry => ({
  kind: 'infra',
  name: 'db',
  state,
});

/** Every context the screen can be in, as far as the key table can tell them apart. */
function allContexts(): KeyContext[] {
  const focuses: (Entry | null)[] = [
    null,
    ...APP_STATES.map((s) => appFocused(s)),
    ...INFRA_STATES.map((s) => infraFocused(s)),
  ];
  const menus: KeyContext['menu'][] = [];
  for (const customSelected of [false, true]) {
    for (const customText of ['', 'echo hi']) {
      for (const appServices of [1, 3]) {
        menus.push({ customSelected, customText, appServices });
      }
    }
  }
  const out: KeyContext[] = [];
  for (const mode of MODES) {
    for (const phase of PHASES) {
      for (const focused of focuses) {
        for (const filter of ['', 'error api']) {
          for (const menu of mode === 'commands' ? menus : [null]) {
            out.push({ mode, phase, focused, filter, menu });
          }
        }
      }
    }
  }
  return out;
}

/** The press a hint's drawn key stands for: what a user reading the row would type. */
function pressFor(hintKey: string): [string, KeyFlags] {
  switch (hintKey) {
    case '^c':
      return ['c', { ctrl: true }];
    case 'esc':
      return ['', { escape: true }];
    case '⏎':
      return ['\r', { return: true }];
    case '↑↓':
      return ['', { downArrow: true }];
    case '←→':
      return ['', { rightArrow: true }];
  }
  expect(hintKey).toHaveLength(1);
  return [hintKey, { shift: /[A-Z]/.test(hintKey) }];
}

/** Every press worth trying: each printable ASCII character, Ctrl+letter, each named key, a paste. */
function allPresses(): [string, KeyFlags][] {
  const presses: [string, KeyFlags][] = [];
  for (let code = 0x20; code < 0x7f; code++) {
    const ch = String.fromCharCode(code);
    presses.push([ch, { shift: /[A-Z]/.test(ch) }]);
  }
  for (let code = 0x61; code <= 0x7a; code++) {
    presses.push([String.fromCharCode(code), { ctrl: true }]);
  }
  const named: (keyof KeyFlags)[] = [
    'upArrow',
    'downArrow',
    'leftArrow',
    'rightArrow',
    'pageUp',
    'pageDown',
    'home',
    'end',
    'return',
    'escape',
    'tab',
    'backspace',
    'delete',
  ];
  for (const flag of named) {
    presses.push([flag === 'return' ? '\r' : flag === 'tab' ? '\t' : '', { [flag]: true }]);
  }
  presses.push(['error\napi', {}]);
  return presses;
}

/** A row as drawn: `  ` then hints 3 cells apart, groups split by `  │  ` (run-screen §2.11.1). */
function keysRow(hints: Hint[]): string {
  const groups: string[][] = [];
  let last: number | undefined;
  for (const h of hints) {
    const text = [h.key, h.label, h.detail].filter((s) => s !== undefined).join(' ');
    if (h.group !== last) {
      groups.push([]);
      last = h.group;
    }
    groups.at(-1)!.push(text);
  }
  return `  ${groups.map((g) => g.join('   ')).join('  │  ')}`;
}

function menuRow(hints: Hint[]): string {
  return hints.map((h) => `${h.key} ${h.label}`).join('  ');
}

/** The actions that may have a key but no hint, per mode (run-screen §3.4.7, §4.2.2, §5.3.1). */
const HIDDEN: Record<Mode, (a: Action) => boolean> = {
  normal: (a) =>
    [
      'focus-prev',
      'focus-next',
      'focus-up',
      'focus-down',
      'scroll-page-older',
      'scroll-page-newer',
      'scroll-oldest',
      'scroll-newest',
      // Esc with nothing filtered: the chain still clears a selection or a sticky toast.
      'escape',
    ].includes(a.type),
  // The filter row has no room for `^c quit`.
  filter: (a) => ['filter-input', 'filter-backspace', 'quit'].includes(a.type),
  // ↑ and ← are drawn as the `↑↓` and `←→` hints, whose clicks go down and right.
  commands: (a) =>
    (a.type === 'menu-move' && a.delta === -1) ||
    (a.type === 'menu-service' && a.delta === -1) ||
    a.type === 'custom-input' ||
    a.type === 'custom-backspace',
};

describe('the key table', () => {
  test('every hint resolves to the action its key resolves to', () => {
    for (const c of allContexts()) {
      for (const hint of [...hintsFor(c), ...hintsFor(c, 'menu')]) {
        const [input, key] = pressFor(hint.key);
        expect(
          resolveKey(c, input, key),
          `${hint.key} ${hint.label} in ${JSON.stringify(c)}`,
        ).toEqual(hint.action);
      }
    }
  });

  test('no key in a context resolves without a hint, except navigation and the documented hidden keys', () => {
    for (const c of allContexts()) {
      const hinted = [...hintsFor(c), ...hintsFor(c, 'menu')].map((h) => h.action);
      for (const [input, key] of allPresses()) {
        const action = resolveKey(c, input, key);
        if (action === null || hinted.some((a) => JSON.stringify(a) === JSON.stringify(action))) {
          continue;
        }
        expect(
          HIDDEN[c.mode](action),
          `${JSON.stringify([input, key])} → ${action.type} in ${JSON.stringify(c)}`,
        ).toBe(true);
      }
    }
  });

  test('hints are drawn in group order', () => {
    for (const c of allContexts()) {
      const groups = hintsFor(c).map((h) => h.group);
      expect(groups).toEqual([...groups].sort((a, b) => a - b));
    }
  });

  test('every binding with a hint has a fixed action, so a click can dispatch it', () => {
    const hinted = KEY_TABLE.filter((b) => b.hint);
    expect(hinted.map((b) => typeof b.action)).toEqual(hinted.map(() => 'object'));
  });
});

describe('the keys row', () => {
  test('an app service focused, running: spec mockup 1', () => {
    expect(keysRow(hintsFor(ctx({ focused: appFocused() })))).toBe(
      '  ←→ select   r restart   s stop   m commands  │  f filter   c clear  │  ^c quit',
    );
  });

  test('an infra entry focused: spec mockup 2', () => {
    expect(keysRow(hintsFor(ctx({ focused: infraFocused() })))).toBe(
      '  ←→ select   r restart   s stop   R reset data  │  f filter   c clear  │  ^c quit',
    );
  });

  test('starting up and after a startup failure: spec mockup 3', () => {
    for (const phase of ['starting', 'failed'] as const) {
      expect(keysRow(hintsFor(ctx({ phase })))).toBe('  f filter   c clear  │  ^c quit');
      expect(resolveKey(ctx({ phase }), 't', {})).toBeNull();
    }
  });

  test('running with no entries shows the log keys and quit', () => {
    expect(keysRow(hintsFor(ctx()))).toBe('  f filter   c clear  │  ^c quit');
  });

  test('t is no key, in any state', () => {
    for (const focused of [null, appFocused(), infraFocused()]) {
      expect(resolveKey(ctx({ focused }), 't', {})).toBeNull();
      expect(hintsFor(ctx({ focused })).some((h) => h.key === 't')).toBe(false);
    }
  });

  test('an applied filter shows its terms on f and adds esc clear filter', () => {
    const hints = hintsFor(ctx({ focused: appFocused(), filter: 'error api' }));
    expect(keysRow(hints)).toBe(
      '  ←→ select   r restart   s stop   m commands  │  f filter: error api   esc clear filter   c clear  │  ^c quit',
    );
    expect(hints.find((h) => h.key === 'f')).toMatchObject({
      label: 'filter:',
      detail: 'error api',
    });
    expect(resolveKey(ctx({ filter: 'error api' }), '', { escape: true })).toEqual({
      type: 'escape',
    });
  });

  test('s reads start on an app service that is not active, and stop on an active one', () => {
    for (const state of APP_STATES) {
      const s = hintsFor(ctx({ focused: appFocused(state) })).find((h) => h.key === 's')!;
      const active = state === 'running' || state === 'starting' || state === 'restarting';
      expect(s.label, state).toBe(active ? 'stop' : 'start');
    }
  });

  test('hints that cannot act are still generated, flagged disabled', () => {
    const appHints = (state: ServiceState) => hintsFor(ctx({ focused: appFocused(state) }));
    expect(appHints('stopped').find((h) => h.key === 'r')).toMatchObject({
      label: 'restart',
      disabled: true,
      action: { type: 'restart' },
    });
    expect(appHints('running').find((h) => h.key === 'r')?.disabled).toBe(false);

    const infraHints = (state: SessionInfraState) =>
      hintsFor(ctx({ focused: infraFocused(state) }));
    // Down: only restart can't act.
    expect(
      infraHints('stopped')
        .filter((h) => h.group === 1)
        .map((h) => [h.key, h.label, h.disabled]),
    ).toEqual([
      ['←→', 'select', false],
      ['r', 'restart', true],
      ['s', 'start', false],
      ['R', 'reset data', false],
    ]);
    // Busy: every infra action's hint is dim, and none drops out.
    for (const state of ['stopping', 'restarting', 'resetting'] as const) {
      const group1 = infraHints(state).filter((h) => h.group === 1);
      expect(
        group1.map((h) => h.key),
        state,
      ).toEqual(['←→', 'r', 's', 'R']);
      // Every action on it is dim; ←→ still moves the selection.
      expect(
        group1.filter((h) => h.key !== '←→').every((h) => h.disabled),
        state,
      ).toBe(true);
    }
    // The log and session groups never dim.
    expect(
      infraHints('resetting')
        .filter((h) => h.group !== 1)
        .some((h) => h.disabled),
    ).toBe(false);
  });

  test('R is reset when infra is focused', () => {
    const c = ctx({ focused: infraFocused() });
    expect(resolveKey(c, 'R', { shift: true })).toEqual({ type: 'reset-infra' });
    expect(resolveKey(c, 'r', {})).toEqual({ type: 'restart' });
    expect(resolveKey(c, 'm', {})).toBeNull();
    const hints = hintsFor(c);
    expect(hints.find((h) => h.key === 'R')?.label).toBe('reset data');
  });

  test('R does nothing and has no hint with an app service focused', () => {
    const c = ctx({ focused: appFocused() });
    expect(resolveKey(c, 'R', { shift: true })).toBeNull();
    expect(hintsFor(c).some((h) => h.key === 'R')).toBe(false);
  });

  test('arrows focus nothing until an entry is focused', () => {
    for (const phase of ['starting', 'failed'] as const) {
      expect(resolveKey(ctx({ phase }), '', { leftArrow: true })).toBeNull();
      expect(resolveKey(ctx({ phase }), '', { downArrow: true })).toBeNull();
    }
    const c = ctx({ focused: appFocused() });
    expect(resolveKey(c, '', { leftArrow: true })).toEqual({ type: 'focus-prev' });
    expect(resolveKey(c, '', { rightArrow: true })).toEqual({ type: 'focus-next' });
    expect(resolveKey(c, '', { upArrow: true })).toEqual({ type: 'focus-up' });
    expect(resolveKey(c, '', { downArrow: true })).toEqual({ type: 'focus-down' });
  });

  test('PageUp, PageDown, Home and End scroll, with no hint', () => {
    const c = ctx({ phase: 'starting' });
    expect(resolveKey(c, '', { pageUp: true })).toEqual({ type: 'scroll-page-older' });
    expect(resolveKey(c, '', { pageDown: true })).toEqual({ type: 'scroll-page-newer' });
    expect(resolveKey(c, '', { home: true })).toEqual({ type: 'scroll-oldest' });
    expect(resolveKey(c, '', { end: true })).toEqual({ type: 'scroll-newest' });
  });

  test('Esc runs the chain, hidden while nothing is filtered', () => {
    const c = ctx({ focused: appFocused() });
    expect(resolveKey(c, '', { escape: true })).toEqual({ type: 'escape' });
    expect(hintsFor(c).some((h) => h.key === 'esc')).toBe(false);
  });

  test('a Ctrl or Meta chord is not its letter', () => {
    const c = ctx({ focused: appFocused() });
    expect(resolveKey(c, 'r', { ctrl: true })).toBeNull();
    expect(resolveKey(c, 'r', { meta: true })).toBeNull();
    expect(resolveKey(c, '\t', { tab: true })).toBeNull();
    expect(resolveKey(c, 'q', {})).toBeNull();
  });

  test('while shutting down, only Ctrl+C resolves', () => {
    for (const mode of MODES) {
      const c = ctx({
        mode,
        phase: 'stopping',
        focused: appFocused(),
        menu: mode === 'commands' ? { customSelected: true, customText: '', appServices: 2 } : null,
      });
      expect(resolveKey(c, 'c', { ctrl: true })).toEqual({ type: 'quit' });
      const others = allPresses().filter(([input, key]) => !(key.ctrl && input === 'c'));
      expect(others.map(([input, key]) => resolveKey(c, input, key))).toEqual(
        others.map(() => null),
      );
    }
  });
});

describe('filter mode', () => {
  const c = ctx({ mode: 'filter', focused: appFocused() });

  test('its row is ⏎ apply and esc clear, with no ^c quit', () => {
    expect(keysRow(hintsFor(c))).toBe('  ⏎ apply   esc clear');
    expect(resolveKey(c, 'c', { ctrl: true })).toEqual({ type: 'quit' });
  });

  test('every printable key types, and the row keys do their own thing', () => {
    expect(resolveKey(c, 'r', {})).toEqual({ type: 'filter-input', text: 'r' });
    expect(resolveKey(c, 'R', { shift: true })).toEqual({ type: 'filter-input', text: 'R' });
    expect(resolveKey(c, ' ', {})).toEqual({ type: 'filter-input', text: ' ' });
    expect(resolveKey(c, '', { backspace: true })).toEqual({ type: 'filter-backspace' });
    expect(resolveKey(c, '', { delete: true })).toEqual({ type: 'filter-backspace' });
    expect(resolveKey(c, '\r', { return: true })).toEqual({ type: 'apply-filter' });
    expect(resolveKey(c, '', { escape: true })).toEqual({ type: 'clear-filter' });
    expect(resolveKey(c, '', { leftArrow: true })).toBeNull();
    expect(resolveKey(c, '', { pageUp: true })).toBeNull();
  });

  test('a paste is typed whole, its line breaks dropped', () => {
    expect(resolveKey(c, 'error\r\napi', {})).toEqual({ type: 'filter-input', text: 'errorapi' });
  });
});

describe('commands mode', () => {
  const menu = (over: Partial<NonNullable<KeyContext['menu']>> = {}) =>
    ctx({
      mode: 'commands',
      focused: appFocused(),
      menu: { customSelected: false, customText: '', appServices: 3, ...over },
    });

  test('the footer offers only ^c quit', () => {
    expect(keysRow(hintsFor(menu()))).toBe('  ^c quit');
    expect(resolveKey(menu(), 'r', {})).toBeNull();
    expect(resolveKey(menu(), 'f', {})).toBeNull();
  });

  test('its own hint row, without ←→ service for one app service', () => {
    expect(menuRow(hintsFor(menu(), 'menu'))).toBe('↑↓ choose  ←→ service  ⏎ run  esc close');
    expect(menuRow(hintsFor(menu({ appServices: 1 }), 'menu'))).toBe('↑↓ choose  ⏎ run  esc close');
    expect(resolveKey(menu({ appServices: 1 }), '', { rightArrow: true })).toBeNull();
  });

  test('↑ and ← are the hidden halves of their hints', () => {
    expect(resolveKey(menu(), '', { upArrow: true })).toEqual({ type: 'menu-move', delta: -1 });
    expect(resolveKey(menu(), '', { downArrow: true })).toEqual({ type: 'menu-move', delta: 1 });
    expect(resolveKey(menu(), '', { leftArrow: true })).toEqual({
      type: 'menu-service',
      delta: -1,
    });
  });

  test('typing reaches the custom command only while its row is selected', () => {
    expect(resolveKey(menu(), 'x', {})).toBeNull();
    expect(resolveKey(menu(), '', { backspace: true })).toBeNull();
    const custom = menu({ customSelected: true });
    expect(resolveKey(custom, 'x', {})).toEqual({ type: 'custom-input', text: 'x' });
    expect(resolveKey(custom, '', { backspace: true })).toEqual({ type: 'custom-backspace' });
    expect(resolveKey(custom, '\r', { return: true })).toEqual({ type: 'run-command' });
  });
});
