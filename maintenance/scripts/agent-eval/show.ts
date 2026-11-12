#!/usr/bin/env node
// Prints one run's transcript in short: what the agent said, ran and got back.
//
//   node maintenance/scripts/agent-eval/show.ts <run.jsonl> [chars per line]
import fs from 'node:fs';
import { parseEvent, partsOf } from './lib.ts';

const [file, width = '260'] = process.argv.slice(2);
const cut = (text: string) => text.replaceAll('\n', ' | ').slice(0, Number(width));
for (const line of fs.readFileSync(file!, 'utf8').split('\n')) {
  const event = parseEvent(line);
  for (const part of event ? partsOf(event) : []) {
    if (part.type === 'text' && part.text?.trim()) {
      console.log(`SAYS  ${cut(part.text)}`);
    } else if (part.type === 'tool_use') {
      console.log(
        `${(part.name ?? '').toUpperCase().padEnd(5)} ${cut(JSON.stringify(part.input))}`,
      );
    } else if (part.type === 'tool_result') {
      const text = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
      console.log(`  ->  ${part.is_error ? 'REFUSED/ERROR ' : ''}${cut(text)}`);
    }
  }
}
