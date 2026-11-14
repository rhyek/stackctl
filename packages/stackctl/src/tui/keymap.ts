import type { SessionInfraState, SessionSnapshot } from '../session/session.js';
import type { ServiceState } from '../session/supervisor.js';

/**
 * The run screen's key table: which key does what, in which mode and for which focused entry.
 * The footer's keys row and the commands menu's hint row are generated from it, so a hint can't
 * advertise a key that does something else.
 */

/** What the keyboard is driving: the screen, the filter input, or the commands menu. */
export type Mode = 'normal' | 'filter' | 'commands';

export type Phase = SessionSnapshot['phase'];

/** A services-row entry, as the keys and the reducer see it. */
export type Entry =
  | { kind: 'app'; name: string; state: ServiceState }
  | { kind: 'infra'; name: string; state: SessionInfraState };

/** Everything a key, a click or the reducer can ask the run screen to do. */
export type Action =
  | { type: 'focus-next' }
  | { type: 'focus-prev' }
  | { type: 'focus-up' }
  | { type: 'focus-down' }
  /** A click on the services row: the entry's index, app services first, then infra. */
  | { type: 'focus-index'; index: number }
  | { type: 'restart' }
  | { type: 'stop-start' }
  /** Arms or confirms the infra reset: of `target`, or of the focused infra entry. */
  | { type: 'reset-infra'; target?: string }
  | { type: 'open-commands' }
  | { type: 'open-filter' }
  | { type: 'filter-input'; text: string }
  | { type: 'filter-backspace' }
  | { type: 'apply-filter' }
  | { type: 'clear-filter' }
  | { type: 'clear-log' }
  /** The Esc chain: the selection, then the newest sticky toast, then the applied filter. */
  | { type: 'escape' }
  | { type: 'scroll-page-older' }
  | { type: 'scroll-page-newer' }
  | { type: 'scroll-oldest' }
  | { type: 'scroll-newest' }
  | { type: 'quit' }
  | { type: 'menu-move'; delta: 1 | -1 }
  | { type: 'menu-service'; delta: 1 | -1 }
  /** Runs `row` (a click on it) or the highlighted row: a script, or the custom command. */
  | { type: 'run-command'; row?: number }
  | { type: 'custom-command' }
  | { type: 'custom-input'; text: string }
  | { type: 'custom-backspace' }
  | { type: 'close-menu' };

/** What the key table reads: the mode, the session's phase, the focused entry and the menu. */
export interface KeyContext {
  mode: Mode;
  phase: Phase;
  /**
   * During startup, the entry focused once the session runs, whose keys are drawn dim. `null`
   * after a startup failure, or with no entries.
   */
  focused: Entry | null;
  /** The applied filter's terms; empty when nothing is filtered. */
  filter: string;
  /** Set in commands mode. */
  menu: { customSelected: boolean; customText: string; appServices: number } | null;
}

/** The modifier and named-key flags of a key press; Ink's `Key` satisfies it. */
export interface KeyFlags {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  meta?: boolean;
}

export type NamedKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'pageUp'
  | 'pageDown'
  | 'home'
  | 'end'
  | 'return'
  | 'escape'
  /** Backspace or Delete. */
  | 'backspace';

/**
 * Which press a binding takes: one character without Ctrl or Meta (Shift allowed, so `R` is
 * Shift+R); Ctrl plus a letter; a named key; or any printable text, a paste included.
 */
export type KeySpec =
  | { char: string }
  | { ctrl: string }
  | { named: NamedKey }
  | { printable: true };

export interface HintSpec {
  /** As drawn: `r`, `^c`, `esc`, `⏎`, `↑ ↓`. */
  key: string;
  label: string;
  /** Drawn after the label, in cyan: the applied filter's terms. */
  detail?: (ctx: KeyContext) => string;
  /** Groups are drawn in increasing order, separated by `│` on the keys row. */
  group: number;
  /** The footer's keys row (the default), or the commands menu's own hint row. */
  row?: HintRow;
}

export type HintRow = 'keys' | 'menu';

interface BindingBase {
  mode: Mode;
  when?: (ctx: KeyContext) => boolean;
  key: KeySpec;
  /** The hint is drawn dim: its action does nothing in this state (run-screen §3.4.3). */
  dim?: (ctx: KeyContext) => boolean;
}

