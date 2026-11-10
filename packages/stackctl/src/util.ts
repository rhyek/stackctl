// Small helpers the runtime's modules share.

/** Resolves when `promise` settles or after `ms`, whichever comes first; never rejects. */
export function bounded(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/**
 * Calls each listener in turn, with `thisArg` and `args`. One that throws is skipped over: the
 * rest are still called, and the caller's own work goes on.
 */
export function callEach<A extends unknown[]>(
  listeners: Iterable<(...args: A) => void>,
  thisArg: unknown,
  ...args: A
): void {
  for (const listener of listeners) {
    try {
      listener.apply(thisArg, args);
    } catch {
      /* a listener's own fault */
    }
  }
}
