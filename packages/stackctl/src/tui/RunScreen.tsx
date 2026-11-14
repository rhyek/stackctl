import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, type DOMElement, useInput, useStdin, useStdout, useWindowSize } from 'ink';
import { WARN_COLOR } from '../colors.js';
import { BottomChrome } from '../components/BottomChrome.js';
import { LogPane, useDragSelection, useLogViewport } from '../components/LogPane.js';
import { useToasts } from '../components/ToastStack.js';
import { MOUSE_DISABLE } from '../mouse.js';
import type { Session } from '../session/session.js';
import { type ActionDeps, type ConfirmToasts, guard, logError, runEffects } from './actions.js';
import { CommandsMenu } from './CommandsMenu.js';
import { Footer } from './Footer.js';
import { FooterBoundary, guardedFooterLayout, guardedMenuLayout } from './FooterBoundary.js';
import { resolveKey } from './keymap.js';
import { hasBlinkingDot } from './layout.js';
import { screenTargets } from './screen-targets.js';
import { hardExit, useShutdown } from './shutdown.js';
import { filterTerms } from './text-cells.js';
import { type UiContext, type UiEvent, initialUiState, keyContext, step } from './ui-state.js';
import { useExpiry } from './use-expiry.js';
import { useMouse } from './use-mouse.js';
import { useSessionSnapshot } from './use-session.js';

const MemoFooter = memo(Footer);
const MemoMenu = memo(CommandsMenu);

/** Rows one wheel notch scrolls. */
const WHEEL_ROWS = 3;

/** How long a blinking dot stays lit, then dimmed. */
const BLINK_MS = 500;

/**
 * The run screen: the log pane, the toasts and the jump row, the footer and the floating commands
 * menu, over one session. Composition only: the layout is `layout.ts`'s, the keys `keymap.ts`'s,
 * the state `ui-state.ts`'s, the effects `actions.ts`'s, the mouse `use-mouse.ts`'s and the exit
 * `shutdown.ts`'s. The session starts after the first frame, so the footer is up before anything
 * runs.
 */