export type KeyBinding =
  | (BindingBase & { hint: HintSpec; action: Action })
  | (BindingBase & { hint?: undefined; action: Action | ((text: string) => Action) });

/** A hint as a row draws it: `<key> <label>[ <detail>]`, dim when `disabled`. */
export interface Hint {
  key: string;
  label: string;
  detail?: string;
  group: number;
  disabled: boolean;
  /** What its key does, and what a click on it dispatches. */
  action: Action;
}

/** An app service whose dot reads running, starting or restarting. */
export function isActive(state: ServiceState): boolean {
  switch (state) {
    case 'running':
    case 'starting':
    case 'restarting':
      return true;
    case 'pending':
    case 'waiting':
    case 'stopped':
    case 'crashed':
      return false;
  }
}

/** An infra service that is up: running, or coming up. */
export function isInfraUp(state: SessionInfraState): boolean {
  switch (state) {
    case 'running':
    case 'starting':
      return true;
    case 'stopped':
    case 'stopping':
    case 'restarting':
    case 'resetting':
    case 'pending':
    case 'failed':
      return false;
  }
}

/** An infra service with an action under way on it. */
export function isInfraBusy(state: SessionInfraState): boolean {
  switch (state) {
    case 'stopping':
    case 'restarting':
    case 'resetting':
      return true;
    case 'running':
    case 'starting':
    case 'stopped':
    case 'pending':
    case 'failed':
      return false;
  }
}

const app = (ctx: KeyContext) => ctx.focused?.kind === 'app';
const infra = (ctx: KeyContext) => ctx.focused?.kind === 'infra';
const appActive = (ctx: KeyContext) => ctx.focused?.kind === 'app' && isActive(ctx.focused.state);
/** `s` reads stop: an active service, or one pending at startup, about to start. */
const appStops = (ctx: KeyContext) =>
  appActive(ctx) || (ctx.phase === 'starting' && ctx.focused?.state === 'pending');
const infraUp = (ctx: KeyContext) => ctx.focused?.kind === 'infra' && isInfraUp(ctx.focused.state);
const infraBusy = (ctx: KeyContext) =>
  ctx.focused?.kind === 'infra' && isInfraBusy(ctx.focused.state);
const focused = (ctx: KeyContext) => ctx.focused !== null;
const filtered = (ctx: KeyContext) => ctx.filter !== '';
const customSelected = (ctx: KeyContext) => ctx.menu?.customSelected === true;

const SESSION = 3;

