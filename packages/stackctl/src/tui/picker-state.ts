import type { ToastTone } from '../toasts.js';
import { type KeyFlags, type KeySpec, matches, printableText } from './keymap.js';
import { joinNames, normalize } from './text-cells.js';

/**
 * The service picker's state and its reducer: the picks, the cursor, the filter and the scroll
 * window. Pure: it reads no clock and no config, and writes nothing. The services, their direct
 * deps and dependents, and the saved selection are given when the state is made; what an event
 * asks of the world comes back as {@link PickerEffect}s from {@link pickerStep}.
 */

/** A registered service, as the picker sees it. */
export interface PickerService {
  name: string;
  /** Direct deps, by name, in the config's order: what picking this service also runs. */
  deps: readonly string[];
  /** The registered services that list this one as a direct dep, in display order. */
  dependents: readonly string[];
  /**
   * Shown as a row: the config's `selectable` and startable (a dev command it can run). A service
   * without a row can't be picked, but it still runs when a pick pulls it in.
   */
  hasRow: boolean;
  /**
   * Started when the session launches (default `true`); `false` for `autostart: false` or no dev
   * command. Such a service still joins the session, left stopped: "will start" lists a pick as
   * `<name> (stopped)` and leaves a pulled-in one out.
   */
  launches?: boolean;
}

/** Everything the picker shows, as plain data. */
export interface PickerInput {
  /** Every registered service, in the order the rows appear: the most depended-on first. */
  services: readonly PickerService[];
  /** The infra services the session brings up, for the "will start" line. */
  infra: readonly string[];
  /** The last selection; names that are no longer rows are dropped. */
  saved: readonly string[];
  /** For the rule line; `branch` is `null` outside a git repository. */
  workspace: { name: string; branch: string | null };
}

export interface PickerState {
  services: readonly PickerService[];
  /** The picked names, in list order. */
  picked: readonly string[];
  /** The cursor's service; `null` with no visible row. */
  cursor: string | null;
  /** The applied filter's text; empty when nothing is filtered. */
  filter: string;
  /** What the filter input holds while it is open; `null` when it is closed. */
  input: string | null;
  /** The first visible row shown, as an index among the visible rows. */
  scroll: number;
  /** How many list rows fit, from the layout; the window keeps the cursor among them. */
  listRows: number;
}

/** Everything a key, a click or a hint can ask the picker to do. */
export type PickerAction =
  | { type: 'move'; delta: 1 | -1 }
  /** Toggles the cursor row. */
  | { type: 'toggle' }
  /** A click on a row: the cursor moves to it, then it toggles. */
  | { type: 'row'; name: string }
  | { type: 'open-filter' }
  | { type: 'clear-filter' }
  | { type: 'none' }
  | { type: 'start' }
  | { type: 'quit' }
  | { type: 'filter-input'; text: string }
  | { type: 'filter-backspace' }
  /** Closes the input, keeping its text as the applied filter. */
  | { type: 'filter-done' }
  /** Clears the text and closes the input. */
  | { type: 'filter-cancel' };

export type PickerEvent =
  | { type: 'key'; input: string; key: KeyFlags; at: number }
  /** A click on a target, or `action: null` for one on no target. */
  | { type: 'click'; action: PickerAction | null; at: number }
  /** One wheel notch: the cursor moves one row, without wrapping. */
  | { type: 'wheel'; delta: 1 | -1; at: number }
  /** The list's height changed: a terminal resize, or the bottom block wrapping differently. */
  | { type: 'resize'; listRows: number }
  /** Time has passed. The picker owns no timer, so nothing changes. */
  | { type: 'expire'; at: number };

/** What an event asks the picker's owner to carry out, in order. */
export type PickerEffect =
  | { type: 'toast'; text: string; tone: ToastTone }
  /** Save the picks as the last selection; always just before `start`. */
  | { type: 'save-selection'; names: string[] }
  | { type: 'start'; names: string[] }
  | { type: 'quit' };

export interface PickerStep {
  state: PickerState;
  effects: PickerEffect[];
}

/** The picker's state for `input`: the saved names that are rows picked, the cursor on the first. */
export function createPickerState(input: PickerInput): PickerState {
  const saved = new Set(input.saved);
  const rows = input.services.filter((s) => s.hasRow);
  return {
    services: input.services,
    picked: rows.filter((s) => saved.has(s.name)).map((s) => s.name),
    cursor: rows[0]?.name ?? null,
    filter: '',
    input: null,
    scroll: 0,
    listRows: Number.POSITIVE_INFINITY,
  };
}

