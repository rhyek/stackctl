import {
  ACCENT_COLOR,
  type Color,
  DANGER_COLOR,
  FOCUS_COLOR,
  HOTKEY_KEY_COLOR,
  HOTKEY_LABEL_COLOR,
  LINK_COLOR,
  MUTED_COLOR,
  BRANCH_COLOR,
  OK_COLOR,
  SELECTED_COLOR,
  WORKSPACE_COLOR,
  WARN_COLOR,
} from '../colors.js';
import type { ItemRect } from '../components/footer-nav.js';
import { formatMemory } from '../service-usage.js';
import type { SessionInfraState, SessionSnapshot } from '../session/session.js';
import type { Rect, Target } from './hit-test.js';
import { type Action, type Entry, type Hint, hintsFor } from './keymap.js';
import {
  RowBuilder,
  type Segment,
  blank,
  clip,
  cutEnd,
  cutSegmentsEnd,
  cutStart,
  rowWidth,
  width,
} from './text-cells.js';
import { type UiContext, type UiState, focusIndex, keyContext } from './ui-state.js';

export type { Segment } from './text-cells.js';

/**
 * The run screen's footer (Design A) and commands menu, laid out as plain data: rows of styled
 * segments, and the click targets over the exact cells those segments take. Rendering and
 * hit-testing both read this one layout, so they can't disagree. Pure: no Ink, no clock.
 *
 * **Coordinates.** A target's `col` is 1-based, like an SGR mouse report. Its `row` is relative
 * to the footer, with 0 for the rule line, so the menu's rows, above the footer, are negative.
 * The screen adds the rule line's 1-based screen row to get a report's row.
 */

export type FooterRow = Segment[];

/** A hint as a row draws it. `action` is what a click dispatches; without one, no target. */
export type HintLike = Pick<Hint, 'key' | 'label' | 'detail' | 'group' | 'disabled'> & {
  action?: Action;
};

export interface FooterLayout {
  /** Top to bottom: the rule line, the services row(s), the focus line, the keys row(s). */
  rows: FooterRow[];
  /** `rows.length`: the footer's height, known without measuring. */
  height: number;
  /** The index in `rows` of the first keys row (or of the filter row). */
  keysRow: number;
  targets: Target[];
  /** Each entry's padded rect's first cell and row, by entry index, for `UiContext.rects`. */
  rects: ItemRect[];
  /** The services row's entries, app services then infra, for `UiContext.entries`. */
  entries: Entry[];
}

export interface FooterOptions {
  /** Whether a blinking dot is lit this frame (`hasBlinkingDot`); lit when left out. */
  blinkLit?: boolean;
  /** The menu's scripts by app service, as `UiContext.commands`; the footer reads it only so its
   * key context matches the screen's. */
  commands?: Readonly<Record<string, readonly string[]>>;
}

export interface MenuLayout {
  /** The box's left cell, 1-based. */
  left: number;
  width: number;
  /** The whole box, borders included, in footer coordinates (its rows are negative). */
  rect: Rect;
  /** Top to bottom, the borders included; each exactly `width` cells. */
  rows: FooterRow[];
  /**
   * Rows are negative: the bottom border is row -1, just above the rule line. The first is the
   * whole box, under the rows and hints, so a click anywhere inside it is the menu's own.
   */
  targets: Target[];
}

export interface MenuOptions {
  /** The menu's scripts, by app service; the custom row always follows them. */
  commands: Readonly<Record<string, readonly string[]>>;
  /** The footer layout's `rects`, which place the box under the focused entry. */
  rects: readonly ItemRect[];
  /** The screen rows above the footer; the list scrolls inside the box when it can't fit. */
  maxRows?: number;
}

// ---------------------------------------------------------------------------
// Entries: dots, colors and words (run-screen §2.12)
// ---------------------------------------------------------------------------

type Dot = '●' | '○';

interface Look {
  dot: Dot;
  color: Color;
  /** The dot blinks: the service is on its way (starting, restarting, not ready yet). */
  blinks?: boolean;
  /** The status words, in the dot's color. */
  words: Segment[];
}

type AppService = SessionSnapshot['services'][number];
type InfraService = SessionSnapshot['infra'][number];

