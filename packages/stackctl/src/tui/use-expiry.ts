import { useEffect } from 'react';
import { type UiState, nextExpiry } from './ui-state.js';

/**
 * One timer for the earliest armed confirmation: at its time, `onExpire(now)` dispatches the
 * reducer's `expire` event. A timer that fires early waits out the rest, since an early `expire`
 * would change nothing and so schedule nothing more.
 */
export function useExpiry(ui: UiState, onExpire: (at: number) => void): void {
  useEffect(() => {
    const due = nextExpiry(ui);
    if (due === null) {
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = Date.now();
      if (now < due) {
        timer = setTimeout(tick, due - now);
      } else {
        onExpire(now);
      }
    };
    timer = setTimeout(tick, Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [ui, onExpire]);
}
