/**
 * Scroll position for the log viewport, measured in rendered rows from the
 * bottom. `offset === 0` means "following" — pinned to the newest output — and a
 * positive offset is how many rows of history sit below the viewport.
 *
 * Pairs with {@link computeWindow}, which takes this same offset.
 */
export type Scroll = { readonly offset: number };

/** The following (newest-pinned) position. */
export const FOLLOWING: Scroll = { offset: 0 };

const clamp = (offset: number, maxScroll: number): number =>
  Math.min(Math.max(0, offset), Math.max(0, maxScroll));

export function isFollowing(state: Scroll): boolean {
  return state.offset <= 0;
}

/** Scroll by `rows`: positive scrolls toward older output, negative toward newest. */
export function scroll(state: Scroll, rows: number, maxScroll: number): Scroll {
  const offset = clamp(state.offset + rows, maxScroll);
  return offset === 0 ? FOLLOWING : { offset };
}

/** Jump to the oldest output. */
export function scrollToTop(maxScroll: number): Scroll {
  const offset = Math.max(0, maxScroll);
  return offset === 0 ? FOLLOWING : { offset };
}

/** Jump to the newest output and re-enter follow mode. */
export function scrollToBottom(): Scroll {
  return FOLLOWING;
}

/**
 * Reconcile the offset after the buffer's total rendered-row count changes by
 * `deltaRows`. While following, stay pinned to the bottom; while scrolled up,
 * shift by the same delta so the visible window keeps showing the same content.
 */
export function onContentResized(state: Scroll, deltaRows: number, maxScroll: number): Scroll {
  if (state.offset <= 0) {
    return FOLLOWING;
  }
  const offset = clamp(state.offset + deltaRows, maxScroll);
  return offset === 0 ? FOLLOWING : { offset };
}
