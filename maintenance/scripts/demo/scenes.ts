// The docs' terminal recordings, and the index of them: each scene says where it is shown, what
// it shows, which files can change it (`triggers`), and how it is played against the example
// workspace (what to type and press, at what pace, and which screen its text copy shows). record.sh
// records them, place.ts puts each where its page shows it, and affected.ts (the /commit skill)
// lists the ones a change touches.

import { conversationText } from './agent-chat.ts';
import { conversations } from './conversations/index.ts';

/** What a scene drives the terminal with (record.ts). */
export interface Stage {
  /** Presses `key` (`enter`, `space`, an arrow, `esc`, `ctrl-c`, or one character), then waits `ms`. */
  press(key: string, ms: number): Promise<void>;
  /** Types `text` a character at a time, at a person's pace. */
  type(text: string): Promise<void>;
  /** Sends `text` in one write, as a paste arrives. */
  paste(text: string): void;
  sleep(ms: number): Promise<void>;
  /** Waits until `text` is on screen. */
  waitFor(text: string, timeout?: number): Promise<void>;
  /** Waits until the shell's `$` prompt is the last line: the command typed into it has ended. */
  waitForPrompt(timeout?: number): Promise<void>;
  /** Double-clicks `offset` cells into where `text` last appears on screen. */
  doubleClick(text: string, offset: number): void;
  /** What stackctl last copied, read from its OSC 52 output; `null` before any copy. */
  copied(): string | null;
  /** The row (1-based) where `text` last appears on screen, or `null`. */
  rowOf(text: string): number | null;
  /** Takes the screen's rows `from`..`to` (1-based, inclusive; all by default) as the scene's text. */
  snapshot(from?: number, to?: number): void;
  /** Takes `text` as the scene's text, for one whose screen never holds it all at once. */
  text(text: string): void;
}

export interface Scene {
  /** Where it is shown and what it shows, for someone deciding whether a change alters it. */
  description: string;
  /**
   * Path globs, from the repo's root, of the files whose change can alter what the recording shows.
   * Tests (`*.spec.ts`, `*.test-d.ts`) never count. Broad on purpose: the /commit skill reads the
   * diff to judge whether a matched change really reaches the screen.
   */
  triggers: string[];
  cols: number;
  rows: number;
  /**
   * A screenshot rather than a recording: its cast is one frame, the screen as it stood when the
   * scene took its snapshot. The page shows it with `<TerminalPlayer still />`.
   */
  still?: boolean;
  /**
   * What runs on the terminal in place of a bash prompt, from `example/`: the agent scenes' replay
   * of a conversation (agent-chat.ts).
   */
  program?: string[];
  /** Plays the scene; returns why it failed, if it did. */
  play(stage: Stage): Promise<string | void>;
}

/** The terminal UI guide's recordings: 74 columns is a terminal's text size in a docs page. */
const PAGE_COLS = 74;

const SRC = 'packages/stackctl/src';
/** How any screen is drawn: the screens, the footer, colors, wrapping, Ink's output. */
const SCREEN = [
  `${SRC}/tui/**`,
  `${SRC}/components/**`,
  `${SRC}/colors.ts`,
  `${SRC}/wrap-rows.ts`,
  `${SRC}/ink-output.ts`,
  `${SRC}/render-app-production.ts`,
  `${SRC}/terminal-title.ts`,
];
/** What the run screen's log and footer show: the session, its lines, infra, the proxy. */
const RUN = [
  `${SRC}/session/**`,
  `${SRC}/infra/**`,
  `${SRC}/log-*.ts`,
  `${SRC}/internal-logger.ts`,
  `${SRC}/format.ts`,
  `${SRC}/timestamp-mode.ts`,
  `${SRC}/dev-reverse-proxy.ts`,
  `${SRC}/service-usage.ts`,
  `${SRC}/scroll.ts`,
  `${SRC}/toasts.ts`,
  `${SRC}/one-off/**`,
  `${SRC}/scripts.ts`,
];
/** What the picker lists and how it starts a session. */
const PICKER = [
  `${SRC}/selection-plan.ts`,
  `${SRC}/saved-selection.ts`,
  `${SRC}/config.ts`,
  `${SRC}/cli.ts`,
];
/** The recorder itself, and the workspace every scene plays against. */
const COMMON = [
  'maintenance/scripts/demo/record.ts',
  'maintenance/scripts/demo/scenes.ts',
  'packages/stackctl/e2e/pty_driver.py',
  'packages/stackctl/e2e/screen.ts',
  'example/**',
];

