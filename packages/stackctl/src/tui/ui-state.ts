import { type ItemRect, verticalTarget } from '../components/footer-nav.js';
import {
  type Action,
  type Entry,
  type KeyContext,
  type Mode,
  type Phase,
  isActive,
  isInfraBusy,
  isInfraUp,
} from './keymap.js';

/**
 * The run screen's UI state and its reducer: the mode, the focus, the filter, the commands menu
 * and the pending confirmations. Pure: it reads no clock (every event carries its time) and
 * touches no session. What an event asks of the world comes back as {@link Effect}s from
 * {@link step}, for the screen to carry out once.
 */

/** How long the quit confirmation stays armed, and its toast shown (run-screen §3.5.1). */
export const QUIT_CONFIRM_MS = 2_000;
/** How long the infra reset confirmation stays armed, and its toast shown (run-screen §3.5.3). */
export const RESET_CONFIRM_MS = 5_000;

export type ConfirmKind = 'quit' | 'reset-infra';

/** An armed confirmation. A reset's `target` is the infra entry it resets. */
export interface Confirmation {
  kind: ConfirmKind;
  target?: string;
  expiresAt: number;
}

/** A services-row entry by identity, so the focus stays on it when entries are added. */
export interface EntryKey {
  kind: Entry['kind'];
  name: string;
}

export interface UiState {
  mode: Mode;
  /** The focused entry; `null` means the first one, once the session runs. */
  focus: EntryKey | null;
  /** The applied filter's terms; empty when nothing is filtered. */
  filter: string;
  /** What the filter input holds. */
  filterDraft: string;
  /** The commands menu, for the focused app service, while it is open. */
  menu: { selected: number; custom: string } | null;
  /** At most one per kind. */
  pending: readonly Confirmation[];
}

export const initialUiState: UiState = {
  mode: 'normal',
  focus: null,
  filter: '',
  filterDraft: '',
  menu: null,
  pending: [],
};

/** What the reducer reads of the screen besides its own state. Plain data, built per event. */
export interface UiContext {
  phase: Phase;
  /** App services, then infra entries, in services-row order. */
  entries: readonly Entry[];
  /** Each entry's first cell and row as laid out now, by entry index (for ↑/↓). */
  rects: readonly ItemRect[];
  /** The commands menu's scripts, by app service; the custom row always follows them. */
  commands: Readonly<Record<string, readonly string[]>>;
  /** A log text selection is on screen. */
  hasSelection: boolean;
  /** A sticky toast is on screen. */
  hasStickyToast: boolean;
}

export type UiEvent =
  | { type: 'key'; action: Action; at: number; ctx: UiContext }
  /**
   * A click (a press and release on the same target, no drag), or `action: null` for one on no
   * target: the log pane, a gap, or a toast button that isn't a confirmation's own.
   */
  | { type: 'click'; action: Action | null; at: number; ctx: UiContext }
  /** Time has passed: every confirmation due by `at` disarms. */
  | { type: 'expire'; at: number };

/** What an event asks the screen to carry out, in order. */
export type Effect =
  /** Show the confirmation's toast for `ms`. */
  | { type: 'arm'; kind: 'quit'; ms: number }
  | { type: 'arm'; kind: 'reset-infra'; target: string; ms: number }
  /** Dismiss the confirmation's toast: it was confirmed, expired, replaced or clicked away. */
  | { type: 'disarm'; kind: ConfirmKind; target?: string }
  /** The one shutdown; while one already runs, the second request (the hard kill). */
  | { type: 'shutdown' }
  | { type: 'restart'; entry: EntryKey }
  | { type: 'stop'; entry: EntryKey }
  | { type: 'start'; entry: EntryKey }
  | { type: 'reset-infra'; target: string }
  /** The applied filter changed: apply it, clear the selection, toast applied or cleared. */
  | { type: 'filter'; filter: string }
  | { type: 'clear-selection' }
  | { type: 'dismiss-sticky-toast' }
  /** Clear the log: the text selection, and every buffered line, hidden ones included. */
  | { type: 'clear-log' }
  | { type: 'scroll'; to: 'page-older' | 'page-newer' | 'oldest' | 'newest' }
  | { type: 'run-script'; service: string; script: string }
  | { type: 'run-custom'; service: string; command: string };

export interface Step {
  state: UiState;
  effects: Effect[];
}

/** The focused entry's index in `ctx.entries`; `null` until the session runs, or with none. */
export function focusIndex(state: UiState, ctx: UiContext): number | null {
  if (ctx.phase !== 'running' || ctx.entries.length === 0) {
    return null;
  }
  const { focus } = state;
  const at = focus
    ? ctx.entries.findIndex((e) => e.kind === focus.kind && e.name === focus.name)
    : -1;
  return at === -1 ? 0 : at;
}