// ---------------------------------------------------------------------------
// Derived views, shared with the layout
// ---------------------------------------------------------------------------

/** The services that have a row, in list order. */
export function rowsOf(state: PickerState): PickerService[] {
  return state.services.filter((s) => s.hasRow);
}

/** Whether `name` matches `filter`: every whitespace-separated term is a substring of it. */
function matchesFilter(name: string, filter: string): boolean {
  const terms = filter.split(/\s+/).filter(Boolean).map(normalize);
  const haystack = normalize(name);
  return terms.every((t) => haystack.includes(t));
}

/** The filter in effect: the input's text while it is open, the applied filter otherwise. */
function activeFilter(state: PickerState): string {
  return state.input ?? state.filter;
}

/** The rows the filter leaves, in list order. */
export function visibleRows(state: PickerState): PickerService[] {
  const filter = activeFilter(state);
  return rowsOf(state).filter((s) => matchesFilter(s.name, filter));
}

function serviceOf(state: PickerState, name: string): PickerService | undefined {
  return state.services.find((s) => s.name === name);
}

/** The picked services that list `name` as a direct dep, in list order. */
export function neededBy(state: PickerState, name: string): string[] {
  const dependents = new Set(serviceOf(state, name)?.dependents ?? []);
  return state.picked.filter((p) => dependents.has(p));
}

/** A row is locked while a picked service needs it, whether or not it is picked itself. */
export function isLocked(state: PickerState, name: string): boolean {
  return (serviceOf(state, name)?.hasRow ?? false) && neededBy(state, name).length > 0;
}

export function isPicked(state: PickerState, name: string): boolean {
  return state.picked.includes(name);
}

/** A "will start" entry; `stopped` for a pick that joins the session left stopped. */
export interface WillStart {
  name: string;
  stopped: boolean;
}

/**
 * What a selection runs, as the selection plan (`planSelection`'s `services`) gives it: each
 * service, and why it runs, `null` for a pick.
 */
export type SelectionRuns = readonly { name: string; why: string | null }[];

/**
 * What the session brings up: the picks in list order, then the deps they pull in, in list
 * order. A pick that doesn't launch is listed as stopped (S3-R6); a pulled-in one is left out.
 * Which services run comes from `runs` when given (the selection plan for `state.picked`), and
 * from the services' own `deps` otherwise.
 */
export function willStart(state: PickerState, runs?: SelectionRuns): WillStart[] {
  const picked = new Set(
    runs ? runs.filter((r) => r.why === null).map((r) => r.name) : state.picked,
  );
  const pulled = new Set(
    runs
      ? runs.filter((r) => r.why !== null).map((r) => r.name)
      : state.services.filter((s) => picked.has(s.name)).flatMap((s) => [...s.deps]),
  );
  const launches = (s: PickerService) => s.launches !== false;
  return [
    ...state.services
      .filter((s) => picked.has(s.name))
      .map((s) => ({ name: s.name, stopped: !launches(s) })),
    ...state.services
      .filter((s) => !picked.has(s.name) && pulled.has(s.name) && launches(s))
      .map((s) => ({ name: s.name, stopped: false })),
  ];
}

/**
 * The window's first row: moved only as far as needed to show the cursor, and never leaving
 * blank rows below the last one while rows are hidden above.
 */
export function windowTop(top: number, cursor: number, listRows: number, count: number): number {
  if (listRows <= 0) {
    return Math.max(0, Math.min(cursor, count - 1));
  }
  let next = Math.max(0, Math.min(top, count - listRows));
  if (cursor >= 0 && cursor < next) {
    next = cursor;
  } else if (cursor >= next + listRows) {
    next = cursor - listRows + 1;
  }
  return next;
}

// ---------------------------------------------------------------------------
// The key table
// ---------------------------------------------------------------------------

/** What the keyboard is driving: the list, or the filter input. */
export type PickerMode = 'list' | 'filter';

export function modeOf(state: PickerState): PickerMode {
  return state.input === null ? 'list' : 'filter';
}

interface PickerBinding {
  mode: PickerMode;
  when?: (state: PickerState) => boolean;
  key: KeySpec;
  hint?: { key: string; label: string; detail?: (state: PickerState) => string };
  /** The hint is drawn dim: its action does nothing in this state. */
  dim?: (state: PickerState) => boolean;
  action: PickerAction | ((text: string) => PickerAction);
}

