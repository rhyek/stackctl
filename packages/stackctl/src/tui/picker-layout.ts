import { BRANCH_COLOR, FOCUS_COLOR, NEEDED_COLOR, WARN_COLOR, WORKSPACE_COLOR } from '../colors.js';
import type { Rect } from './hit-test.js';
import {
  BRANCH_MIN,
  type FooterRow,
  type HintLike,
  MIN_FILL,
  RULE_TAIL,
  layoutHints,
} from './layout.js';
import {
  type PickerAction,
  type PickerHint,
  type PickerInput,
  type PickerService,
  type PickerState,
  type SelectionRuns,
  isLocked,
  isPicked,
  modeOf,
  neededBy,
  pickerHints,
  rowsOf,
  visibleRows,
  willStart,
  windowTop,
} from './picker-state.js';
import {
  RowBuilder,
  type Segment,
  blank,
  clip,
  cutEnd,
  cutStart,
  joinNames,
  rowWidth,
  width,
} from './text-cells.js';

/**
 * The service picker laid out as plain data: rows of styled segments filling the viewport, and
 * the click targets over the exact cells those segments take. Pure: no Ink, no clock.
 *
 * Top to bottom: the rule line; the keys row, or the filter row while the input is open; a blank
 * row (the `↑ n more` indicator); the list's window; a blank row (the `↓ n more` indicator); the
 * bottom rule; the "will start" line. Coordinates are the screen's, 1-based, as an SGR
 * mouse report gives them.
 */

export interface PickerTarget {
  /** Stable across layouts for the same thing, so a press and its release can be compared. */
  id: string;
  rect: Rect;
  action: PickerAction;
}

export interface PickerLayout {
  /** One per screen row: the picker fills the viewport, and a screen too short clips it. */
  rows: FooterRow[];
  targets: PickerTarget[];
  /** How many list rows fit; feed it back as a `resize` event when it changes. */
  listRows: number;
  /** The bottom rule's index in `rows`: the bottom block starts there, and toasts float above it. */
  bottomRule: number;
}

// ---------------------------------------------------------------------------
// The rule line (picker §3.2)
// ---------------------------------------------------------------------------

const RULE_HEAD = '──';
const TITLE = 'choose services';

