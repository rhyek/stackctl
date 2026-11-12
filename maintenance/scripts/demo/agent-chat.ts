#!/usr/bin/env node
// Replays a coding agent's conversation (maintenance/scripts/demo/conversations/) in a terminal, the way
// Claude Code draws one: the prompt typed in, each tool call with its output folded to a few
// lines, and the agent's replies. The agent scenes in scenes.ts run it in place of a shell, and
// record.ts records it like any other scene.
//
//   node maintenance/scripts/demo/agent-chat.ts <name>
//
// The conversations are real runs of Claude Code with stackctl's skill against the example
// workspace, kept as data so a recording plays the same every time and needs no account.
// conversations/README.md says how one is captured.
import {
  conversations,
  type Conversation,
  type SayStep,
  type ToolStep,
} from './conversations/index.ts';

const TYPING_MS = 45;

/** How a step's text is styled: SGR codes for the terminal, nothing for the text copy. */
interface Style {
  dim(text: string): string;
  bold(text: string): string;
  green(text: string): string;
  code(text: string): string;
}

const sgr = (n: string) => (text: string) => `\x1b[${n}m${text}\x1b[0m`;
const COLOR: Style = { dim: sgr('2'), bold: sgr('1'), green: sgr('32'), code: sgr('94') };
const PLAIN: Style = { dim: (t) => t, bold: (t) => t, green: (t) => t, code: (t) => `\`${t}\`` };

/** `text` without its SGR codes: what the terminal shows of it. */
// oxlint-disable-next-line no-control-regex -- matching SGR sequences is the point
const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** Breaks `text` into lines of at most `width` visible columns, at spaces. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '' || visible(line).length + 1 + visible(word).length > width) {
      if (line !== '') {
        lines.push(line);
      }
      line = word;
    } else {
      line += ` ${word}`;
    }
  }
  return [...lines, line];
}

/** Cuts `text` to `width` columns, ending in `…` when it is longer. */
const fit = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text;

/** A tool call as Claude Code draws it: `● Tool(input)`, then its output under `⎿`. */
function drawTool(step: ToolStep, cols: number, s: Style): string[] {
  const head = wrap(`${step.tool}(${step.input})`, cols - 2);
  const lines = head.slice(0, 3).map((line, i) => {
    const text = i === 2 && head.length > 3 ? fit(`${line}…`, cols - 2) : line;
    return `${i === 0 ? `${s.green('●')} ` : '  '}${s.bold(text)}`;
  });
  step.output.forEach((line, i) => {
    lines.push(`${i === 0 ? `  ${s.dim('⎿')}  ` : '     '}${s.dim(fit(line, cols - 5))}`);
  });
  if (step.more) {
    lines.push(`     ${s.dim(`… +${String(step.more)} lines (ctrl+o to expand)`)}`);
  }
  return lines;
}

/**
 * A reply: its paragraphs, a `- ` line as a list item hung under its dash, `**bold**` and
 * `` `code` `` drawn.
 */
function drawSay(step: SayStep, cols: number, s: Style): string[] {
  const inline = (text: string) =>
    text
      .replace(/\*\*(.+?)\*\*/g, (_, t: string) => s.bold(t))
      .replace(/`(.+?)`/g, (_, t: string) => s.code(t));
  const lines: string[] = [];
  let first = true;
  for (const paragraph of step.say.split('\n\n')) {
    if (lines.length > 0) {
      lines.push('');
    }
    for (const source of paragraph.split('\n')) {
      const item = source.startsWith('- ');
      const lead = first ? '● ' : '  ';
      first = false;
      const hang = item ? '    ' : '  ';
      wrap(inline(item ? source.slice(2) : source), cols - hang.length).forEach((line, k) => {
        lines.push(`${k > 0 ? hang : item ? `${lead}- ` : lead}${line}`);
      });
    }
  }
  return lines;
}

const draw = (step: ToolStep | SayStep, cols: number, s: Style) =>
  'say' in step ? drawSay(step, cols, s) : drawTool(step, cols, s);

/** The whole conversation as plain text: a page's text copy of its recording. */
export function conversationText(conversation: Conversation, cols: number): string {
  return [
    `> ${conversation.prompt}`,
    ...conversation.steps.map((step) => draw(step, cols, PLAIN).join('\n')),
  ].join('\n\n');
}

async function play(conversation: Conversation, cols: number): Promise<void> {
  const out = (text: string) => process.stdout.write(text);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** "✻ Working…" for `ms`, then cleared: the agent at work between steps. */
  const work = async (ms: number, word: string) => {
    out(`\x1b[33m✻\x1b[0m ${COLOR.dim(`${word}…`)}`);
    await sleep(ms);
    out('\r\x1b[2K');
  };

  // A clear screen, and no cursor: the replay takes no input.
  out('\x1b[2J\x1b[H\x1b[?25l');
  await sleep(600);
  out(`${COLOR.dim('>')} `);
  for (const char of conversation.prompt) {
    out(char);
    await sleep(TYPING_MS);
  }
  await sleep(700);
  out('\n\n');

  for (const step of conversation.steps) {
    const say = 'say' in step;
    await work(step.think ?? (say ? 1400 : 900), say ? 'Thinking' : 'Working');
    const lines = draw(step, cols, COLOR);
    if (say) {
      out(`${lines.join('\n')}\n\n`);
      await sleep(step.pause ?? 900);
    } else {
      // The call first, its output once it has run.
      const head = lines.length - step.output.length - (step.more ? 1 : 0);
      out(`${lines.slice(0, head).join('\n')}\n`);
      await sleep(step.run ?? 700);
      out(`${lines.slice(head).join('\n')}\n\n`);
    }
  }
  await sleep(2500);
  out('\x1b[?25h');
}

if (import.meta.main) {
  const name = process.argv[2];
  const conversation = name ? conversations[name] : undefined;
  if (!conversation) {
    console.error(
      `usage: node maintenance/scripts/demo/agent-chat.ts <${Object.keys(conversations).join('|')}>`,
    );
    process.exit(2);
  }
  await play(conversation, process.stdout.columns || 74);
}
