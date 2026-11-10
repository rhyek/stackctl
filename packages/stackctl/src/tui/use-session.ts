import { useCallback, useSyncExternalStore } from 'react';
import type { Session, SessionSnapshot } from '../session/session.js';

/**
 * The session's state snapshot, re-rendering when it changes. It subscribes, and never polls: the
 * session notifies at most once per microtask, and its snapshot keeps its identity until something
 * in it changed. The log is subscribed to separately, by `useLogViewport` over `session.logs`, so
 * an appended line re-renders the log pane without a new snapshot.
 */
export function useSessionSnapshot(session: Session): SessionSnapshot {
  const subscribe = useCallback((onChange: () => void) => session.subscribe(onChange), [session]);
  const getSnapshot = useCallback(() => session.getSnapshot(), [session]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