/** A hint as a row draws it: `<key> <label>[ <detail>]`, dim when `disabled`. */
export interface PickerHint {
  key: string;
  label: string;
  detail?: string;
  group: number;
  disabled: boolean;
  /** What its key does, and what a click on it dispatches. */
  action: PickerAction;
}

const hasRows = (s: PickerState) => rowsOf(s).length > 0;
const filtered = (s: PickerState) => hasRows(s) && s.filter !== '';

/** The picker's keys, in the order the hints are drawn. The first binding that matches wins. */
const PICKER_KEYS: readonly PickerBinding[] = [
  {
    mode: 'list',
    when: hasRows,
    key: { char: ' ' },
    hint: { key: 'space', label: 'select' },
    dim: (s) => s.cursor === null,
    action: { type: 'toggle' },
  },
  {
    mode: 'list',
    when: hasRows,
    key: { named: 'down' },
    hint: { key: '↑ ↓', label: 'move' },
    action: { type: 'move', delta: 1 },
  },
  { mode: 'list', when: hasRows, key: { named: 'up' }, action: { type: 'move', delta: -1 } },
  {
    mode: 'list',
    when: (s) => hasRows(s) && !filtered(s),
    key: { char: '/' },
    hint: { key: '/', label: 'filter' },
    action: { type: 'open-filter' },
  },
  {
    mode: 'list',
    when: filtered,
    key: { char: '/' },
    hint: { key: '/', label: 'filter:', detail: (s) => s.filter },
    action: { type: 'open-filter' },
  },
  {
    mode: 'list',
    when: filtered,
    key: { named: 'escape' },
    hint: { key: 'esc', label: 'clear filter' },
    action: { type: 'clear-filter' },
  },
  {
    mode: 'list',
    when: hasRows,
    key: { char: 'n' },
    hint: { key: 'n', label: 'none' },
    action: { type: 'none' },
  },
  {
    mode: 'list',
    when: hasRows,
    key: { named: 'return' },
    hint: { key: '⏎', label: 'start' },
    dim: (s) => s.picked.length === 0,
    action: { type: 'start' },
  },
  {
    mode: 'list',
    key: { ctrl: 'c' },
    hint: { key: '^c', label: 'quit' },
    action: { type: 'quit' },
  },

  // The filter input: its row replaces the keys row.
  { mode: 'filter', key: { ctrl: 'c' }, action: { type: 'quit' } },
  {
    mode: 'filter',
    key: { named: 'return' },
    hint: { key: '⏎', label: 'done' },
    action: { type: 'filter-done' },
  },
  {
    mode: 'filter',
    key: { named: 'escape' },
    hint: { key: 'esc', label: 'clear' },
    action: { type: 'filter-cancel' },
  },
  { mode: 'filter', key: { named: 'backspace' }, action: { type: 'filter-backspace' } },
  { mode: 'filter', key: { named: 'down' }, action: { type: 'move', delta: 1 } },
  { mode: 'filter', key: { named: 'up' }, action: { type: 'move', delta: -1 } },
  {
    mode: 'filter',
    key: { printable: true },
    action: (text) => ({ type: 'filter-input', text }),
  },
];

function applies(binding: PickerBinding, state: PickerState): boolean {
  return binding.mode === modeOf(state) && (binding.when?.(state) ?? true);
}

/** The action a press resolves to in this state, or `null` when it does nothing. */
export function resolvePickerKey(
  state: PickerState,
  input: string,
  key: KeyFlags,
): PickerAction | null {
  for (const binding of PICKER_KEYS) {
    if (applies(binding, state) && matches(binding.key, input, key)) {
      return typeof binding.action === 'function'
        ? binding.action(printableText(input, key))
        : binding.action;
    }
  }
  return null;
}

