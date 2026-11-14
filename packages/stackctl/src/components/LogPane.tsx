import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Box, Text } from 'ink';
import { copyToClipboard } from '../clipboard.js';
import { computeWindow, convertOffset, windowRows } from '../log-window.js';
import { paintMatchRows } from '../match-highlight.js';
import type { MouseReport } from '../mouse.js';
import {
  FOLLOWING,
  isFollowing,
  onContentResized,
  scroll as scrollByRows,
  scrollToBottom,
  scrollToTop,
  type Scroll,
} from '../scroll.js';
import {
  classifyLine,
  highlightParts,
  isEmptySelection,
  rowSpan,
  rowWidth,
  selectionCopyText,
  valueRun,
  viewportRowIndex,
  type RowMeta,
  type Selection,
  type Span,
} from '../selection.js';
import type { LogSource } from '../session/log-store.js';
import { spansOneDay, type TsMode } from '../timestamp-mode.js';
import { DEFAULT_TOAST_MS } from '../toasts.js';
import { trackClick, wordSelectionAt, wordSpanAt, type ClickState } from '../word-select.js';
import type { Toasts } from './ToastStack.js';

export type LogViewport = {
  /**
   * Exactly the rendered rows that fit the pane — never more than `height`. Each carries the
   * columns where its content and its value begin, so selection can scope a copy to one value.
   */
  rows: RowMeta[];
  /** Flat-row index of the first rendered row (row 0 = oldest row of the whole buffer). */
  firstVisibleFlatRow: number;
  /** Whether the view is pinned to the newest output. */
  following: boolean;
  /** Rendered rows of newer output hidden below the viewport (0 while following). */
  hiddenBelow: number;
  /** Rendered rows of older output hidden above the viewport (0 when the buffer fits). */
  hiddenAbove: number;
  /**
   * The timestamp layout the rows were rendered in: `time` (just `HH:MM:SS`) while every stamp
   * on screen is from one day, `date` once two days are visible. A change is a re-flow.
   */
  tsMode: TsMode;
  /** Scroll by whole rows: positive toward older output, negative toward newest. */
  scrollLines: (delta: number) => void;
  /** Scroll by pages (a page is one viewport minus a row of overlap). */
  scrollPages: (delta: number) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
};

/**
 * A windowed (virtualized) view over a log source, such as the session's `LogStore`.
 *
 * It subscribes to the buffer, holds a scroll position, and materializes **only**
 * the rendered rows that fit the pane — so a 50k-line buffer costs the same to
 * draw as a 50-line one. Row counts are memoized per line by the source, and
 * only the handful of on-screen lines are ever wrapped into strings.
 */
