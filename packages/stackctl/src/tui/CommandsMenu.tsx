import React from 'react';
import { Box } from 'ink';
import { SegmentLine } from './KeysRow.js';
import type { MenuLayout } from './layout.js';

/**
 * The floating commands menu, as `menuLayout` laid it out. Render it as the `Footer`'s child:
 * it is absolutely positioned with its bottom edge on the footer's top edge, like the toast
 * stack, so it takes no layout height and covers the log rows under it. Every cell inside its
 * walls is written, so nothing under it shows through.
 */
export function CommandsMenu({ menu }: { menu: MenuLayout | null }): React.ReactNode {
  if (!menu) {
    return null;
  }
  return (
    <Box
      position="absolute"
      bottom="100%"
      left={menu.left - 1}
      width={menu.width}
      flexDirection="column"
    >
      {menu.rows.map((row, i) => (
        <SegmentLine key={i} segments={row} />
      ))}
    </Box>
  );
}