/** The hints for this state, in drawing order: the keys row's, or the filter row's. */
export function pickerHints(state: PickerState): PickerHint[] {
  const hints: PickerHint[] = [];
  for (const binding of PICKER_KEYS) {
    if (!binding.hint || typeof binding.action === 'function' || !applies(binding, state)) {
      continue;
    }
    const hint: PickerHint = {
      key: binding.hint.key,
      label: binding.hint.label,
      group: 1,
      disabled: binding.dim?.(state) ?? false,
      action: binding.action,
    };
    if (binding.hint.detail) {
      hint.detail = binding.hint.detail(state);
    }
    hints.push(hint);
  }
  return hints;
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/** The cursor kept on its service if still visible, else the first visible row; the window follows. */
function settle(state: PickerState): PickerState {
  const visible = visibleRows(state);
  const cursor =
    state.cursor !== null && visible.some((s) => s.name === state.cursor)
      ? state.cursor
      : (visible[0]?.name ?? null);
  const at = cursor === null ? -1 : visible.findIndex((s) => s.name === cursor);
  return { ...state, cursor, scroll: windowTop(state.scroll, at, state.listRows, visible.length) };
}

function toggle(state: PickerState, name: string, effects: PickerEffect[]): PickerState {
  if (isLocked(state, name)) {
    effects.push({
      type: 'toast',
      text: `${name} is needed by ${joinNames(neededBy(state, name))}`,
      tone: 'info',
    });
    return state;
  }
  const picked = isPicked(state, name)
    ? state.picked.filter((p) => p !== name)
    : rowsOf(state)
        .map((s) => s.name)
        .filter((n) => n === name || state.picked.includes(n));
  return { ...state, picked };
}

function dropLast(text: string): string {
  return Array.from(text).slice(0, -1).join('');
}

/** Actions that act only while the filter input is open, or only while it is closed. */
function actsIn(action: PickerAction): PickerMode | 'any' {
  switch (action.type) {
    case 'row':
    case 'move':
    case 'quit':
      return 'any';
    case 'filter-input':
    case 'filter-backspace':
    case 'filter-done':
    case 'filter-cancel':
      return 'filter';
    default:
      return 'list';
  }
}

function apply(state: PickerState, action: PickerAction, effects: PickerEffect[]): PickerState {
  const mode = actsIn(action);
  if (mode !== 'any' && mode !== modeOf(state)) {
    return state;
  }
  switch (action.type) {
    case 'move': {
      const visible = visibleRows(state);
      if (visible.length === 0) {
        return state;
      }
      const at = visible.findIndex((s) => s.name === state.cursor);
      const next = at === -1 ? 0 : (at + action.delta + visible.length) % visible.length;
      return settle({ ...state, cursor: visible[next]!.name });
    }
    case 'toggle':
      return state.cursor === null ? state : toggle(state, state.cursor, effects);
    case 'row':
      if (!visibleRows(state).some((s) => s.name === action.name)) {
        return state;
      }
      return toggle(settle({ ...state, cursor: action.name }), action.name, effects);
    case 'open-filter':
      return { ...state, input: state.filter };
    case 'clear-filter':
      return settle({ ...state, filter: '' });
    case 'none':
      return state.picked.length === 0 ? state : { ...state, picked: [] };
    case 'start':
      if (state.picked.length > 0) {
        effects.push(
          { type: 'save-selection', names: [...state.picked] },
          { type: 'start', names: [...state.picked] },
        );
      }
      return state;
    case 'quit':
      effects.push({ type: 'quit' });
      return state;
    case 'filter-input':
      return settle({ ...state, input: `${state.input ?? ''}${action.text}` });
    case 'filter-backspace':
      return settle({ ...state, input: dropLast(state.input ?? '') });
    case 'filter-done':
      return settle({ ...state, filter: (state.input ?? '').trim(), input: null });
    case 'filter-cancel':
      return settle({ ...state, filter: '', input: null });
  }
}

/** The picker's reducer: the next state, and what the event asks the owner to carry out. */
export function pickerStep(state: PickerState, event: PickerEvent): PickerStep {
  const effects: PickerEffect[] = [];
  switch (event.type) {
    case 'key': {
      const action = resolvePickerKey(state, event.input, event.key);
      return { state: action ? apply(state, action, effects) : state, effects };
    }
    case 'click':
      return { state: event.action ? apply(state, event.action, effects) : state, effects };
    case 'wheel': {
      const visible = visibleRows(state);
      const at = visible.findIndex((s) => s.name === state.cursor);
      const next = Math.max(0, Math.min(visible.length - 1, at + event.delta));
      if (at === -1 || next === at) {
        return { state, effects };
      }
      return { state: settle({ ...state, cursor: visible[next]!.name }), effects };
    }
    case 'resize':
      return { state: settle({ ...state, listRows: event.listRows }), effects };
    case 'expire':
      return { state, effects };
  }
}
