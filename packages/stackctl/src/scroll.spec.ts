import { describe, test, expect } from 'vitest';
import {
  FOLLOWING,
  isFollowing,
  scroll,
  scrollToTop,
  scrollToBottom,
  onContentResized,
} from './scroll.js';

describe('scroll state', () => {
  test('follows the newest output at offset 0', () => {
    expect(isFollowing(FOLLOWING)).toBe(true);
    expect(isFollowing({ offset: 0 })).toBe(true);
    expect(isFollowing({ offset: 5 })).toBe(false);
  });

  test('scrolls toward older output with a positive delta, clamped to maxScroll', () => {
    expect(scroll({ offset: 0 }, 3, 10)).toEqual({ offset: 3 });
    expect(scroll({ offset: 8 }, 5, 10)).toEqual({ offset: 10 }); // clamp to max
  });

  test('scrolls toward the newest output with a negative delta, clamped to follow', () => {
    expect(scroll({ offset: 5 }, -3, 10)).toEqual({ offset: 2 });
    expect(scroll({ offset: 5 }, -5, 10)).toEqual({ offset: 0 }); // re-enters follow
    expect(scroll({ offset: 0 }, -3, 10)).toEqual({ offset: 0 }); // already at bottom
  });

  test('jumps to the top (oldest) and bottom (newest/follow)', () => {
    expect(scrollToTop(10)).toEqual({ offset: 10 });
    expect(scrollToBottom()).toEqual({ offset: 0 });
  });

  test('keeps following when new output arrives at the bottom', () => {
    expect(onContentResized({ offset: 0 }, 3, 13)).toEqual({ offset: 0 });
  });

  test('pins a scrolled-up view to the same content as new output arrives', () => {
    // 3 rows appended: bump offset by 3 so the visible window stays put.
    expect(onContentResized({ offset: 5 }, 3, 13)).toEqual({ offset: 8 });
  });

  test('clamps the pinned offset to the new maxScroll and never below follow', () => {
    expect(onContentResized({ offset: 5 }, 3, 6)).toEqual({ offset: 6 }); // clamp up-bound
    expect(onContentResized({ offset: 5 }, -10, 3)).toEqual({ offset: 0 }); // buffer shrank/cleared
  });
});