function look(dot: Dot, color: Color, words: string): Look {
  return { dot, color, words: [{ text: words, color }] };
}

/** A blinking `●`: on its way. */
function onItsWay(color: Color, words: string): Look {
  return { ...look('●', color, words), blinks: true };
}

function appLook(s: AppService): Look {
  switch (s.state) {
    case 'pending':
      return look('○', MUTED_COLOR, 'pending');
    case 'waiting':
      return look(
        '○',
        ACCENT_COLOR,
        s.waitsFor.length > 0 ? `waiting for ${s.waitsFor.join(', ')}` : 'waiting',
      );
    case 'starting':
      return onItsWay(WARN_COLOR, 'starting');
    case 'running':
      return s.ready
        ? look('●', OK_COLOR, 'running, ready')
        : onItsWay(WARN_COLOR, 'running, not ready');
    case 'restarting':
      return onItsWay(WARN_COLOR, 'restarting');
    case 'stopped':
    case 'crashed':
      if (s.exitCode !== null) {
        return {
          dot: '○',
          color: DANGER_COLOR,
          words: [
            { text: 'exited with code ', color: DANGER_COLOR },
            { text: String(s.exitCode), color: DANGER_COLOR, bold: true },
          ],
        };
      }
      return look('○', DANGER_COLOR, s.state);
  }
}

function infraWords(state: SessionInfraState): string {
  return state === 'running' ? 'healthy' : state;
}

function infraLook(i: InfraService): Look {
  switch (i.state) {
    case 'pending':
      return look('○', MUTED_COLOR, 'pending');
    case 'starting':
      // During startup the words are the step it is on (run-screen §2.12.3).
      return onItsWay(WARN_COLOR, i.detail ?? 'starting');
    case 'running':
      return look('●', OK_COLOR, 'healthy');
    case 'stopping':
    case 'restarting':
    case 'resetting':
      return onItsWay(WARN_COLOR, i.state);
    case 'failed':
    case 'stopped':
      return look('○', DANGER_COLOR, infraWords(i.state));
  }
}

/** Whether any services-row dot blinks, so the screen knows to run the blink's clock. */
export function hasBlinkingDot(snapshot: SessionSnapshot): boolean {
  return (
    snapshot.services.some((s) => appLook(s).blinks) ||
    snapshot.infra.some((i) => infraLook(i).blinks)
  );
}

/** The services row's entries, app services then infra: the order `focus-index` counts in. */
export function entriesOf(snapshot: SessionSnapshot): Entry[] {
  return [
    ...snapshot.services.map((s): Entry => ({ kind: 'app', name: s.name, state: s.state })),
    ...snapshot.infra.map((i): Entry => ({ kind: 'infra', name: i.name, state: i.state })),
  ];
}

// ---------------------------------------------------------------------------
// Hints: the keys row, the filter row and the menu's hint row (run-screen §2.11)
// ---------------------------------------------------------------------------

/** A hint's cells: `<key> <label>[ <detail>]`, all dim when it can't act. */
export function hintSegments(hint: HintLike): Segment[] {
  if (hint.disabled) {
    const text = `${hint.key} ${hint.label}${hint.detail ? ` ${hint.detail}` : ''}`;
    return [{ text, dim: true }];
  }
  const segments: Segment[] = [
    { text: hint.key, color: HOTKEY_KEY_COLOR, bold: true },
    { text: ' ' },
    { text: hint.label, color: HOTKEY_LABEL_COLOR },
  ];
  if (hint.detail) {
    segments.push({ text: ' ' }, { text: hint.detail, color: ACCENT_COLOR });
  }
  return segments;
}

function hintWidth(hint: HintLike): number {
  return rowWidth(hintSegments(hint));
}

export interface HintLayoutOptions {
  /** Blank cells at the start of every row. */
  indent: number;
  /** Blank cells between two hints of a group. */
  gap: number;
  /** Groups are set apart by `  │  ` (otherwise by `gap`, like hints). */
  separators: boolean;
  /**
   * Groups, by number, that never start a row while the group before them could go with them: when
   * one doesn't fit after that group, both start the next row.
   */
  keepWithPrevious?: readonly number[];
  /** A dim heading drawn before a group's first hint, by group number, after its separator. */
  headings?: Readonly<Record<number, string>>;
}

