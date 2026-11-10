import React from 'react';
import { Box, Text } from 'ink';
import type { FooterRow, Segment } from './layout.js';

/** `text` as an OSC 8 terminal hyperlink to `url`, which the terminal's own gesture opens. */
export function osc8Link(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function SegmentRun({ segment }: { segment: Segment }): React.ReactElement {
  return (
    <Text
      color={segment.color}
      bold={segment.bold}
      dimColor={segment.dim}
      inverse={segment.inverse}
    >
      {segment.link ? osc8Link(segment.link, segment.text) : segment.text}
    </Text>
  );
}

/**
 * One laid-out row, drawn segment by segment. The layout already fits it to the screen, so it
 * never wraps; `truncate-end` only guards a row that would. An empty row still takes its row.
 */
export function SegmentLine({ segments }: { segments: readonly Segment[] }): React.ReactElement {
  if (segments.length === 0) {
    return <Text> </Text>;
  }
  return (
    <Text wrap="truncate-end">
      {segments.map((segment, i) => (
        <SegmentRun key={i} segment={segment} />
      ))}
    </Text>
  );
}

/**
 * Hint rows as `layoutHints` lays them out: the footer's keys row, or any other row of hints
 * (the picker's static list). Laying them out first is what gives each hint its click target.
 */
export function KeysRow({ rows }: { rows: readonly FooterRow[] }): React.ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((row, i) => (
        <SegmentLine key={i} segments={row} />
      ))}
    </Box>
  );
}