function ruleLine(workspace: PickerInput['workspace'], cols: number): Segment[] {
  // `────`, the fill and ` choose services ──` always; the workspace part costs its own cells
  // plus a space on each side.
  const fixed = width(RULE_HEAD) + MIN_FILL + 1 + width(TITLE) + 1 + width(RULE_TAIL);
  const wsWidth = (name: string, branch: string | null) =>
    width(name) + (branch === null ? 0 : 3 + width(branch)) + 2;
  const room = cols - fixed;
  let name = workspace.name;
  let branch = workspace.branch;
  // The truncation steps, each tried only if the one before wasn't enough.
  if (wsWidth(name, branch) > room && branch !== null) {
    const branchRoom = width(branch) - (wsWidth(name, branch) - room);
    branch = branchRoom >= BRANCH_MIN ? cutEnd(branch, branchRoom) : null;
  }
  if (wsWidth(name, branch) > room) {
    name = cutEnd(name, room - 2);
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
  const fill = Math.max(MIN_FILL, cols - fixed + MIN_FILL - rowWidth(ws));
  return clip(
    [
      { text: RULE_HEAD, dim: true },
      ...ws,
      { text: '─'.repeat(fill), dim: true },
      blank(1),
      { text: TITLE, bold: true },
      blank(1),
      { text: RULE_TAIL, dim: true },
    ],
    cols,
  );
}

// ---------------------------------------------------------------------------
// The list (picker §3.3–§3.5)
// ---------------------------------------------------------------------------

/** The cursor at cell 3, the marker at 5, the name at 7. */
const NAME_COL = 7;
/** Blank cells between the widest name and the notes column. */
const NOTES_GAP = 4;

function noteOf(state: PickerState, service: PickerService): string {
  return isLocked(state, service.name)
    ? `needed by ${joinNames(neededBy(state, service.name))}`
    : '';
}

function marker(state: PickerState, name: string): Segment {
  if (isLocked(state, name)) {
    return { text: '◉', color: NEEDED_COLOR };
  }
  return isPicked(state, name) ? { text: '◉', color: FOCUS_COLOR } : { text: '○' };
}

function listRow(
  state: PickerState,
  service: PickerService,
  notesCol: number,
  cols: number,
): Segment[] {
  const atCursor = service.name === state.cursor;
  const line = new RowBuilder();
  line.push(
    blank(2),
    atCursor ? { text: '❯', color: FOCUS_COLOR } : blank(1),
    blank(1),
    marker(state, service.name),
    blank(1),
    atCursor ? { text: service.name, color: FOCUS_COLOR } : { text: service.name },
  );
  const note = noteOf(state, service);
  if (note !== '' && notesCol <= cols) {
    line.padTo(notesCol);
    line.push({ text: cutEnd(note, cols - notesCol + 1), dim: true });
  }
  return clip(line.segments, cols);
}

function indicator(arrow: '↑' | '↓', hidden: number): Segment[] {
  return hidden > 0 ? [blank(2), { text: `${arrow} ${hidden} more`, dim: true }] : [];
}

// ---------------------------------------------------------------------------
// The "will start" line (picker §3.6.2)
// ---------------------------------------------------------------------------

const WILL_START = 'will start';
const SEPARATOR: Segment = { text: ' · ', dim: true };
/** Between the services and the infra: the keys row's group separator. */
const INFRA_SEPARATOR: Segment[] = [blank(3), { text: '│', dim: true }, blank(3)];

function willStartRows(
  state: PickerState,
  infra: readonly string[],
  cols: number,
  runs: SelectionRuns | undefined,
): FooterRow[] {
  const head: Segment[] = [blank(2), { text: WILL_START, dim: true }, blank(2)];
  if (state.picked.length === 0) {
    return [clip([...head, { text: 'nothing selected', dim: true }], cols)];
  }
  const indent = rowWidth(head);
  const lines: RowBuilder[] = [];
  let line!: RowBuilder;
  const newLine = (first: Segment[]) => {
    line = new RowBuilder();
    line.push(...first);
    lines.push(line);
  };
  newLine(head);
  const atStart = () => line.used === indent;
  /** Places `segments` after `lead`, or at the start of a new row when they don't fit. */
  const place = (lead: Segment[], segments: Segment[]) => {
    if (!atStart() && line.used + rowWidth(lead) + rowWidth(segments) > cols) {
      newLine([blank(indent)]);
    }
    line.push(...(atStart() ? [] : lead), ...segments);
  };
  for (const { name, stopped } of willStart(state, runs)) {
    place(
      [SEPARATOR],
      stopped ? [{ text: name }, { text: ' (stopped)', dim: true }] : [{ text: name }],
    );
  }
  infra.forEach((name, i) => {
    if (i === 0) {
      // `infra` stays on the row of the first infra name.
      place(INFRA_SEPARATOR, [{ text: 'infra:', dim: true }, blank(1), { text: name }]);
    } else {
      place([SEPARATOR], [{ text: name }]);
    }
  });
  return lines.map((l) => clip(l.segments, cols));
}

// ---------------------------------------------------------------------------
// The keys row and the filter row (picker §3.6.4, §6.2.1)
// ---------------------------------------------------------------------------

const HINTS = { indent: 2, gap: 2, separators: false };

/** The hints laid out by `layoutHints`, with each hint's target at its drawn cells. */
function hintRows(
  hints: readonly PickerHint[],
  cols: number,
  firstRow: number,
  colOffset = 0,
  opts = HINTS,
): { rows: FooterRow[]; targets: PickerTarget[] } {
  const actions = new Map<HintLike, PickerAction>();
  const likes = hints.map((h) => {
    const like: HintLike = { key: h.key, label: h.label, group: h.group, disabled: h.disabled };
    if (h.detail !== undefined) {
      like.detail = h.detail;
    }
    actions.set(like, h.action);
    return like;
  });
  const laid = layoutHints(likes, cols, opts);
  const targets = laid.placed.map((p) => ({
    id: `hint:${p.hint.key} ${p.hint.label}`,
    rect: { col: p.col + colOffset, row: firstRow + p.row, width: p.width, height: 1 },
    action: actions.get(p.hint)!,
  }));
  return { rows: laid.rows, targets };
}

function filterRow(
  state: PickerState,
  cols: number,
  row: number,
): { segments: Segment[]; targets: PickerTarget[] } {
  const prompt = 'filter › ';
  const hints = hintRows(pickerHints(state), Number.MAX_SAFE_INTEGER, row, 0, {
    ...HINTS,
    indent: 0,
  });
  const hintsWidth = rowWidth(hints.rows[0] ?? []);
  // The text is cut from its start, so the cursor and the newest typing stay in view.
  const room = Math.max(1, cols - 2 - width(prompt) - 1 - 6 - hintsWidth);
  const line = new RowBuilder();
  line.push(blank(2), { text: prompt, dim: true }, { text: cutStart(state.input ?? '', room) });
  line.push({ text: '▏', color: FOCUS_COLOR }, blank(6));
  const at = line.used;
  line.push(...(hints.rows[0] ?? []));
  return {
    segments: clip(line.segments, cols),
    targets: hints.targets.map((t) => ({ ...t, rect: { ...t.rect, col: t.rect.col + at } })),
  };
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

/** `t` cut at the screen's right and bottom edges, or nothing when it is past them. */
function clipTarget(t: PickerTarget, cols: number, rows: number): PickerTarget[] {
  if (t.rect.col > cols || t.rect.row > rows) {
    return [];
  }
  const w = Math.min(t.rect.width, cols - t.rect.col + 1);
  return [w === t.rect.width ? t : { ...t, rect: { ...t.rect, width: w } }];
}

/**
 * The picker at `cols` × `rows`: every row of the screen, and the click targets over them.
 * `runs` is the selection plan for `state.picked`, for the "will start" line; without it the
 * line follows the services' own `deps`.
 */
export function pickerLayout(
  state: PickerState,
  input: PickerInput,
  cols: number,
  rows: number,
  runs?: SelectionRuns,
): PickerLayout {
  // The bottom block first: its height decides how many list rows fit.
  const willRows = willStartRows(state, input.infra, cols, runs);
  const listMode = { ...state, input: null };
  const keysArea = hintRows(pickerHints(listMode), cols, 0).rows.length;
  const listRows = Math.max(0, rows - 3 - (1 + willRows.length + keysArea));

  const out: FooterRow[] = [ruleLine(input.workspace, cols)];
  const targets: PickerTarget[] = [];

  // The keys row, or the filter row while the input is open, right under the rule line.
  const keysRow = out.length + 1;
  if (modeOf(state) === 'filter') {
    const filter = filterRow(state, cols, keysRow);
    out.push(filter.segments);
    targets.push(...filter.targets);
    // The row count doesn't change while the input is open.
    for (let i = 1; i < keysArea; i++) {
      out.push([]);
    }
  } else {
    const keys = hintRows(pickerHints(state), cols, keysRow);
    out.push(...keys.rows);
    targets.push(...keys.targets);
  }

  const all = rowsOf(state);
  const visible = visibleRows(state);
  const cursorAt = visible.findIndex((s) => s.name === state.cursor);
  const top = windowTop(state.scroll, cursorAt, listRows, visible.length);
  const shown = visible.slice(top, top + listRows);
  out.push(indicator('↑', top));
  const widest = Math.max(0, ...all.map((s) => width(s.name)));
  const notesCol = NAME_COL + widest + NOTES_GAP;
  const list: FooterRow[] = shown.map((service, i) => {
    targets.push({
      id: `row:${service.name}`,
      rect: { col: 1, row: out.length + 1 + i, width: cols, height: 1 },
      action: { type: 'row', name: service.name },
    });
    return listRow(state, service, notesCol, cols);
  });
  if (all.length === 0) {
    list.push(
      clip([blank(2), { text: 'No selectable services configured.', color: WARN_COLOR }], cols),
    );
  } else if (visible.length === 0) {
    list.push(clip([blank(2), { text: 'no services match', dim: true }], cols));
  }
  for (let i = 0; i < listRows; i++) {
    out.push(list[i] ?? []);
  }
  out.push(indicator('↓', visible.length - top - shown.length));

  const bottomRule = out.length;
  out.push([{ text: '─'.repeat(cols), dim: true }], ...willRows);

  while (out.length < rows) {
    out.push([]);
  }
  return {
    rows: out.slice(0, rows),
    targets: targets.flatMap((t) => clipTarget(t, cols, rows)),
    listRows,
    bottomRule,
  };
}