/** The key table, in the order the hints are drawn. The first binding that matches a press wins. */
export const KEY_TABLE: readonly KeyBinding[] = [
  // Every mode: quit. Its hint is on the keys row in normal and commands mode; filter mode's row
  // has no room for it.
  {
    mode: 'filter',
    key: { ctrl: 'c' },
    action: { type: 'quit' },
  },
  {
    mode: 'commands',
    key: { ctrl: 'c' },
    hint: { key: '^c', label: 'quit', group: SESSION },
    action: { type: 'quit' },
  },

  // Normal mode, a service focused: ←/→ select the one beside it (↑/↓ do too, unhinted).
  {
    mode: 'normal',
    when: focused,
    key: { named: 'right' },
    hint: { key: '← →', label: 'select', group: 1 },
    action: { type: 'focus-next' },
  },
  { mode: 'normal', when: focused, key: { named: 'left' }, action: { type: 'focus-prev' } },

  // Normal mode, an app service focused.
  {
    mode: 'normal',
    when: app,
    key: { char: 'r' },
    hint: { key: 'r', label: 'restart', group: 1 },
    dim: (ctx) => !appActive(ctx),
    action: { type: 'restart' },
  },
  {
    mode: 'normal',
    when: appStops,
    key: { char: 's' },
    hint: { key: 's', label: 'stop', group: 1 },
    action: { type: 'stop-start' },
  },
  {
    mode: 'normal',
    when: (ctx) => app(ctx) && !appStops(ctx),
    key: { char: 's' },
    hint: { key: 's', label: 'start', group: 1 },
    // A service waiting for its deps starts once they're ready, never before.
    dim: (ctx) => ctx.focused?.state === 'waiting',
    action: { type: 'stop-start' },
  },
  {
    mode: 'normal',
    when: app,
    key: { char: 'm' },
    hint: { key: 'm', label: 'commands', group: 1 },
    action: { type: 'open-commands' },
  },

  // Normal mode, an infra entry focused.
  {
    mode: 'normal',
    when: infra,
    key: { char: 'r' },
    hint: { key: 'r', label: 'restart', group: 1 },
    dim: (ctx) => infraBusy(ctx) || !infraUp(ctx),
    action: { type: 'restart' },
  },
  {
    mode: 'normal',
    when: infraUp,
    key: { char: 's' },
    hint: { key: 's', label: 'stop', group: 1 },
    dim: infraBusy,
    action: { type: 'stop-start' },
  },
  {
    mode: 'normal',
    when: (ctx) => infra(ctx) && !infraUp(ctx),
    key: { char: 's' },
    hint: { key: 's', label: 'start', group: 1 },
    dim: infraBusy,
    action: { type: 'stop-start' },
  },
  {
    mode: 'normal',
    when: infra,
    key: { char: 'R' },
    hint: { key: 'R', label: 'reset data', group: 1 },
    dim: infraBusy,
    action: { type: 'reset-infra' },
  },

  // Normal mode, the log.
  {
    mode: 'normal',
    when: (ctx) => !filtered(ctx),
    key: { char: 'f' },
    hint: { key: 'f', label: 'filter', group: 2 },
    action: { type: 'open-filter' },
  },
  {
    mode: 'normal',
    when: filtered,
    key: { char: 'f' },
    hint: { key: 'f', label: 'filter:', detail: (ctx) => ctx.filter, group: 2 },
    action: { type: 'open-filter' },
  },
  {
    mode: 'normal',
    when: filtered,
    key: { named: 'escape' },
    hint: { key: 'esc', label: 'clear filter', group: 2 },
    action: { type: 'escape' },
  },
  {
    mode: 'normal',
    key: { char: 'c' },
    hint: { key: 'c', label: 'clear', group: 2 },
    action: { type: 'clear-log' },
  },

  // Normal mode, the session.
  {
    mode: 'normal',
    key: { ctrl: 'c' },
    hint: { key: '^c', label: 'quit', group: SESSION },
    action: { type: 'quit' },
  },

  // Normal mode, hidden: navigation, scrolling, and Esc with nothing filtered.
  { mode: 'normal', when: focused, key: { named: 'up' }, action: { type: 'focus-up' } },
  { mode: 'normal', when: focused, key: { named: 'down' }, action: { type: 'focus-down' } },
  { mode: 'normal', key: { named: 'pageUp' }, action: { type: 'scroll-page-older' } },
  { mode: 'normal', key: { named: 'pageDown' }, action: { type: 'scroll-page-newer' } },
  { mode: 'normal', key: { named: 'home' }, action: { type: 'scroll-oldest' } },
  { mode: 'normal', key: { named: 'end' }, action: { type: 'scroll-newest' } },
  {
    mode: 'normal',
    when: (ctx) => !filtered(ctx),
    key: { named: 'escape' },
    action: { type: 'escape' },
  },

  // Filter mode: its row replaces the keys row.
  {
    mode: 'filter',
    key: { named: 'return' },
    hint: { key: '⏎', label: 'apply', group: 1 },
    action: { type: 'apply-filter' },
  },
  {
    mode: 'filter',
    key: { named: 'escape' },
    hint: { key: 'esc', label: 'clear', group: 1 },
    action: { type: 'clear-filter' },
  },
  { mode: 'filter', key: { named: 'backspace' }, action: { type: 'filter-backspace' } },
  {
    mode: 'filter',
    key: { printable: true },
    action: (text) => ({ type: 'filter-input', text }),
  },

  // Commands mode: the menu's own hint row. ↑ and ← are the hidden halves of `↑ ↓` and `← →`.
  {
    mode: 'commands',
    key: { named: 'down' },
    hint: { key: '↑ ↓', label: 'choose', group: 1, row: 'menu' },
    action: { type: 'menu-move', delta: 1 },
  },
  { mode: 'commands', key: { named: 'up' }, action: { type: 'menu-move', delta: -1 } },
  {
    mode: 'commands',
    when: (ctx) => (ctx.menu?.appServices ?? 0) > 1,
    key: { named: 'right' },
    hint: { key: '← →', label: 'service', group: 1, row: 'menu' },
    action: { type: 'menu-service', delta: 1 },
  },
  {
    mode: 'commands',
    when: (ctx) => (ctx.menu?.appServices ?? 0) > 1,
    key: { named: 'left' },
    action: { type: 'menu-service', delta: -1 },
  },
  {
    mode: 'commands',
    key: { named: 'return' },
    hint: { key: '⏎', label: 'run', group: 1, row: 'menu' },
    action: { type: 'run-command' },
  },
  {
    mode: 'commands',
    key: { named: 'escape' },
    hint: { key: 'esc', label: 'close', group: 1, row: 'menu' },
    action: { type: 'close-menu' },
  },
  {
    mode: 'commands',
    when: customSelected,
    key: { named: 'backspace' },
    action: { type: 'custom-backspace' },
  },
  {
    mode: 'commands',
    when: customSelected,
    key: { printable: true },
    action: (text) => ({ type: 'custom-input', text }),
  },
];

