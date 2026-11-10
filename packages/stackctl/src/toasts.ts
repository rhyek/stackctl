/**
 * The toast stack: transient notices shown just above the footer.
 *
 * This module is the **policy**, kept pure so it can be reasoned about (and
 * tested) without a terminal: what a toast is, how many may be on screen at
 * once, and which one gives way when a new one arrives. The React plumbing —
 * the id counter, the expiry timers, the click targets — lives in
 * `components/ToastStack.tsx`; the rendering lives in `BottomChrome`.
 *
 * The stack floats over the log pane rather than taking space from it, so a toast
 * costs no rows — but it does briefly cover the tail of the ones it sits on, which
 * is why the stack is capped rather than unbounded.
 */

/** What a toast is *about*, which is all the renderer needs to pick its color. */
export type ToastTone = 'info' | 'success' | 'warn' | 'error';

/** A clickable button rendered at the end of a toast. */
export type ToastAction = {
  /** Rendered inside `[ ]`, so keep it to a word or two. */
  label: string;
  /** Run on click. The toast is dismissed afterwards — an action always resolves it. */
  onPress: () => void;
};

/** What a caller passes to `notify`; everything but the message has a default. */
export type ToastOptions = {
  message: string;
  /** Defaults to `'info'`. */
  tone?: ToastTone;
  /**
   * How long the toast stays up, in ms — or `'sticky'` to keep it until the user
   * dismisses it (an action, or `esc`). Defaults to {@link DEFAULT_TOAST_MS}.
   */
  duration?: number | 'sticky';
  /** Defaults to none, i.e. a notice with nothing to do about it. */
  actions?: readonly ToastAction[];
};

/** A toast on the stack: {@link ToastOptions} with its defaults filled in and an id. */
export type Toast = Required<Omit<ToastOptions, 'actions'>> & {
  /** Unique for the session; the handle `dismiss` takes and click targets are keyed by. */
  id: number;
  actions: readonly ToastAction[];
};

/**
 * Default lifetime. Matches the selection highlight's linger, so the `copied N
 * chars` toast and the highlight that shows *what* was copied still clear together.
 */
export const DEFAULT_TOAST_MS = 5000;

/**
 * How many toasts may be on screen at once. Each one covers the right-hand end of
 * a log row while it's up, so this is deliberately small — a notification area
 * that can obscure half the logs is worse than a dropped notification.
 */
export const MAX_TOASTS = 3;

/** Fill in {@link ToastOptions}' defaults, producing the toast that goes on the stack. */
export function createToast(options: ToastOptions, id: number): Toast {
  return {
    id,
    message: options.message,
    tone: options.tone ?? 'info',
    duration: options.duration ?? DEFAULT_TOAST_MS,
    actions: options.actions ?? [],
  };
}

/**
 * Push `toast` onto the stack, newest last — so toasts read bottom-up in arrival
 * order, the newest sitting nearest the footer where the eye already is.
 *
 * Over {@link MAX_TOASTS}, the oldest **transient** toast gives way first: a
 * sticky toast is waiting on the user for something, so a burst of routine
 * notices must not silently retire it. Only when every toast is sticky does the
 * oldest of those go — the cap is a hard bound on how much of the log pane this
 * can take.
 */
export function addToast(toasts: readonly Toast[], toast: Toast): Toast[] {
  const next = [...toasts, toast];
  while (next.length > MAX_TOASTS) {
    const transient = next.findIndex((t) => t.duration !== 'sticky');
    next.splice(transient === -1 ? 0 : transient, 1);
  }
  return next;
}

/**
 * The most recent toast that is waiting on the user — what `esc` takes down.
 *
 * Transient toasts are deliberately skipped: they clear themselves in a few
 * seconds, so letting one absorb an `esc` would cost the user a keypress aimed at
 * whatever is underneath (an active filter, say) for no benefit.
 */
export function newestSticky(toasts: readonly Toast[]): Toast | undefined {
  return toasts.findLast((t) => t.duration === 'sticky');
}

/**
 * Drop the toast with `id`. Returns the **same array** when there is no such
 * toast, so a no-op dismissal doesn't churn a render — routine, since a caller
 * that retires its own previous toast (`flashCopy`) usually finds it already expired.
 */
export function dismissToast(toasts: readonly Toast[], id: number): Toast[] {
  return toasts.some((t) => t.id === id) ? toasts.filter((t) => t.id !== id) : (toasts as Toast[]);
}
