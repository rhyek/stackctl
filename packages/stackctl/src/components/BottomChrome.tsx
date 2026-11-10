import React from 'react';
import { Box, Text, type DOMElement } from 'ink';
import { LINK_COLOR } from '../colors.js';
import { ToastStack, type Toasts } from './ToastStack.js';

export type BottomChromeProps = {
  /**
   * Ref on the stack itself, for a caller that needs its measured box. The log pane fills
   * whatever height the stack leaves, so rows can appear and disappear here without any
   * cursor math.
   */
  ref?: React.Ref<DOMElement>;
  /**
   * The toast stack. Rendered here so its `bottom: 100%` resolves against this box
   * — it floats just above this stack's top edge — but it is out of flow and adds
   * nothing to the measured height.
   */
  toasts: Toasts;
  /** Rendered rows of newer output hidden below the viewport; 0 hides the jump row entirely. */
  hiddenBelow: number;
  /**
   * Ref on the "Click here" text, hit-tested against mouse presses by the run screen.
   * It is only mounted while scrolled up, so a null rect is the caller's natural gate.
   */
  jumpToLatestRef?: React.Ref<DOMElement>;
  /** The footer, drawn bare: no border, no padding, no gap. */
  children: React.ReactNode;
};

/**
 * Everything pinned below the log pane, as one bottom-aligned stack, top to bottom:
 *
 * 1. the **jump-to-latest** row — `↓ N newer lines — press End or Click here to jump
 *    to latest` — centered and full width, present only while scrolled up, and
 * 2. the **footer**, its children, drawn as they are: no border, no padding.
 *
 * It is `flexShrink: 0` and sits after `LogPane`'s `flexGrow`, which is what pins it
 * to the bottom of the viewport. Row 1 comes and goes freely: the
 * run screen's log pane takes whatever height this whole stack leaves.
 *
 * {@link ToastStack} is also a child, but an absolutely-positioned one: it floats
 * above this box's top edge rather than sitting in the column, so it adds nothing
 * to the measured height and instead follows that edge as row 1 comes and goes.
 */
export function BottomChrome({
  ref,
  toasts,
  hiddenBelow,
  jumpToLatestRef,
  children,
}: BottomChromeProps): React.ReactElement {
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      <ToastStack toasts={toasts.toasts} dismiss={toasts.dismiss} targets={toasts.targets} />
      {hiddenBelow > 0 && (
        // Centering wraps a single child rather than justifying the three parts
        // directly: an odd amount of free space puts the centered origin on a half
        // column, and rounding that per-child drifts them apart — which showed up as
        // a doubled space and a clipped last character. One child rounds once.
        <Box justifyContent="center">
          {/* Split across Texts so "Click here" can carry its own ref for hit-testing;
              the spacing around it lives inside the strings (no columnGap). */}
          <Box flexShrink={0}>
            <Text dimColor>
              {`↓ ${hiddenBelow} newer line${hiddenBelow === 1 ? '' : 's'} — press End or `}
            </Text>
            <Box ref={jumpToLatestRef} flexShrink={0}>
              <Text color={LINK_COLOR}>Click here</Text>
            </Box>
            <Text dimColor>{' to jump to latest'}</Text>
          </Box>
        </Box>
      )}
      <Box>{children}</Box>
    </Box>
  );
}