const NAMED_FLAG: Record<Exclude<NamedKey, 'backspace'>, keyof KeyFlags> = {
  up: 'upArrow',
  down: 'downArrow',
  left: 'leftArrow',
  right: 'rightArrow',
  pageUp: 'pageUp',
  pageDown: 'pageDown',
  home: 'home',
  end: 'end',
  return: 'return',
  escape: 'escape',
};

function isNamed(key: KeyFlags, name: NamedKey): boolean {
  return name === 'backspace'
    ? key.backspace === true || key.delete === true
    : key[NAMED_FLAG[name]] === true;
}

function anyNamed(key: KeyFlags): boolean {
  return (
    key.tab === true ||
    (Object.keys(NAMED_FLAG) as NamedKey[]).some((name) => isNamed(key, name)) ||
    isNamed(key, 'backspace')
  );
}

/** The text a press types, control characters (line breaks included) dropped; empty if none. */
export function printableText(input: string, key: KeyFlags): string {
  if (key.ctrl || key.meta || anyNamed(key)) {
    return '';
  }
  let text = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)) {
      text += ch;
    }
  }
  return text;
}

/** Whether a press is the one `spec` takes. */
export function matches(spec: KeySpec, input: string, key: KeyFlags): boolean {
  if ('named' in spec) {
    return isNamed(key, spec.named);
  }
  if ('ctrl' in spec) {
    return key.ctrl === true && !key.meta && input.toLowerCase() === spec.ctrl;
  }
  if ('char' in spec) {
    return !key.ctrl && !key.meta && !anyNamed(key) && input === spec.char;
  }
  return printableText(input, key) !== '';
}

function applies(binding: KeyBinding, ctx: KeyContext): boolean {
  if (binding.mode !== ctx.mode) {
    return false;
  }
  // While shutting down every key but Ctrl+C is ignored (run-screen §3.1.2).
  if (ctx.phase === 'stopping' && !isQuit(binding)) {
    return false;
  }
  return binding.when?.(ctx) ?? true;
}

function isQuit(binding: KeyBinding): boolean {
  return typeof binding.action !== 'function' && binding.action.type === 'quit';
}

/** The action a press resolves to in this context, or `null` when it does nothing. */
export function resolveKey(ctx: KeyContext, input: string, key: KeyFlags): Action | null {
  for (const binding of KEY_TABLE) {
    if (applies(binding, ctx) && matches(binding.key, input, key)) {
      return typeof binding.action === 'function'
        ? binding.action(printableText(input, key))
        : binding.action;
    }
  }
  return null;
}

/**
 * The hints for this context, in drawing order: the footer's keys row (or, in filter mode, the
 * filter row's), or with `row: 'menu'` the commands menu's own hint row.
 */
export function hintsFor(ctx: KeyContext, row: HintRow = 'keys'): Hint[] {
  const hints: Hint[] = [];
  for (const binding of KEY_TABLE) {
    const spec = binding.hint;
    if (!spec || (spec.row ?? 'keys') !== row || !applies(binding, ctx)) {
      continue;
    }
    const hint: Hint = {
      key: spec.key,
      label: spec.label,
      group: spec.group,
      // Starting up, the focused entry's keys (group 1) are dim: nothing can act on it yet.
      disabled: (ctx.phase === 'starting' && spec.group === 1) || (binding.dim?.(ctx) ?? false),
      action: binding.action,
    };
    if (spec.detail) {
      hint.detail = spec.detail(ctx);
    }
    hints.push(hint);
  }
  return hints;
}
