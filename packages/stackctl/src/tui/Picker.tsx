import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, useInput, useStdin, useStdout, useWindowSize } from 'ink';
import { BottomChrome } from '../components/BottomChrome.js';
import { useToasts } from '../components/ToastStack.js';
import { debugLog } from '../internal-logger.js';
import { SegmentLine } from './KeysRow.js';
import { pickerLayout } from './picker-layout.js';
import {
  type PickerEffect,
  type PickerEvent,
  type PickerInput,
  type SelectionRuns,
  createPickerState,
  pickerStep,
} from './picker-state.js';
import { type ClickTarget, elementRect, useMouse } from './use-mouse.js';

/** One cell of slack on each side of a toast button, as on the run screen. */
const TOAST_SLACK = 1;

export interface PickerProps {
  /** The services, the saved selection and the rule line's workspace. Read once, at mount. */
  input: PickerInput;
  /** The selection plan for the picks: what the "will start" line lists. */
  plan: (picked: readonly string[]) => SelectionRuns;
  /** Saves the picks as the last selection; runs just before `onStart`. */
  onSave: (names: string[]) => void;
  /** Starts the session with the picks, in the list's order. */
  onStart: (names: string[]) => void;
  /** Leaves the picker, and stackctl with it. */
  onExit: () => void;
}

/** What an effect does, for the debug log's line when it fails. */
function effectName(effect: PickerEffect): string {
  switch (effect.type) {
    case 'toast':
      return 'show a toast';
    case 'save-selection':
      return 'save the selection';
    case 'start':
      return 'start the session';
    case 'quit':
      return 'quit';
  }
}

/** Logs a fault to the internal debug log: no session log exists yet (picker §9.3). */
function logFault(what: string, err: unknown): void {
  debugLog(`picker: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
}

/** Runs `fn`, logging a throw instead of letting it through; the picker stays as it was. */
function safely(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logFault(what, err);
  }
}

/**
 * The service picker: keys, clicks, the wheel and resizes go to `pickerStep`, `pickerLayout`'s
 * rows are drawn, and each effect is carried out once. It takes the mouse while mounted, through
 * the run screen's hook, and releases it on unmount, so every way out of the picker releases it.
 */
export function Picker({ input, plan, onSave, onStart, onExit }: PickerProps): React.ReactElement {
  const { columns, rows } = useWindowSize();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const toasts = useToasts();
  const [state, setState] = useState(() => createPickerState(input));
  const stateRef = useRef(state);
  const lastToast = useRef<number | null>(null);
  // Set by the first start: the picker is on its way out, and a second Enter or `⏎ start` that
  // lands before the run screen replaces it must neither save again nor make a second session.
  const leaving = useRef(false);

  const runs = useMemo(() => plan(state.picked), [plan, state.picked]);
  const layout = useMemo(
    () => pickerLayout(state, input, columns, rows, runs),
    [state, input, columns, rows, runs],
  );

  // What handlers read: always this render's, whatever closure they run in.
  const live = useRef({ layout, toasts, onSave, onStart, onExit });
  live.current = { layout, toasts, onSave, onStart, onExit };

  const runEffect = useCallback((effect: PickerEffect) => {
    const l = live.current;
    switch (effect.type) {
      case 'toast':
        // A repeat replaces the toast on screen instead of stacking (picker §7.3.2).
        if (lastToast.current !== null) {
          l.toasts.dismiss(lastToast.current);
        }
        lastToast.current = l.toasts.notify({ message: effect.text, tone: effect.tone });
        return;
      case 'save-selection':
        if (!leaving.current) {
          l.onSave(effect.names);
        }
        return;
      case 'start':
        if (!leaving.current) {
          leaving.current = true;
          l.onStart(effect.names);
        }
        return;
      case 'quit':
        l.onExit();
        return;
    }
  }, []);

  const dispatch = useCallback(
    (event: PickerEvent) => {
      safely('handle input', () => {
        const result = pickerStep(stateRef.current, event);
        if (result.state !== stateRef.current) {
          stateRef.current = result.state;
          setState(result.state);
        }
        for (const effect of result.effects) {
          safely(effectName(effect), () => runEffect(effect));
        }
      });
    },
    [runEffect],
  );

  // The list's height depends on how the bottom block wraps: fed back once the frame shows it.
  // The layout clamps the window meanwhile, so the frame is right before this lands.
  useEffect(() => {
    if (layout.listRows !== stateRef.current.listRows) {
      dispatch({ type: 'resize', listRows: layout.listRows });
    }
  }, [layout.listRows, dispatch]);

  // Declared before `useInput`, as on the run screen: its cleanup runs first on the way out.
  const mouse = useMouse(
    true,
    { stdin, stdout },
    {
      targets: () => {
        // The run screen's targets carry its own actions; the picker's dispatch theirs on press.
        const targets: ClickTarget[] = live.current.layout.targets.map((t) => ({
          id: t.id,
          rect: t.rect,
          press: () => dispatch({ type: 'click', action: t.action, at: Date.now() }),
        }));
        for (const toast of live.current.toasts.targets.current.values()) {
          const rect = elementRect(toast.node, TOAST_SLACK);
          if (rect) {
            const id = `toast:${String(toast.toastId)}:${String(toast.index)}`;
            targets.push({ id, rect, press: toast.press });
          }
        }
        return targets;
      },
      onClick: (target) => {
        if (target?.press) {
          target.press();
          return;
        }
        dispatch({ type: 'click', action: null, at: Date.now() });
      },
      onWheel: (dir) => dispatch({ type: 'wheel', delta: dir === 'up' ? -1 : 1, at: Date.now() }),
      // The picker has no drag selection.
      onPointer: () => {},
      onError: (err) => logFault('handle the mouse', err),
    },
  );

  useInput((text, key) => {
    if (mouse.dropKey()) {
      return;
    }
    dispatch({ type: 'key', input: text, key, at: Date.now() });
  });

  // The bottom rule and below: the toasts float just above it, as above the run screen's footer.
  const top = layout.rows.slice(0, layout.bottomRule);
  const bottom = layout.rows.slice(layout.bottomRule);
  return (
    <Box flexDirection="column" width="100%" height={rows} overflow="hidden">
      <Box flexDirection="column" flexShrink={0}>
        {top.map((row, i) => (
          <SegmentLine key={i} segments={row} />
        ))}
      </Box>
      <BottomChrome toasts={toasts} hiddenBelow={0}>
        <Box flexDirection="column" flexShrink={0}>
          {bottom.map((row, i) => (
            <SegmentLine key={i} segments={row} />
          ))}
        </Box>
      </BottomChrome>
    </Box>
  );
}