export interface PlacedHint {
  hint: HintLike;
  /** 0-based, among the rows this layout returns. */
  row: number;
  /** 1-based. */
  col: number;
  width: number;
}

const SEPARATOR: Segment[] = [blank(2), { text: '│', dim: true }, blank(2)];

/** The footer keys row's group headings: the log's keys are headed `logs:`. */
const KEY_GROUP_HEADINGS: Readonly<Record<number, string>> = { 2: 'logs:' };
/** The footer keys row's session keys (`^c quit`) wrap together with the log's. */
const KEY_GROUPS_KEPT_WITH_PREVIOUS: readonly number[] = [3];

/**
 * Hints laid out in rows of at most `cols` cells. A group that doesn't fit on the current row
 * starts the next one, so a `│` never begins or ends a row; a group too wide for a row of its own
 * wraps between hints, never inside one.
 */
export function layoutHints(
  hints: readonly HintLike[],
  cols: number,
  opts: HintLayoutOptions,
): { rows: FooterRow[]; placed: PlacedHint[] } {
  const groups: HintLike[][] = [];
  for (const hint of hints) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.group === hint.group) {
      last.push(hint);
    } else {
      groups.push([hint]);
    }
  }
  const builders: RowBuilder[] = [];
  const placed: PlacedHint[] = [];
  let row!: RowBuilder;
  const newRow = () => {
    row = new RowBuilder();
    row.push(blank(opts.indent));
    builders.push(row);
  };
  newRow();
  const empty = () => row.used === opts.indent;
  const place = (hint: HintLike) => {
    const col = row.push(...hintSegments(hint));
    placed.push({ hint, row: builders.length - 1, col, width: hintWidth(hint) });
  };
  const between: Segment[] = opts.separators ? SEPARATOR : [blank(opts.gap)];
  const headOf = (group: HintLike[]): Segment[] => {
    const heading = opts.headings?.[group[0]!.group];
    return heading === undefined ? [] : [{ text: heading, dim: true }, blank(1)];
  };
  const widthOf = (group: HintLike[]) =>
    rowWidth(headOf(group)) +
    group.reduce((w, h) => w + hintWidth(h), 0) +
    opts.gap * (group.length - 1);
  groups.forEach((group, i) => {
    // A group kept with the one before it: when the two don't fit here but do on a row of their
    // own, the one before starts the next row, and this one follows it there.
    const next = groups[i + 1];
    if (next && opts.keepWithPrevious?.includes(next[0]!.group) && !empty()) {
      const both = widthOf(group) + rowWidth(between) + widthOf(next);
      if (row.used + rowWidth(between) + both > cols && opts.indent + both <= cols) {
        newRow();
      }
    }
    const head = headOf(group);
    const groupWidth = widthOf(group);
    if (!empty()) {
      if (row.used + rowWidth(between) + groupWidth <= cols) {
        row.push(...between, ...head);
        group.forEach((hint, j) => {
          if (j > 0) {
            row.push(blank(opts.gap));
          }
          place(hint);
        });
        return;
      }
      newRow();
    }
    row.push(...head);
    for (const hint of group) {
      if (!empty() && row.used > opts.indent + rowWidth(head)) {
        if (row.used + opts.gap + hintWidth(hint) > cols) {
          newRow();
        } else {
          row.push(blank(opts.gap));
        }
      }
      place(hint);
    }
  });
  return { rows: builders.map((b) => clip(b.segments, cols)), placed };
}

