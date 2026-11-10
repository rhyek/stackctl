import { describe, test, expect } from 'vitest';
import {
  DEFAULT_TOAST_MS,
  MAX_TOASTS,
  addToast,
  createToast,
  dismissToast,
  newestSticky,
  type Toast,
} from './toasts.js';

/** A toast at `id`, transient unless `duration` says otherwise. */
const toast = (id: number, duration: Toast['duration'] = DEFAULT_TOAST_MS): Toast =>
  createToast({ message: `notice ${id}`, duration }, id);

const ids = (toasts: readonly Toast[]) => toasts.map((t) => t.id);

describe('createToast', () => {
  test('defaults to an informational toast that clears itself', () => {
    const t = createToast({ message: 'copied 12 chars' }, 1);
    expect(t).toMatchObject({ id: 1, message: 'copied 12 chars', tone: 'info' });
    expect(t.duration).toBe(DEFAULT_TOAST_MS);
    expect(t.actions).toEqual([]);
  });

  test('keeps an explicit tone, duration and actions', () => {
    const onPress = () => {};
    const t = createToast(
      {
        message: 'build failed',
        tone: 'error',
        duration: 'sticky',
        actions: [{ label: 'retry', onPress }],
      },
      7,
    );
    expect(t.tone).toBe('error');
    expect(t.duration).toBe('sticky');
    expect(t.actions).toEqual([{ label: 'retry', onPress }]);
  });
});

describe('addToast', () => {
  test('appends, so the newest toast is last (nearest the footer)', () => {
    expect(ids(addToast([toast(1)], toast(2)))).toEqual([1, 2]);
  });

  test('drops the oldest once the stack is full, so it never eats the log pane', () => {
    const full = [toast(1), toast(2), toast(3)];
    expect(full).toHaveLength(MAX_TOASTS);
    expect(ids(addToast(full, toast(4)))).toEqual([2, 3, 4]);
  });

  test('evicts a transient toast before a sticky one, which is waiting on the user', () => {
    // The sticky toast is the *oldest*, so a naive drop-the-front would lose it.
    const full = [toast(1, 'sticky'), toast(2), toast(3)];
    expect(ids(addToast(full, toast(4)))).toEqual([1, 3, 4]);
  });

  test('falls back to the oldest sticky when every toast is sticky', () => {
    const full = [toast(1, 'sticky'), toast(2, 'sticky'), toast(3, 'sticky')];
    expect(ids(addToast(full, toast(4, 'sticky')))).toEqual([2, 3, 4]);
  });

  test('never returns more than the cap, however far over it starts', () => {
    const over = [toast(1), toast(2), toast(3), toast(4), toast(5)];
    expect(addToast(over, toast(6))).toHaveLength(MAX_TOASTS);
  });
});

describe('newestSticky', () => {
  test('finds the most recent sticky toast', () => {
    expect(newestSticky([toast(1, 'sticky'), toast(2), toast(3, 'sticky')])?.id).toBe(3);
  });

  test('ignores transient toasts, which clear themselves', () => {
    // This is what keeps `esc` meaningful: a passing notice must not absorb the
    // keypress the user aimed at the filter underneath it.
    expect(newestSticky([toast(1, 'sticky'), toast(2), toast(3)])?.id).toBe(1);
  });

  test('finds nothing when every toast is transient', () => {
    expect(newestSticky([toast(1), toast(2)])).toBeUndefined();
  });

  test('finds nothing in an empty stack', () => {
    expect(newestSticky([])).toBeUndefined();
  });
});

describe('dismissToast', () => {
  test('removes just that toast', () => {
    expect(ids(dismissToast([toast(1), toast(2), toast(3)], 2))).toEqual([1, 3]);
  });

  test('returns the very same array for an unknown id, so nothing re-renders', () => {
    // Dismissing an already-expired toast is routine — `flashCopy` retires its
    // previous toast on every copy — and must not churn the render.
    const list = [toast(1)];
    expect(dismissToast(list, 99)).toBe(list);
  });

  test('empties the stack when the last toast goes', () => {
    expect(dismissToast([toast(1)], 1)).toEqual([]);
  });
});