export function focusedEntry(state: UiState, ctx: UiContext): Entry | null {
  const at = focusIndex(state, ctx);
  return at === null ? null : ctx.entries[at]!;
}

function scriptsOf(ctx: UiContext, service: string): readonly string[] {
  return ctx.commands[service] ?? [];
}

/** What the key table reads for this state. */
export function keyContext(state: UiState, ctx: UiContext): KeyContext {
  // Starting up, the entry focused once the session runs: its keys are drawn dim until then, so
  // the keys row doesn't change length when it does. The reducer acts on no entry meanwhile.
  const focused = focusedEntry(
    state,
    ctx.phase === 'starting' ? { ...ctx, phase: 'running' } : ctx,
  );
  const menu =
    state.mode === 'commands' && state.menu && focused
      ? {
          customSelected: state.menu.selected === scriptsOf(ctx, focused.name).length,
          customText: state.menu.custom,
          appServices: ctx.entries.filter((e) => e.kind === 'app').length,
        }
      : null;
  return { mode: state.mode, phase: ctx.phase, focused, filter: state.filter, menu };
}

/**
 * When the earliest armed confirmation expires, for the screen's one timer; `null` if none. A
 * timer can fire a little early, and then the `expire` event changes nothing: reschedule while
 * this is not `null`, not only when it changes.
 */
export function nextExpiry(state: UiState): number | null {
  return state.pending.length === 0 ? null : Math.min(...state.pending.map((p) => p.expiresAt));
}

/** The infra entry a `reset-infra` names: its target, or the focused infra entry. */
function resetTarget(action: { target?: string }, focused: Entry | null): string | null {
  return action.target ?? (focused?.kind === 'infra' ? focused.name : null);
}

/** Whether a click on `action` is one of `p`'s confirming targets (run-screen §3.5.4). */
function confirms(p: Confirmation, action: Action | null, focused: Entry | null): boolean {
  if (!action) {
    return false;
  }
  if (p.kind === 'quit') {
    return action.type === 'quit';
  }
  return action.type === 'reset-infra' && resetTarget(action, focused) === p.target;
}

/** The mode an action acts in; `quit` acts in every mode. */
function modeOf(action: Action): Mode | 'any' {
  switch (action.type) {
    case 'quit':
      return 'any';
    case 'filter-input':
    case 'filter-backspace':
    case 'apply-filter':
    case 'clear-filter':
      return 'filter';
    case 'menu-move':
    case 'menu-service':
    case 'run-command':
    case 'custom-command':
    case 'custom-input':
    case 'custom-backspace':
    case 'close-menu':
      return 'commands';
    default:
      return 'normal';
  }
}

/** A working copy for one event: the state as it changes, and the effects it collects. */
class Draft {
  effects: Effect[] = [];
  state: UiState;

  constructor(state: UiState) {
    this.state = state;
  }

  set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
  }

  /** Drops `kind`'s confirmation, if any, and dismisses its toast. */
  disarm(kind: ConfirmKind): Confirmation | undefined {
    const p = this.state.pending.find((c) => c.kind === kind);
    if (p) {
      this.set({ pending: this.state.pending.filter((c) => c !== p) });
      this.effects.push(
        p.target === undefined
          ? { type: 'disarm', kind }
          : { type: 'disarm', kind, target: p.target },
      );
    }
    return p;
  }

  arm(confirmation: Confirmation): void {
    this.set({ pending: [...this.state.pending, confirmation] });
  }

  closeMenu(): void {
    this.set({ mode: 'normal', menu: null });
  }
}

function applyFilter(d: Draft, next: string): void {
  const changed = next !== d.state.filter;
  d.set({ mode: 'normal', filter: next, filterDraft: next });
  if (changed) {
    d.effects.push({ type: 'filter', filter: next });
  }
}

function dropLast(text: string): string {
  return Array.from(text).slice(0, -1).join('');
}

function quit(d: Draft, at: number, ctx: UiContext): void {
  if (ctx.phase !== 'running') {
    // No confirmation during startup, after a startup failure, or for the second request.
    d.effects.push({ type: 'shutdown' });
    return;
  }
  const p = d.disarm('quit');
  if (p && at < p.expiresAt) {
    d.effects.push({ type: 'shutdown' });
    return;
  }
  d.arm({ kind: 'quit', expiresAt: at + QUIT_CONFIRM_MS });
  d.effects.push({ type: 'arm', kind: 'quit', ms: QUIT_CONFIRM_MS });
}

