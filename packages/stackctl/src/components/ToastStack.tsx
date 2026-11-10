import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, type DOMElement } from 'ink';
import { DANGER_COLOR, LINK_COLOR, NOTICE_COLOR, OK_COLOR, WARN_COLOR } from '../colors.js';
import {
  addToast,
  createToast,
  dismissToast,
  newestSticky,
  type Toast,
  type ToastOptions,
  type ToastTone,
} from '../toasts.js';

/**
 * What a tone is drawn in. Lives here rather than in `colors.ts` for the same
 * reason the status colors do: this is a meaning-to-color mapping, and the palette
 * file answers only "what color is that?".
 *
 * `info` is the plain "stackctl did the thing you asked" notice — `copied N chars`
 * is the archetype. It's the one tone with a color of its own: the other three
 * borrow the status palette, which is what makes them read as good/bad news at a
 * glance, and is exactly why `info` can't (it is neither).
 */
const TONE_COLORS: Record<ToastTone, string> = {
  info: NOTICE_COLOR,
  success: OK_COLOR,
  warn: WARN_COLOR,
  error: DANGER_COLOR,
};

/**
 * A clickable toast action, registered while it is on screen. The run screen
 * hit-tests these against mouse presses alongside its other click targets.
 */
export type ToastTarget = {
  /** The toast the button belongs to. */
  toastId: number;
  /** The button's position among its toast's actions. */
  index: number;
  /** The rendered `[label]` box, whose screen rect the press is tested against. */
  node: DOMElement;
  /** Runs the action and then dismisses its toast. */
  press: () => void;
};

/** The toast stack's public surface: what's up, and how to add to or clear it. */
export type Toasts = {
  /** Currently on screen, oldest first. */
  toasts: readonly Toast[];
  /** Show a toast; returns its id, the handle for {@link dismiss}. */
  notify: (options: ToastOptions) => number;
  /** Take a toast down early. A no-op if it has already gone. */
  dismiss: (id: number) => void;
  /**
   * Take the newest **sticky** toast down; returns whether there was one. This is
   * the `esc` chain's hook — transient toasts are skipped on purpose, so a passing
   * notice never swallows an `esc` meant for what's underneath it.
   */
  dismissNewestSticky: () => boolean;
  /** Live action click targets; read each one's `toastId` and `index`, not its key. */
  targets: React.RefObject<Map<string, ToastTarget>>;
};

/**
 * Owns the toast stack: ids, expiry timers, and the action click targets. The
 * policy — ordering, the cap, which toast gives way — is pure and lives in
 * `toasts.ts`.
 *
 * Plain `useState` is enough here (unlike `useDragSelection`'s refs, which exist
 * so a burst of mouse reports in one input read see each other): toasts are never
 * added and read back within a single event, and the functional updates below
 * compose correctly if two arrive together.
 */
export function useToasts(): Toasts {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);
  // Expiry timers by toast id. A toast the cap evicted keeps its timer until it
  // fires — harmless, since the dismissal it runs is then a no-op that returns
  // the same array — and unmount clears whatever is left.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const targets = useRef(new Map<string, ToastTarget>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((cur) => dismissToast(cur, id));
  }, []);

  const notify = useCallback(
    (options: ToastOptions): number => {
      const toast = createToast(options, nextId.current++);
      setToasts((cur) => addToast(cur, toast));
      if (toast.duration !== 'sticky') {
        // The callback closes over the id alone — never over `toasts` — so it
        // can't go stale however many toasts come and go before it fires.
        timers.current.set(
          toast.id,
          setTimeout(() => dismiss(toast.id), toast.duration),
        );
      }
      return toast.id;
    },
    [dismiss],
  );

  const dismissNewestSticky = useCallback((): boolean => {
    const newest = newestSticky(toasts);
    if (!newest) {
      return false;
    }
    dismiss(newest.id);
    return true;
  }, [toasts, dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);

  return { toasts, notify, dismiss, dismissNewestSticky, targets };
}

/**
 * The toast rows, newest last, floating **over** the bottom of the log pane.
 *
 * The whole stack is `position: absolute`, so it is out of flow and costs no
 * height: the log pane keeps every row it had, and a toast simply paints over the
 * tail of the last few. `bottom: 100%` glues its bottom edge to the top edge of its
 * containing block — {@link BottomChrome}'s box — so it rides that edge for free:
 * when the jump-to-latest row appears the chrome grows and the stack moves up with
 * it, and back down when it goes. That is Yoga doing the work; nothing measures a
 * height to make it happen, and it must stay that way.
 *
 * `right: 0` with an auto width shrink-wraps each row against the right edge, where
 * log lines have usually run out, so the text they'd otherwise hide is minimal —
 * and nothing is painted but the glyphs themselves (no `backgroundColor`), so the
 * rest of the row shows through untouched.
 *
 * Toasts carry no glyph of their own; the tone sets the color and the caller's
 * message says what happened.
 */
export function ToastStack({
  toasts,
  dismiss,
  targets,
}: Pick<Toasts, 'toasts' | 'dismiss' | 'targets'>): React.ReactNode {
  if (toasts.length === 0) {
    return null;
  }
  return (
    <Box position="absolute" bottom="100%" right={0} flexDirection="column" alignItems="flex-end">
      {toasts.map((toast) => (
        <Box key={toast.id} columnGap={1}>
          <Text color={TONE_COLORS[toast.tone]}>{toast.message}</Text>
          {toast.actions.map((action, i) => {
            const key = `${toast.id}:${i}`;
            return (
              <Box
                key={key}
                flexShrink={0}
                // A callback ref registers the click target and — via the
                // cleanup React 19 calls on unmount — unregisters it, so the
                // map never outlives what it points at.
                ref={(node) => {
                  if (!node) {
                    return;
                  }
                  // Acting on a toast always resolves it — that is what makes a
                  // sticky toast dismissible without a keyboard.
                  const press = () => {
                    action.onPress();
                    dismiss(toast.id);
                  };
                  targets.current.set(key, { toastId: toast.id, index: i, node, press });
                  return () => {
                    targets.current.delete(key);
                  };
                }}
              >
                <Text color={LINK_COLOR}>{`[${action.label}]`}</Text>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