export const scenes: Record<string, Scene> = {
  demo: {
    description:
      "The home page's demo (docs/index.md) and the README's GIF: the picker, the run screen's log and footer, the commands menu, a one-off command, a double-click copy, the log filter, quitting.",
    triggers: [
      ...COMMON,
      ...SCREEN,
      ...RUN,
      ...PICKER,
      `${SRC}/selection.ts`,
      `${SRC}/word-select.ts`,
      `${SRC}/clipboard.ts`,
      `${SRC}/mouse.ts`,
    ],
    cols: 84,
    rows: 27,
    async play(t) {
      await t.type('pnpm stackctl');
      await t.press('enter', 0);
      await t.waitFor('choose services');
      await t.sleep(1200);

      // select each service one by one (space toggles the row under the cursor)
      await t.press('space', 500);
      await t.press('down', 350);
      await t.press('space', 500);
      await t.press('down', 350);
      await t.press('space', 900);

      // the run screen: backend + frontend + worker boot together, the infra already up. Start
      // moving the focus while logs are still settling, so the demo never looks frozen.
      await t.press('enter', 4500);

      // a quick tour of the footer: across the services and on to the first infra service,
      // whose keys replace the service ones, then back to the backend
      await t.press('right', 400);
      await t.press('right', 400);
      await t.press('right', 900);
      await t.press('left', 400);
      await t.press('left', 400);
      await t.press('left', 800);

      // the backend's commands menu, across to the frontend's scripts and back
      await t.press('m', 1500);
      await t.press('right', 1500);
      await t.press('left', 1200);

      // run the backend's add-random-todo; once it has finished and the screen has settled for a
      // beat, double-click the word `Added` where it is drawn: stackctl's double-click-to-copy,
      // its highlight and its `✓ copied 5 chars to clipboard` notice
      await t.press('enter', 0);
      await t.waitFor('add-random-todo finished');
      await t.sleep(1500);
      t.doubleClick('Added todo', 2);
      await t.sleep(2500);
      const copied = t.copied();
      if (copied !== 'Added') {
        return `the double-click copied ${JSON.stringify(copied)}, not "Added"`;
      }
      t.snapshot();

      // filter the combined log down to the added todos with the word just copied, pasted
      await t.press('f', 1000);
      t.paste(copied);
      await t.sleep(800);
      await t.press('enter', 2500);

      // clear the filter, then quit: once services run, Ctrl+C asks for a second press
      await t.press('esc', 2000);
      await t.press('ctrl-c', 900);
      await t.press('ctrl-c', 0);
      await t.waitForPrompt();
      await t.sleep(1500);
    },
  },

  picker: {
    description:
      "The terminal UI guide's picker (docs/guide/terminal-ui.md, Choosing services): picking a service selects its dependency with `needed by`, the will-start line, filtering the list.",
    triggers: [...COMMON, ...SCREEN, ...PICKER],
    cols: PAGE_COLS,
    rows: 13,
    async play(t) {
      await t.type('pnpm sctl');
      await t.press('enter', 0);
      await t.waitFor('choose services');
      await t.sleep(1200);

      // pick the frontend: the backend it needs comes with it, and says so
      await t.press('down', 500);
      await t.press('space', 1500);
      // and the worker
      await t.press('down', 500);
      await t.press('space', 1500);
      t.snapshot();

      // the filter narrows the list as you type
      await t.press('/', 600);
      await t.type('work');
      await t.sleep(1500);
      await t.press('esc', 1200);

      await t.press('ctrl-c', 0);
      await t.waitForPrompt();
      await t.sleep(1000);
    },
  },

  'run-screen': {
    description:
      "The terminal UI guide's run screen (docs/guide/terminal-ui.md, The run screen): the log, the footer's services and infra rows with their dots and memory, the keys row as the focus moves, a restart.",
    triggers: [...COMMON, ...SCREEN, ...RUN],
    cols: PAGE_COLS,
    rows: 18,
    async play(t) {
      await t.type('pnpm sctl -s frontend -s worker');
      await t.press('enter', 0);
      await t.waitFor('ssr) connected');
      await t.sleep(1500);

      // the focus moves across the services, and the keys row follows it
      await t.press('right', 800);
      await t.press('right', 800);
      await t.press('right', 1200);
      await t.press('left', 800);
      await t.press('left', 800);
      await t.press('left', 1200);

      // restart the backend: its dot blinks until it is healthy again
      await t.press('r', 4500);
      const footer = t.rowOf('── example');
      if (footer === null) {
        return 'no footer on screen';
      }
      t.snapshot(footer);

      await t.press('ctrl-c', 900);
      await t.press('ctrl-c', 0);
      await t.waitForPrompt();
      await t.sleep(1000);
    },
  },

  'getting-started': {
    description:
      "Getting started's screenshot of a first run (docs/guide/getting-started.md, Run it): one still frame of the run screen, a service and its dependency up, their log above the footer.",
    triggers: [...COMMON, ...SCREEN, ...RUN],
    cols: PAGE_COLS,
    rows: 14,
    still: true,
    async play(t) {
      await t.type('pnpm stackctl -s frontend');
      await t.press('enter', 0);
      await t.waitFor('ssr) connected');
      await t.sleep(2500);
      t.snapshot();

      await t.press('ctrl-c', 900);
      await t.press('ctrl-c', 0);
      await t.waitForPrompt();
    },
  },

  'agent-restart': agentScene(
    'restart',
    "The AI overview page's first agent conversation (docs/ai/overview.md, What it looks like): Claude Code, told the app isn't loading, reads the session's status, log and event log, restarts the backend through stackctl and explains the crash.",
    // the answer's last word, alone on its line however it wraps
    'it?',
  ),

  'agent-tests': agentScene(
    'tests',
    "The AI overview page's second agent conversation (docs/ai/overview.md, What it looks like), also on the home page (docs/index.md, agents.src): Claude Code, asked to run the backend's tests, starts a test-mode session, waits for it, runs them in its environment and stops it.",
    // the answer's last word, alone on its line at the page's width
    'running.',
  ),
};

/**
 * A coding agent's conversation, replayed (agent-chat.ts): the recording plays the same every
 * time, so re-recording one changes nothing. What can make it stale is the agent: a change to the
 * skill, the rules file or the playbook that would change what it does calls for a new real run
 * (conversations/README.md).
 */
function agentScene(name: string, description: string, lastWords: string): Scene {
  return {
    description: `${description} A replay of a real run: re-recording it changes nothing; a change to what the agent would do calls for a new run (maintenance/scripts/demo/conversations/README.md).`,
    triggers: [
      'maintenance/scripts/demo/agent-chat.ts',
      'maintenance/scripts/demo/conversations/**',
      'maintenance/scripts/demo/record.ts',
      'packages/stackctl/skills/stackctl/SKILL.md',
      'packages/stackctl/assets/agent-rules.md',
      'docs/ai/playbook.md',
    ],
    cols: PAGE_COLS,
    rows: 30,
    program: ['node', '../maintenance/scripts/demo/agent-chat.ts', name],
    async play(t) {
      await t.waitFor(lastWords, 180_000);
      t.text(conversationText(conversations[name]!, PAGE_COLS));
      await t.sleep(2000);
    },
  };
}