export function RunScreen({ session }: { session: Session }): React.ReactElement {
  const { columns, rows } = useWindowSize();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  // First, so its session subscription comes first: the mouse is released before the screen
  // collapses to its shutting-down line (run-screen §9.2.1).
  useShutdown(session, stdout);
  const snapshot = useSessionSnapshot(session);
  const { commands } = session;
  const toasts = useToasts();
  const [ui, setUi] = useState(initialUiState);
  const uiRef = useRef(ui);
  const confirmToasts = useRef<ConfirmToasts>({ quit: null, reset: null });
  const jumpRef = useRef<DOMElement>(null);

  // A dot on its way blinks: lit and dimmed every BLINK_MS, the clock running only while one does.
  const blinking = hasBlinkingDot(snapshot);
  const [blinkLit, setBlinkLit] = useState(true);
  useEffect(() => {
    setBlinkLit(true);
    if (!blinking) {
      return;
    }
    const timer = setInterval(() => setBlinkLit((lit) => !lit), BLINK_MS);
    return () => clearInterval(timer);
  }, [blinking]);
  const footer = useMemo(
    () => guardedFooterLayout(session, snapshot, ui, columns, { commands, blinkLit }),
    [session, snapshot, ui, columns, commands, blinkLit],
  );
  const menu = useMemo(
    () =>
      guardedMenuLayout(session, snapshot, ui, columns, {
        commands,
        rects: footer.rects,
        maxRows: rows - footer.height,
      }),
    [session, snapshot, ui, columns, commands, footer, rows],
  );

  // The indicator rows above and below the pane, as the last frame had them: the pane's height
  // depends on them and they on the pane, so a change settles in one more render.
  const [chrome, setChrome] = useState({ above: 0, below: 0 });
  const paneHeight = Math.max(0, rows - footer.height - chrome.above - chrome.below);
  const viewport = useLogViewport(session.logs, columns, paneHeight);
  const above = viewport.hiddenAbove > 0 ? 1 : 0;
  const below = viewport.hiddenBelow > 0 ? 1 : 0;
  useEffect(() => {
    if (above !== chrome.above || below !== chrome.below) {
      setChrome({ above, below });
    }
  }, [above, below, chrome]);

  const selection = useDragSelection({
    rows: viewport.rows,
    firstVisibleFlatRow: viewport.firstVisibleFlatRow,
    topHeight: above,
    paneHeight,
    notify: toasts.notify,
    dismiss: toasts.dismiss,
  });

  // What handlers read: always this render's, whatever closure they run in.
  const live = useRef({ snapshot, footer, menu, toasts, selection, viewport, rows });
  live.current = { snapshot, footer, menu, toasts, selection, viewport, rows };

  const context = useCallback((): UiContext => {
    const l = live.current;
    return {
      phase: l.snapshot.phase,
      entries: l.footer.entries,
      rects: l.footer.rects,
      commands,
      hasSelection: l.selection.hasSelection(),
      hasStickyToast: l.toasts.toasts.some((t) => t.duration === 'sticky'),
    };
  }, [commands]);

  const dispatch = useCallback(
    (event: UiEvent) => {
      guard(session, 'handle input', () => {
        const result = step(uiRef.current, event);
        if (result.state !== uiRef.current) {
          uiRef.current = result.state;
          setUi(result.state);
        }
        const l = live.current;
        const deps: ActionDeps = {
          session,
          toasts: l.toasts,
          selection: l.selection,
          viewport: l.viewport,
          confirmToasts: confirmToasts.current,
          releaseMouse: () => stdout.write(MOUSE_DISABLE),
          hardExit,
        };
        runEffects(result.effects, deps);
      });
    },
    [session, stdout],
  );

  const expire = useCallback((at: number) => dispatch({ type: 'expire', at }), [dispatch]);
  useExpiry(ui, expire);

  const mouse = useMouse(
    snapshot.phase !== 'stopping',
    { stdin, stdout },
    {
      targets: () => {
        const l = live.current;
        return screenTargets({
          footer: l.footer,
          menu: l.menu,
          rows: l.rows,
          jump: jumpRef.current,
          toasts: l.toasts.targets.current.values(),
          reset: confirmToasts.current.reset,
        });
      },
      onClick: (target) => {
        const at = Date.now();
        if (target?.press) {
          // A toast's own button: the click still disarms, and the button acts in normal mode only.
          dispatch({ type: 'click', action: null, at, ctx: context() });
          if (uiRef.current.mode === 'normal') {
            guard(session, 'press a toast button', target.press);
          }
          return;
        }
        dispatch({ type: 'click', action: target?.action ?? null, at, ctx: context() });
      },
      onWheel: (dir) => live.current.viewport.scrollLines(dir === 'up' ? WHEEL_ROWS : -WHEEL_ROWS),
      onPointer: (report) => live.current.selection.onMouse(report),
      onError: (err) => logError(session, 'handle the mouse', err),
    },
  );

  useInput((input, key) => {
    if (mouse.dropKey()) {
      return;
    }
    guard(session, 'handle a key', () => {
      const ctx = context();
      const action = resolveKey(keyContext(uiRef.current, ctx), input, key);
      if (action) {
        dispatch({ type: 'key', action, at: Date.now(), ctx });
      }
    });
  });

  // A reflow points a selection at other text: a resize, or the timestamp column coming or going.
  const { clear: clearSelection } = selection;
  const reflow = `${String(columns)}x${String(rows)}:${viewport.tsMode}`;
  const lastReflow = useRef(reflow);
  useEffect(() => {
    if (lastReflow.current !== reflow) {
      lastReflow.current = reflow;
      clearSelection();
    }
  }, [reflow, clearSelection]);

  useEffect(() => {
    guard(session, 'start the session', () => session.start());
  }, [session]);

  const menuElement = useMemo(() => <MemoMenu menu={menu} />, [menu]);
  const terms = useMemo(() => filterTerms(ui.filter), [ui.filter]);

  if (snapshot.phase === 'stopping') {
    // Not fullscreen: a fullscreen last frame would have Ink clear the screen on unmount.
    return <Text color={WARN_COLOR}>Shutting down… (press Ctrl+C again to force kill)</Text>;
  }
  const hidden = viewport.hiddenAbove;
  return (
    <Box flexDirection="column" width="100%" height={rows} overflow="hidden">
      {above > 0 && (
        <Box justifyContent="center" flexShrink={0}>
          <Text dimColor>
            {`↑ ${String(hidden)} older line${hidden === 1 ? '' : 's'} — press Home to jump to oldest`}
          </Text>
        </Box>
      )}
      <LogPane rows={viewport.rows} highlights={selection.highlights} terms={terms} />
      <BottomChrome toasts={toasts} hiddenBelow={viewport.hiddenBelow} jumpToLatestRef={jumpRef}>
        <FooterBoundary session={session} layout={footer}>
          <MemoFooter layout={footer}>{menuElement}</MemoFooter>
        </FooterBoundary>
      </BottomChrome>
    </Box>
  );
}