function hintTargets(placed: readonly PlacedHint[], where: string, rowOf: (row: number) => number) {
  const targets: Target[] = [];
  for (const p of placed) {
    if (p.hint.action) {
      targets.push({
        id: `hint:${where}:${p.hint.key} ${p.hint.label}`,
        rect: { col: p.col, row: rowOf(p.row), width: p.width, height: 1 },
        action: p.hint.action,
      });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// The rule line (run-screen §2.8)
// ---------------------------------------------------------------------------

/** The run of `─` before the workspace. */
const RULE_HEAD = '──';
/** The rule lines' last cells, and their least fill; the picker's rule line shares them. */
export const RULE_TAIL = '──';
export const MIN_FILL = 2;
/** A branch is never cut below this many cells; past that it is dropped. */
export const BRANCH_MIN = 8;

function ruleLine(workspace: SessionSnapshot['workspace'], cols: number): Segment[] {
  const fixed = width(RULE_HEAD) + MIN_FILL;
  const wsWidth = (name: string, branch: string | null) =>
    width(name) + (branch === null ? 0 : 3 + width(branch)) + 2;
  const room = cols - fixed;
  let name = workspace.name;
  let branch = workspace.branch;
  // The branch is cut from its end down to `BRANCH_MIN` cells, then dropped; then the name is cut.
  if (wsWidth(name, branch) > room && branch !== null) {
    const branchRoom = width(branch) - (wsWidth(name, branch) - room);
    branch = branchRoom >= BRANCH_MIN ? cutEnd(branch, branchRoom) : null;
  }
  if (wsWidth(name, branch) > room) {
    name = cutEnd(name, Math.max(1, room - 2));
  }
  const ws: Segment[] =
    name === ''
      ? []
      : [
          blank(1),
          { text: name, color: WORKSPACE_COLOR },
          ...(branch === null
            ? []
            : [
                blank(1),
                { text: '⎇', dim: true },
                blank(1),
                { text: branch, color: BRANCH_COLOR },
              ]),
          blank(1),
        ];
  const fill = Math.max(MIN_FILL, cols - width(RULE_HEAD) - rowWidth(ws));
  return clip([{ text: RULE_HEAD, dim: true }, ...ws, { text: '─'.repeat(fill), dim: true }], cols);
}

// ---------------------------------------------------------------------------
// The services row (run-screen §2.9)
// ---------------------------------------------------------------------------

/** Blank cells between two entries of the services row. */
const ENTRY_GAP = 3;

interface Piece {
  col: number;
  segments: Segment[];
}

function entryContent(l: Look, lit: boolean, name: string, memory?: number): Segment[] {
  const dot: Segment =
    l.blinks && !lit ? { text: l.dot, color: l.color, dim: true } : { text: l.dot, color: l.color };
  const segments: Segment[] = [dot, blank(1), { text: name }];
  if (memory !== undefined) {
    segments.push(blank(1), { text: formatMemory(memory), dim: true });
  }
  return segments;
}

function servicesRows(
  snapshot: SessionSnapshot,
  focusAt: number | null,
  cols: number,
  firstRow: number,
  blinkLit: boolean,
): { rows: FooterRow[]; rects: ItemRect[]; targets: Target[] } {
  const apps = snapshot.services.length;
  const entries = entriesOf(snapshot).map((entry, index) => {
    const app = index < apps ? snapshot.services[index]! : null;
    const infra = app ? null : snapshot.infra[index - apps]!;
    const l = app ? appLook(app) : infraLook(infra!);
    const memory = app ? app.memory : infra!.memory;
    return { ...entry, content: entryContent(l, blinkLit, entry.name, memory) };
  });
  const rows: Piece[][] = [[]];
  const rects: ItemRect[] = [];
  const targets: Target[] = [];
  // The next entry starts here, at the row's first cell, or `ENTRY_GAP` cells after the last.
  let next = 1;
  const newRow = () => {
    rows.push([]);
    next = 1;
  };
  entries.forEach((entry, index) => {
    const w = rowWidth(entry.content);
    if (entry.kind === 'infra' && (index === 0 || entries[index - 1]!.kind === 'app')) {
      // The `infra` label, its gap and the first infra entry go together.
      // The infra take a row of their own, under the application services.
      if (rows[rows.length - 1]!.length > 0) {
        newRow();
      }
      const label = 1;
      rows[rows.length - 1]!.push({ col: label, segments: [{ text: 'infra:', dim: true }] });
      next = label + 7;
    } else if (rows[rows.length - 1]!.length > 0 && next + w - 1 > cols) {
      newRow();
    }
    const focused = index === focusAt;
    // The focused entry's name bold and in `SELECTED_COLOR`; the dot keeps its state's color.
    const content = focused
      ? entry.content.map((s) =>
          s.text === entry.name ? { ...s, color: SELECTED_COLOR, bold: true } : s,
        )
      : entry.content;
    rows[rows.length - 1]!.push({ col: next, segments: content });
    const row = firstRow + rows.length - 1;
    rects.push({ col: next, row });
    targets.push({
      id: `entry:${entry.kind}:${entry.name}`,
      rect: { col: next, row, width: w, height: 1 },
      action: { type: 'focus-index', index },
    });
    next += w + ENTRY_GAP;
  });
  return {
    rows: rows.map((pieces) => {
      const row = new RowBuilder();
      for (const piece of pieces) {
        row.padTo(piece.col);
        row.push(...piece.segments);
      }
      return clip(row.segments, cols);
    }),
    rects,
    targets,
  };
}

// ---------------------------------------------------------------------------
// The links row
// ---------------------------------------------------------------------------

/** A link's label is cut to this many cells, its `…` included. */
export const LINK_LABEL_MAX = 20;

/**
 * Every link of the session, one row (more when it doesn't fit): each service's, then the
 * workspace's, as `<label> ↗`. A link with no label of its own is labeled by its service's name, or
 * by its host. Each is an OSC 8 hyperlink, so the terminal's own gesture (Cmd+click) opens it; a
 * plain click does nothing.
 */
function linksRows(snapshot: SessionSnapshot, cols: number): FooterRow[] {
  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  const pieces: Segment[] = [
    ...[...snapshot.services, ...snapshot.infra].flatMap((s) =>
      s.links.flat().map((l) => ({ label: l.label ?? s.name, url: l.url })),
    ),
    ...snapshot.workspaceLinks.flat().map((l) => ({ label: l.label ?? host(l.url), url: l.url })),
  ].map(({ label, url }) => ({
    text: `${cutEnd(label, LINK_LABEL_MAX)} ↗`,
    color: LINK_COLOR,
    link: url,
  }));
  const rows: RowBuilder[] = [];
  for (const piece of pieces) {
    const row = rows.at(-1);
    if (row && row.used + 3 + width(piece.text) <= cols) {
      row.push(blank(3), piece);
    } else {
      const next = new RowBuilder();
      next.push(piece);
      rows.push(next);
    }
  }
  return rows.map((r) => clip(r.segments, cols));
}

// ---------------------------------------------------------------------------
// The filter row (run-screen §4.2)
// ---------------------------------------------------------------------------

function filterRow(
  input: string,
  hints: readonly HintLike[],
  cols: number,
  row: number,
): { segments: Segment[]; targets: Target[] } {
  const prompt = 'filter › ';
  const hintsRow = layoutHints(hints, Number.MAX_SAFE_INTEGER, {
    indent: 0,
    gap: 3,
    separators: false,
  });
  const hintsWidth = rowWidth(hintsRow.rows[0] ?? []);
  // The input is cut from its start, so the cursor and the newest typing stay in view.
  const room = Math.max(1, cols - width(prompt) - 1 - 6 - hintsWidth);
  const out = new RowBuilder();
  out.push({ text: prompt, dim: true }, { text: cutStart(input, room) });
  out.push({ text: '▏', color: ACCENT_COLOR }, blank(6));
  const at = out.used;
  out.push(...(hintsRow.rows[0] ?? []));
  const targets = hintTargets(
    hintsRow.placed.map((p) => ({ ...p, col: p.col + at })),
    'filter',
    () => row,
  );
  return { segments: clip(out.segments, cols), targets };
}

// ---------------------------------------------------------------------------
// The footer
// ---------------------------------------------------------------------------

/** `t` with its rect cut at the screen's right edge, or nothing when it is past it. */
function clipTarget(t: Target, cols: number): Target[] {
  if (t.rect.col > cols) {
    return [];
  }
  const w = Math.min(t.rect.width, cols - t.rect.col + 1);
  return [w === t.rect.width ? t : { ...t, rect: { ...t.rect, width: w } }];
}

function uiContext(
  snapshot: SessionSnapshot,
  entries: Entry[],
  commands: UiContext['commands'] = {},
): UiContext {
  return {
    phase: snapshot.phase,
    entries,
    rects: [],
    commands,
    hasSelection: false,
    hasStickyToast: false,
  };
}

/**
 * The footer's rows and click targets at `cols` columns: the rule line, the services row (more
 * rows when it wraps), the focus line, and the keys row (more rows when it wraps), or in filter
 * mode the filter row.
 */
export function footerLayout(
  snapshot: SessionSnapshot,
  ui: UiState,
  cols: number,
  opts: FooterOptions = {},
): FooterLayout {
  const entries = entriesOf(snapshot);
  const ctx = uiContext(snapshot, entries, opts.commands);
  const focusAt = focusIndex(ui, ctx);
  const kc = keyContext(ui, ctx);

  const rule = ruleLine(snapshot.workspace, cols);
  const services = servicesRows(snapshot, focusAt, cols, 1, opts.blinkLit ?? true);
  const keysRow = 1 + services.rows.length;
  const rows: FooterRow[] = [rule, ...services.rows];
  const targets: Target[] = [...services.targets];
  const keysOptions: HintLayoutOptions = {
    indent: 0,
    gap: 3,
    separators: true,
    headings: KEY_GROUP_HEADINGS,
    keepWithPrevious: KEY_GROUPS_KEPT_WITH_PREVIOUS,
  };
  if (ui.mode === 'filter') {
    const filter = filterRow(ui.filterDraft, hintsFor(kc), cols, keysRow);
    rows.push(filter.segments);
    targets.push(...filter.targets);
  } else {
    const keys = layoutHints(hintsFor(kc), cols, keysOptions);
    rows.push(...keys.rows);
    targets.push(...hintTargets(keys.placed, 'keys', (r) => keysRow + r));
  }
  // The keys area takes as many rows as normal mode's keys row would, so the log never reflows
  // when filter mode or the menu opens (run-screen §4.2.1, §5.2.1). With an app service focused,
  // that is the most any app service's row takes (`s stop` and `s start` differ by a cell), so
  // ←/→ in the menu never changes it either.
  const normalRows = (focus: UiState['focus']) =>
    layoutHints(
      hintsFor(keyContext({ ...ui, mode: 'normal', menu: null, focus }, ctx)),
      cols,
      keysOptions,
    ).rows.length;
  const keysArea =
    kc.focused?.kind === 'app'
      ? Math.max(
          ...entries
            .filter((e) => e.kind === 'app')
            .map((e) => normalRows({ kind: 'app', name: e.name })),
        )
      : normalRows(ui.focus);
  while (rows.length < keysRow + keysArea) {
    rows.push([]);
  }
  rows.push(...linksRows(snapshot, cols));
  return {
    rows,
    height: rows.length,
    keysRow,
    targets: targets.flatMap((t) => clipTarget(t, cols)),
    rects: services.rects,
    entries,
  };
}

// ---------------------------------------------------------------------------
// The commands menu (run-screen §5.2)
// ---------------------------------------------------------------------------

const CUSTOM_PLACEHOLDER = 'custom command…';

/**
 * The floating commands menu for the focused app service, or `null` when it isn't open. Its
 * bottom edge sits on the footer's top edge, its left edge under the focused entry, moved left
 * to keep the whole box on screen.
 */
export function menuLayout(
  snapshot: SessionSnapshot,
  ui: UiState,
  cols: number,
  opts: MenuOptions,
): MenuLayout | null {
  const entries = entriesOf(snapshot);
  const ctx = uiContext(snapshot, entries, opts.commands);
  const at = focusIndex(ui, ctx);
  const kc = keyContext(ui, ctx);
  if (ui.mode !== 'commands' || !ui.menu || at === null || kc.focused?.kind !== 'app') {
    return null;
  }
  const service = kc.focused.name;
  const scripts = opts.commands[service] ?? [];
  const { selected, custom } = ui.menu;
  const customRow = scripts.length;
  const hints = layoutHints(hintsFor(kc, 'menu'), cols - 4, {
    indent: 0,
    gap: 2,
    separators: false,
  });

  const customSelected = (room: number): Segment[] => [
    { text: '❯ ', color: FOCUS_COLOR },
    { text: '$ ' },
    ...(custom === ''
      ? [
          { text: '▏', color: FOCUS_COLOR },
          { text: CUSTOM_PLACEHOLDER, dim: true },
        ]
      : [{ text: cutStart(custom, Math.max(1, room - 5)) }, { text: '▏', color: FOCUS_COLOR }]),
  ];
  const item = (i: number, room: number): Segment[] => {
    if (i === customRow) {
      return selected === customRow
        ? customSelected(room)
        : [{ text: `  ${CUSTOM_PLACEHOLDER}`, dim: true }];
    }
    return i === selected
      ? [{ text: `❯ ${scripts[i]!}`, color: FOCUS_COLOR }]
      : [{ text: `  ${scripts[i]!}` }];
  };

  const title: Segment[] = [
    blank(1),
    { text: service, bold: true },
    { text: ' · run', dim: true },
    blank(1),
  ];
  // The custom row's placeholder counts whether or not it is selected, so moving the highlight
  // never resizes the box; only typing past it does.
  const content = Math.max(
    ...scripts.map((s) => width(`❯ ${s}`)),
    rowWidth([{ text: '❯ $ ▏' }, { text: CUSTOM_PLACEHOLDER }]),
    rowWidth(item(customRow, Infinity)),
    ...hints.rows.map(rowWidth),
  );
  const boxWidth = Math.min(cols, Math.max(content + 4, rowWidth(title) + 3));
  const inner = boxWidth - 4;
  const left = Math.max(1, Math.min(opts.rects[at]!.col, cols - boxWidth + 1));

  // The list scrolls inside the box when it can't fit, keeping the highlight in view. On a screen
  // too short for the borders, a row and the hints, the hints go (their keys still work). Below
  // 3 rows the box is taller than the room above the footer, and the screen clips its top.
  const total = customRow + 1;
  const maxRows = opts.maxRows ?? Infinity;
  const hintRows = maxRows >= 3 + hints.rows.length ? hints.rows : [];
  const visible = Math.max(1, Math.min(total, maxRows - 2 - hintRows.length));
  const start = Math.min(Math.max(0, selected - visible + 1), total - visible);

  const wall: Segment = { text: '│', color: FOCUS_COLOR };
  const boxRow = (segments: Segment[]): FooterRow => {
    const cut = cutSegmentsEnd(segments, inner);
    return [wall, blank(1), ...cut, blank(inner - rowWidth(cut) + 1), wall];
  };
  const cutTitle = cutSegmentsEnd(title, boxWidth - 3);
  const rows: FooterRow[] = [
    [
      { text: '╭', color: FOCUS_COLOR },
      ...cutTitle,
      {
        text: `${'─'.repeat(Math.max(1, boxWidth - 2 - rowWidth(cutTitle)))}╮`,
        color: FOCUS_COLOR,
      },
    ],
  ];
  for (let i = start; i < start + visible; i++) {
    rows.push(boxRow(item(i, inner)));
  }
  for (const hintRow of hintRows) {
    rows.push(boxRow(hintRow));
  }
  rows.push([{ text: `╰${'─'.repeat(boxWidth - 2)}╯`, color: FOCUS_COLOR }]);

  // Row r of the box (0 at its top) is footer row r - height: the bottom border is row -1.
  const rowOf = (r: number) => r - rows.length;
  const rect: Rect = { col: left, row: rowOf(0), width: boxWidth, height: rows.length };
  const targets: Target[] = [
    // The whole box, borders and gaps included, is the menu's: a click there that misses a row or
    // a hint reaches nothing under the box and doesn't count as outside it, so it doesn't close
    // the menu (run-screen §5.3.3). The key table has no action that does nothing, so this
    // carries an empty `custom-input`, which the reducer turns into no change.
    { id: 'menu:box', rect, action: { type: 'custom-input', text: '' } },
  ];
  for (let i = start; i < start + visible; i++) {
    targets.push({
      id: i === customRow ? 'menu:custom' : `menu:row:${i}`,
      rect: { col: left + 1, row: rowOf(1 + i - start), width: boxWidth - 2, height: 1 },
      action: i === customRow ? { type: 'custom-command' } : { type: 'run-command', row: i },
    });
  }
  if (hintRows.length > 0) {
    targets.push(
      ...hintTargets(
        hints.placed.map((p) => ({ ...p, col: p.col + left + 1 })),
        'menu',
        (r) => rowOf(1 + visible + r),
      ),
    );
  }
  return { left, width: boxWidth, rect, rows, targets };
}