export function useLogViewport(source: LogSource, width: number, height: number): LogViewport {
  const version = useSyncExternalStore(
    useCallback((onChange) => source.subscribe(onChange), [source]),
    () => source.getVersion(),
    () => source.getVersion(),
  );

  // The scroll position is kept in the **date** layout's row space — the reference layout, where
  // every line takes at least as many rows as in the narrower `time` layout — and translated into
  // whichever layout is actually rendered. Storing it in the rendered space instead would let a
  // change of layout (the date column appearing or vanishing) reflow thousands of wrapped rows
  // out from under a plain row count.
  const [scroll, setScroll] = useState<Scroll>(FOLLOWING);
  // The two layouts' row counts, for the scroll callbacks to translate with.
  const layoutRef = useRef<{ date: number[]; time: number[] }>({ date: [], time: [] });

  const { rows, dateTotalRows, dateMaxScroll, maxScroll, offset, firstVisibleFlatRow, tsMode } =
    useMemo(() => {
      const lines = source.getVisibleLines();
      const dateRows = lines.map((line) => source.countRows(line, width, 'date'));
      const timeRows = lines.map((line) => source.countRows(line, width, 'time'));
      layoutRef.current = { date: dateRows, time: timeRows };
      const dateWin = computeWindow(dateRows, height, scroll.offset);

      // Try the time-only layout first: the same bottom edge, laid out without the date column.
      // It stands if every stamp it brings on screen is from one day; otherwise the date layout
      // is rendered as-is. Either way the choice is a pure function of the stored position, so it
      // can't flip back and forth on its own.
      const timeOffset = convertOffset(dateRows, timeRows, scroll.offset);
      const timeWin = computeWindow(timeRows, height, timeOffset);
      const mode: TsMode = spansOneDay(lines, timeWin.startIndex, timeWin.endIndex)
        ? 'time'
        : 'date';
      const win = mode === 'time' ? timeWin : dateWin;
      const clampedOffset = Math.min(
        Math.max(0, mode === 'time' ? timeOffset : scroll.offset),
        win.maxScroll,
      );

      const rendered = windowRows<(typeof lines)[number], RowMeta>(
        lines,
        win,
        (line, lineIndex) => {
          // Where the value starts is a property of the *line*; where content starts is a property of
          // each rendered row (a wrapped row begins past the hanging indent).
          const { kind, valueStart } = classifyLine(line.text);
          return source.wrapLineRows(line, width, mode).map((row, r) => ({
            text: row.text,
            contentStart: row.contentStart,
            valueStart: r === 0 ? row.contentStart + valueStart : row.contentStart,
            label: row.label,
            lineIndex,
            kind,
          }));
        },
      );
      // First on-screen flat row = bottom edge (totalRows - clamped offset) minus
      // however many rows we actually rendered. Stable under appends, which is what
      // lets a content-anchored selection ride along as new output arrives.
      const firstVisible = win.totalRows - clampedOffset - rendered.length;
      return {
        rows: rendered,
        dateTotalRows: dateWin.totalRows,
        dateMaxScroll: dateWin.maxScroll,
        maxScroll: win.maxScroll,
        offset: clampedOffset,
        firstVisibleFlatRow: firstVisible,
        tsMode: mode,
      };
      // `version` is the buffer-change signal: getVisibleLines/countRows read
      // mutable source state that only changes when the version bumps.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [source, version, width, height, scroll.offset]);

  // Keep a scrolled-up view pinned to the same content as the buffer grows or
  // shrinks; stay following at the bottom otherwise. Measured in the date layout,
  // like the stored offset, so a change of timestamp layout contributes nothing.
  const prevTotalRef = useRef(dateTotalRows);
  useEffect(() => {
    const delta = dateTotalRows - prevTotalRef.current;
    prevTotalRef.current = dateTotalRows;
    if (delta !== 0) {
      setScroll((current) => onContentResized(current, delta, dateMaxScroll));
    }
  }, [dateTotalRows, dateMaxScroll]);

  // Scroll by `delta` rows *as rendered*: translate the stored position into the rendered
  // layout, move, and translate back.
  const scrollRendered = useCallback(
    (delta: number) =>
      setScroll((current) => {
        const { date, time } = layoutRef.current;
        const from = tsMode === 'time' ? convertOffset(date, time, current.offset) : current.offset;
        const moved = scrollByRows({ offset: from }, delta, maxScroll);
        const back = tsMode === 'time' ? convertOffset(time, date, moved.offset) : moved.offset;
        return back === 0 ? FOLLOWING : { offset: back };
      }),
    [tsMode, maxScroll],
  );
  const scrollLines = scrollRendered;
  const scrollPages = useCallback(
    (delta: number) => scrollRendered(delta * Math.max(1, height - 1)),
    [scrollRendered, height],
  );
  const toTop = useCallback(() => {
    setScroll(scrollToTop(dateMaxScroll));
  }, [dateMaxScroll]);
  const toBottom = useCallback(() => {
    setScroll(scrollToBottom());
  }, []);

  return {
    rows,
    firstVisibleFlatRow,
    following: isFollowing(scroll),
    hiddenBelow: offset,
    hiddenAbove: Math.max(0, maxScroll - offset),
    tsMode,
    scrollLines,
    scrollPages,
    scrollToTop: toTop,
    scrollToBottom: toBottom,
  };
}

/** A pointer (non-wheel) mouse report — what {@link useDragSelection} consumes. */
type PointerReport = Extract<MouseReport, { type: 'down' | 'move' | 'up' }>;

export type DragSelection = {
  /** Per-visible-row highlight spans, aligned to `viewport.rows` (null = no highlight). */
  highlights: (Span | null)[];
  /** Feed a pointer (press/drag/release) mouse report; maps it and updates the selection. */
  onMouse: (report: PointerReport) => void;
  /** Copy `text` to the clipboard and toast `label`, lingering the highlight as a drag-copy does. For footer click-to-copy affordances (e.g. the logfile path). */
  flashCopy: (text: string, label: string) => void;
  /** Drop any current selection (`esc`, filter change, resize, `c` — not scrolling); returns whether one was cleared. */
  clear: () => boolean;
  /**
   * Whether there is a selection, on screen or not: it is anchored to the content, so one
   * scrolled out of view is still there (the `esc` chain clears it first).
   */
  hasSelection: () => boolean;
};

/**
 * How long the highlight lingers after a copy-on-select, before it clears. Kept in
 * step with {@link DEFAULT_TOAST_MS} so the highlight and the `copied N chars`
 * toast that explains it still go away together — but they are now two timers, and
 * dismissing the toast on its own deliberately leaves the highlight up.
 */
const SELECTION_LINGER_MS = DEFAULT_TOAST_MS;

/**
 * App-managed drag-to-select over the log viewport. The selection is anchored to
 * flat-row/column content coordinates (see {@link selection.ts}), so it survives
 * scrolling and incoming logs — the two things native terminal selection can't
 * survive under our in-place repaints. Releasing a non-empty drag copies the
 * selection to the clipboard immediately (copy-on-select — no key press, since the
 * VS Code integrated terminal swallows Cmd+C before it reaches us); the highlight
 * and the "copied" flash then linger together for {@link SELECTION_LINGER_MS}
 * before clearing.
 *
 * The live selection lives in a ref (not state) so a burst of move+release events
 * arriving in a single read all see each other's updates synchronously; a reducer
 * bump forces the re-render that repaints the highlight.
 */
export function useDragSelection(opts: {
  rows: readonly RowMeta[];
  firstVisibleFlatRow: number;
  topHeight: number;
  paneHeight: number;
  /**
   * Where the `copied N chars` message goes; the toast stack owns its lifetime.
   * Taken as the two callbacks rather than the whole {@link Toasts} object on
   * purpose — that object is rebuilt every render, and `clear` is a dependency of
   * an effect in the run screen (the one clearing on a reflow), so closing over it
   * would re-run that effect on every render and drop the selection the moment it
   * was made.
   */
  notify: Toasts['notify'];
  dismiss: Toasts['dismiss'];
}): DragSelection {
  const { rows, firstVisibleFlatRow, topHeight, paneHeight, notify, dismiss } = opts;

  const selectionRef = useRef<Selection | null>(null);
  const draggingRef = useRef(false);
  // The in-progress click streak, for detecting double- and triple-clicks.
  const clickRef = useRef<ClickState>(null);
  // The selected text, captured on release (while it's fully on screen) so the
  // copy-on-select grabs exactly that even after the highlight scrolls with logs.
  const pendingTextRef = useRef<string | null>(null);
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  // The copy toast this hook currently owns, so a second copy replaces its notice
  // rather than stacking another one.
  const copyToastRef = useRef<number | null>(null);
  // Drives the post-copy highlight linger: SELECTION_LINGER_MS after a copy it
  // drops the highlight, showing you what was taken in the meantime.
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelLinger = useCallback(() => {
    if (lingerTimer.current) {
      clearTimeout(lingerTimer.current);
      lingerTimer.current = null;
    }
  }, []);

  // Retire this hook's copy toast, if it still has one up.
  const retireCopyToast = useCallback(() => {
    if (copyToastRef.current !== null) {
      dismiss(copyToastRef.current);
      copyToastRef.current = null;
    }
  }, [dismiss]);

  const clear = useCallback((): boolean => {
    cancelLinger();
    if (selectionRef.current !== null || draggingRef.current) {
      selectionRef.current = null;
      draggingRef.current = false;
      pendingTextRef.current = null;
      retireCopyToast();
      forceRender();
      return true;
    }
    return false;
  }, [cancelLinger, retireCopyToast]);

  // Copy `text` and toast `label`, keeping any current highlight up — the linger
  // timer drops it after 5s. No deselect here (unlike an explicit `clear`): the
  // highlight lingering briefly is the point, it shows you what was copied. Shared
  // by drag-release copy and footer click-to-copy.
  const flashCopy = useCallback(
    (text: string, label: string) => {
      copyToClipboard(text);
      // Copies replace rather than stack: three drags in a row are one running
      // answer to "what's on my clipboard?", not three things to read.
      retireCopyToast();
      copyToastRef.current = notify({ message: `✓ ${label} to clipboard` });
      cancelLinger();
      lingerTimer.current = setTimeout(() => {
        lingerTimer.current = null;
        selectionRef.current = null;
        draggingRef.current = false;
        pendingTextRef.current = null;
        // The toast expires on its own clock; only forget the handle, so a later
        // `clear` can't dismiss a toast some other caller has since raised.
        copyToastRef.current = null;
        forceRender();
      }, SELECTION_LINGER_MS);
    },
    [cancelLinger, retireCopyToast, notify],
  );

  const onMouse = (report: PointerReport) => {
    if (rows.length === 0) {
      return;
    }
    const rawIndex = viewportRowIndex(report.row, topHeight, paneHeight, rows.length);
    const index = Math.max(0, Math.min(rawIndex, rows.length - 1));
    const col = Math.max(0, Math.min(report.col - 1, rowWidth(rows[index]!.text)));
    const point = { flatRow: firstVisibleFlatRow + index, col };
    const metaAt = (flatRow: number): RowMeta | null => rows[flatRow - firstVisibleFlatRow] ?? null;

    // A drag between two presses is not a double-click.
    if (report.type === 'move') {
      clickRef.current = null;
    }

    if (report.type === 'down') {
      // Only clicks inside the pane start a selection — a press on the top
      // indicator or the footer (e.g. reaching for a footer link) must not.
      const inPane = report.row > topHeight && report.row <= topHeight + paneHeight;
      if (!inPane) {
        return;
      }
      // A fresh selection cancels any pending post-copy linger (so a stale 5s
      // callback can't wipe the new selection) and drops the previous toast.
      cancelLinger();
      retireCopyToast();
      const meta = rows[index]!;
      // Pressing at or past the value scopes the copy to that value; pressing on the gutter or
      // the key is the escape hatch back to copying the rows exactly as shown.
      const scoped = col >= meta.valueStart;
      const flatRun = scoped
        ? (() => {
            const run = valueRun(index, (r) => rows[r] ?? null, rows.length);
            return { start: firstVisibleFlatRow + run.start, end: firstVisibleFlatRow + run.end };
          })()
        : null;

      // Multi-click is timed here rather than read off the report: the SGR protocol
      // carries no click count. The cell is tracked in *content* coordinates, so a
      // wheel scroll between two presses lands on a different row and breaks the
      // streak, exactly as it should.
      const { state, count } = trackClick(
        clickRef.current,
        { col, row: point.flatRow },
        Date.now(),
      );
      clickRef.current = state;

      if (count >= 2) {
        const ends: Pick<Selection, 'anchor' | 'focus'> | null =
          count === 2
            ? (() => {
                // Look the word up across every row this logical line wrapped onto, so
                // a URI or path the terminal broke in half still selects whole.
                let from = index;
                while (from > 0 && rows[from - 1]!.lineIndex === meta.lineIndex) {
                  from--;
                }
                let to = index;
                while (to + 1 < rows.length && rows[to + 1]!.lineIndex === meta.lineIndex) {
                  to++;
                }
                const wrapped = wordSelectionAt(
                  rows.slice(from, to + 1).map((row, i) => ({
                    flatRow: firstVisibleFlatRow + from + i,
                    contentStart: row.contentStart,
                    text: row.text,
                  })),
                  point,
                );
                if (wrapped) {
                  return wrapped;
                }
                // Pressed in the gutter (or the hanging indent) — still worth a word,
                // it's how the `[package]` name and the timestamp select.
                const span = wordSpanAt(meta.text, col);
                return (
                  span && {
                    anchor: { flatRow: point.flatRow, col: span.start },
                    focus: { flatRow: point.flatRow, col: span.end },
                  }
                );
              })()
            : (() => {
                // Triple-click (and any faster repeat, which just re-runs it): the
                // whole line — the value it belongs to when the press was inside the
                // value, else the row exactly as rendered.
                const lastRow = flatRun ? flatRun.end : point.flatRow;
                return {
                  anchor: { flatRow: flatRun ? flatRun.start : point.flatRow, col: 0 },
                  focus: { flatRow: lastRow, col: rowWidth((metaAt(lastRow) ?? meta).text) },
                };
              })();
        if (ends) {
          const selection: Selection = {
            ...ends,
            mode: scoped ? 'value' : 'wysiwyg',
            run: flatRun,
          };
          // Nothing to wait for — there's no drag to release, so copy right away and
          // leave `dragging` false, which no-ops the trailing `up`.
          selectionRef.current = selection;
          draggingRef.current = false;
          const text = selectionCopyText(selection, metaAt);
          pendingTextRef.current = text.length > 0 ? text : null;
          if (pendingTextRef.current) {
            const chars = pendingTextRef.current.length;
            flashCopy(pendingTextRef.current, `copied ${chars} char${chars === 1 ? '' : 's'}`);
          }
          forceRender();
          return;
        }
        // Double-clicked whitespace or a bracket — no word to take, so fall through
        // and behave like a plain press.
      }

      selectionRef.current = {
        anchor: point,
        focus: point,
        mode: scoped ? 'value' : 'wysiwyg',
        run: flatRun,
      };
      draggingRef.current = true;
      pendingTextRef.current = null;
      forceRender();
      return;
    }

    if (!draggingRef.current || !selectionRef.current) {
      return;
    }

    selectionRef.current = { ...selectionRef.current, focus: point };

    if (report.type === 'up') {
      draggingRef.current = false;
      const selection = selectionRef.current;
      if (isEmptySelection(selection)) {
        selectionRef.current = null; // a plain click clears the selection
        pendingTextRef.current = null;
      } else {
        // Capture the text now (fully on screen), then copy it immediately.
        const text = selectionCopyText(selection, metaAt);
        pendingTextRef.current = text.length > 0 ? text : null;
        if (pendingTextRef.current) {
          const chars = pendingTextRef.current.length;
          flashCopy(pendingTextRef.current, `copied ${chars} char${chars === 1 ? '' : 's'}`);
        }
      }
    }
    forceRender();
  };

  useEffect(
    () => () => {
      if (lingerTimer.current) {
        clearTimeout(lingerTimer.current);
      }
    },
    [],
  );

  const selection = selectionRef.current;
  const highlights = rows.map((row, i) =>
    selection
      ? rowSpan(selection, firstVisibleFlatRow + i, rowWidth(row.text), row.valueStart)
      : null,
  );
  const hasSelection = useCallback(() => selectionRef.current !== null, []);
  return { highlights, onMouse, flashCopy, clear, hasSelection };
}

/** One rendered row with a selection highlight: colored pre/post, inverted (plain) middle. */
function HighlightedRow({ row, span }: { row: string; span: Span }) {
  const { pre, mid, post } = highlightParts(row, span);
  return (
    <Text wrap="truncate-end">
      {pre}
      <Text inverse>{mid}</Text>
      {post}
    </Text>
  );
}

const NO_TERMS: readonly string[] = [];

/**
 * Presentational log viewport: renders the pre-windowed rows bottom-aligned (so
 * the newest output sits just above the footer). Rows are already wrapped to the
 * terminal width, so each is truncated rather than re-wrapped by Ink. The filter's
 * `terms` are painted where they occur in a row's content, and rows the selection
 * covers get a `highlights` span rendered as an inverted range over that.
 */
export function LogPane({
  rows,
  highlights,
  terms = NO_TERMS,
}: {
  rows: readonly RowMeta[];
  highlights?: readonly (Span | null)[];
  /** The applied filter's terms, as `filterTerms` splits them. */
  terms?: readonly string[];
}) {
  const texts = useMemo(() => paintMatchRows(rows, terms), [rows, terms]);
  return (
    <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
      {texts.map((text, i) => {
        const span = highlights?.[i] ?? null;
        // The whole window re-renders together, so positional keys are fine here.
        return span ? (
          <HighlightedRow key={i} row={text} span={span} />
        ) : (
          <Text key={i} wrap="truncate-end">
            {text}
          </Text>
        );
      })}
    </Box>
  );
}