function resetInfra(d: Draft, action: { target?: string }, at: number, ctx: UiContext): void {
  const target = resetTarget(action, focusedEntry(d.state, ctx));
  const entry = ctx.entries.find((e) => e.kind === 'infra' && e.name === target);
  if (!target || !entry || entry.kind !== 'infra' || isInfraBusy(entry.state)) {
    return;
  }
  const p = d.state.pending.find((c) => c.kind === 'reset-infra');
  if (p && p.target === target && at < p.expiresAt) {
    d.disarm('reset-infra');
    d.effects.push({ type: 'reset-infra', target });
    return;
  }
  d.disarm('reset-infra');
  d.arm({ kind: 'reset-infra', target, expiresAt: at + RESET_CONFIRM_MS });
  d.effects.push({ type: 'arm', kind: 'reset-infra', target, ms: RESET_CONFIRM_MS });
}

function moveFocus(d: Draft, ctx: UiContext, to: number): void {
  const entry = ctx.entries[to];
  if (entry) {
    d.set({ focus: { kind: entry.kind, name: entry.name } });
  }
}

/** Whether a key's action acts in this mode: its own mode's actions, and `quit` in every one. */
function keyAllowed(mode: Mode, action: Action): boolean {
  const own = modeOf(action);
  return own === 'any' || own === mode;
}

/** Carries out `action` on the draft; the caller has checked it may act in the current mode. */
function apply(d: Draft, action: Action, at: number, ctx: UiContext): void {
  const { state } = d;
  const index = focusIndex(state, ctx);
  const focused = index === null ? null : ctx.entries[index]!;
  const key: EntryKey | null = focused && { kind: focused.kind, name: focused.name };
  const n = ctx.entries.length;
  switch (action.type) {
    case 'quit':
      quit(d, at, ctx);
      return;
    case 'focus-next':
    case 'focus-prev':
      if (index !== null) {
        moveFocus(d, ctx, (index + (action.type === 'focus-next' ? 1 : -1) + n) % n);
      }
      return;
    case 'focus-up':
    case 'focus-down':
      if (index !== null) {
        moveFocus(
          d,
          ctx,
          verticalTarget([...ctx.rects], index, action.type === 'focus-up' ? 'up' : 'down'),
        );
      }
      return;
    case 'focus-index':
      if (index !== null) {
        moveFocus(d, ctx, action.index);
      }
      return;
    case 'restart':
      if (focused && key) {
        const can =
          focused.kind === 'app'
            ? isActive(focused.state)
            : isInfraUp(focused.state) && !isInfraBusy(focused.state);
        if (can) {
          d.effects.push({ type: 'restart', entry: key });
        }
      }
      return;
    case 'stop-start':
      if (focused && key) {
        if (focused.kind === 'app') {
          // A service waiting for its deps starts once they're ready, never before.
          if (focused.state !== 'waiting') {
            d.effects.push({ type: isActive(focused.state) ? 'stop' : 'start', entry: key });
          }
        } else if (!isInfraBusy(focused.state)) {
          d.effects.push({ type: isInfraUp(focused.state) ? 'stop' : 'start', entry: key });
        }
      }
      return;
    case 'reset-infra':
      resetInfra(d, action, at, ctx);
      return;
    case 'open-commands':
      if (focused?.kind === 'app') {
        d.set({ mode: 'commands', menu: { selected: 0, custom: '' } });
      }
      return;
    case 'open-filter':
      d.set({ mode: 'filter', filterDraft: state.filter });
      return;
    case 'filter-input':
      d.set({ filterDraft: state.filterDraft + action.text });
      return;
    case 'filter-backspace':
      d.set({ filterDraft: dropLast(state.filterDraft) });
      return;
    case 'apply-filter':
      applyFilter(d, state.filterDraft.trim());
      return;
    case 'clear-filter':
      applyFilter(d, '');
      return;
    case 'escape':
      if (ctx.hasSelection) {
        d.effects.push({ type: 'clear-selection' });
      } else if (ctx.hasStickyToast) {
        d.effects.push({ type: 'dismiss-sticky-toast' });
      } else if (state.filter !== '') {
        applyFilter(d, '');
      }
      return;
    case 'clear-log':
      d.effects.push({ type: 'clear-log' });
      return;
    case 'scroll-page-older':
      d.effects.push({ type: 'scroll', to: 'page-older' });
      return;
    case 'scroll-page-newer':
      d.effects.push({ type: 'scroll', to: 'page-newer' });
      return;
    case 'scroll-oldest':
      d.effects.push({ type: 'scroll', to: 'oldest' });
      return;
    case 'scroll-newest':
      d.effects.push({ type: 'scroll', to: 'newest' });
      return;
    case 'menu-move':
    case 'menu-service':
    case 'run-command':
    case 'custom-command':
    case 'custom-input':
    case 'custom-backspace':
      if (state.menu && focused?.kind === 'app') {
        applyMenu(d, action, state.menu, focused.name, ctx);
      }
      return;
    case 'close-menu':
      // Not tied to the focus: the menu always closes.
      d.closeMenu();
      return;
  }
}

