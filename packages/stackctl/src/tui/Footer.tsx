import React from 'react';
import { Box } from 'ink';
import { KeysRow, SegmentLine } from './KeysRow.js';
import type { FooterLayout } from './layout.js';

export interface FooterProps {
  layout: FooterLayout;
  /**
   * What floats at the footer's top edge: the `CommandsMenu`. Its `bottom: 100%` resolves
   * against this box, so it sits just above the rule line and takes no height.
   */
  children?: React.ReactNode;
}

/**
 * The run screen's footer (Design A): the rule line, the services row, the focus line and the
 * keys row, as `footerLayout` laid them out. No box, no border; its height is the layout's.
 */
export function Footer({ layout, children }: FooterProps): React.ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0} width="100%" height={layout.height}>
      {layout.rows.slice(0, layout.keysRow).map((row, i) => (
        <SegmentLine key={i} segments={row} />
      ))}
      <KeysRow rows={layout.rows.slice(layout.keysRow)} />
      {children}
    </Box>
  );
}