type MenuAction = Extract<
  Action,
  {
    type:
      | 'menu-move'
      | 'menu-service'
      | 'run-command'
      | 'custom-command'
      | 'custom-input'
      | 'custom-backspace';
  }
>;

/** The commands menu's actions, for the focused app service `service`. */
function applyMenu(
  d: Draft,
  action: MenuAction,
  menu: NonNullable<UiState['menu']>,
  service: string,
  ctx: UiContext,
): void {
  const scripts = scriptsOf(ctx, service);
  const customRow = scripts.length;
  switch (action.type) {
    case 'menu-move':
      d.set({
        menu: {
          ...menu,
          selected: (menu.selected + action.delta + customRow + 1) % (customRow + 1),
        },
      });
      return;
    case 'menu-service': {
      const apps = ctx.entries.filter((e) => e.kind === 'app');
      if (apps.length < 2 || (menu.selected === customRow && menu.custom !== '')) {
        return;
      }
      const at = apps.findIndex((e) => e.name === service);
      const next = apps[(at + action.delta + apps.length) % apps.length]!;
      d.set({ focus: { kind: 'app', name: next.name }, menu: { selected: 0, custom: '' } });
      return;
    }
    case 'run-command': {
      const row = action.row ?? menu.selected;
      if (row < customRow) {
        d.effects.push({ type: 'run-script', service, script: scripts[row]! });
      } else if (row === customRow) {
        const command = menu.custom.trim();
        if (command !== '') {
          d.effects.push({ type: 'run-custom', service, command });
        }
      } else {
        return;
      }
      d.closeMenu();
      return;
    }
    case 'custom-command':
      d.set({ menu: { ...menu, selected: customRow } });
      return;
    case 'custom-input':
      if (menu.selected === customRow) {
        d.set({ menu: { ...menu, custom: menu.custom + action.text } });
      }
      return;
    case 'custom-backspace':
      if (menu.selected === customRow) {
        d.set({ menu: { ...menu, custom: dropLast(menu.custom) } });
      }
      return;
  }
}

/** The targets a click in filter mode still works on: none of them takes the typing (S2-R23). */
const FILTER_PASS_THROUGH: ReadonlySet<Action['type']> = new Set(['scroll-newest']);

/**
 * What a click may do in each mode (run-screen §4.2.4, §5.3.3): what a key could, plus, in every
 * mode, the armed reset's `[reset]` button, and in filter mode the copy icon, links and the jump row.
 */
function clickAllowed(mode: Mode, action: Action): boolean {
  return (
    keyAllowed(mode, action) ||
    (action.type === 'reset-infra' && action.target !== undefined) ||
    (mode === 'filter' && FILTER_PASS_THROUGH.has(action.type))
  );
}

/** Whether a reset of `target` is armed and still within its window at `at`. */
function armedReset(state: UiState, target: string, at: number): boolean {
  return state.pending.some(
    (p) => p.kind === 'reset-infra' && p.target === target && at < p.expiresAt,
  );
}

function onClick(d: Draft, clicked: Action | null, at: number, ctx: UiContext): void {
  // A `[reset]` button names its entry; once its confirmation is gone (expired, or replaced) it is
  // a click on nothing, which only disarms.
  const action =
    clicked?.type === 'reset-infra' &&
    clicked.target !== undefined &&
    !armedReset(d.state, clicked.target, at)
      ? null
      : clicked;
  // Any click but on a confirmation's own targets disarms it (run-screen §3.5.4).
  const focused = focusedEntry(d.state, ctx);
  for (const p of d.state.pending) {
    if (!confirms(p, action, focused)) {
      d.disarm(p.kind);
    }
  }
  if (action && clickAllowed(d.state.mode, action)) {
    apply(d, action, at, ctx);
  } else if (d.state.mode === 'commands') {
    // A click outside the menu closes it, and does nothing else.
    d.closeMenu();
  }
  // Filter mode ignores any other click; the input keeps the typing.
}

/** One event: the next state, and what the screen must carry out because of it, in order. */
export function step(state: UiState, event: UiEvent): Step {
  const d = new Draft(state);
  switch (event.type) {
    case 'expire':
      for (const p of state.pending) {
        if (event.at >= p.expiresAt) {
          d.disarm(p.kind);
        }
      }
      break;
    case 'key':
      // While shutting down, every key but quit is ignored (run-screen §3.1.2).
      if (
        keyAllowed(d.state.mode, event.action) &&
        (event.ctx.phase !== 'stopping' || event.action.type === 'quit')
      ) {
        apply(d, event.action, event.at, event.ctx);
      }
      break;
    case 'click':
      // While shutting down, clicks do nothing (run-screen §6.6.4).
      if (event.ctx.phase !== 'stopping') {
        onClick(d, event.action, event.at, event.ctx);
      }
      break;
  }
  return { state: d.state, effects: d.effects };
}
