#!/usr/bin/env node
// Records one scene (scenes.ts): drives the example's real shell and stackctl on a pseudo-terminal
// and writes what the terminal showed as an asciicast (v2), plus the scene's snapshot of the
// screen as plain text. The site plays the cast (asciinema-player), agg renders the demo's to the
// README's GIF, and the text is what llms.txt reads in its place. record.sh runs it.
//
//   node maintenance/scripts/demo/record.ts <scene> <out.cast> <out.txt>
//
// Everything visible really runs: a bash prompt, the command typed into it, stackctl's screens.
// The one exception is a scene that names its own `program`: the agent scenes replay a real
// Claude Code run from its transcript (agent-chat.ts), which a recording can't run again alike.
// The PTY is the e2e suite's own (packages/stackctl/e2e/pty_driver.py), and its bytes are played
// into the suite's VT screen (e2e/screen.ts), so each step can wait for what is on screen and a
// click can aim at a word wherever it is drawn.
//
// Two things make a recording come out whole every time:
//
//   * **Frames are cut where stackctl's frames end.** Ink draws each frame as one synchronized
//     update (`ESC[?2026h` … `ESC[?2026l`). The cast gets one event per stretch of output that ends
//     outside an update, so no frame can show a screen half drawn, however the bytes were split.
//   * **A copy is read from the stream, not the clipboard.** stackctl runs as it would over SSH
//     (`SSH_TTY` set), so its copy goes out as OSC 52 into the terminal (here: the cast) rather than
//     through `pbcopy`. The machine's clipboard is never touched. The player and agg ignore OSC 52.
//
// Exits 1, writing nothing, when the scene fails its own check (the demo's double-click).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Screen } from '../../../packages/stackctl/e2e/screen.ts';
import { scenes, type Stage } from './scenes.ts';

/** How fast typed text appears: about a person's pace. */
const TYPING_MS = 55;
/**
 * The terminal's colors, embedded in every cast: the site's player plays it in them and agg
 * renders the GIF in them, so they are set here and nowhere else.
 */
const THEME = {
  fg: '#cfd3d7',
  bg: '#24292e',
  palette: [
    '#3b4048',
    '#df6974',
    '#36cb61',
    '#e5c07b',
    '#4e9ccd',
    '#9b72e3',
    '#4ec9d3',
    '#cfd3d7',
    '#6d6d98',
    '#f97583',
    '#56d364',
    '#ffc777',
    '#79c0ff',
    '#c8a2ff',
    '#56d4dd',
    '#ffffff',
  ].join(':'),
};

const [name, castOut, textOut] = process.argv.slice(2);
const scene = name === undefined ? undefined : scenes[name];
if (!scene || !castOut || !textOut) {
  console.error(
    `usage: node maintenance/scripts/demo/record.ts <${Object.keys(scenes).join('|')}> <out.cast> <out.txt>`,
  );
  process.exit(2);
}

const demoDir = import.meta.dirname;
const example = path.resolve(demoDir, '../../../example');
const driverPath = path.resolve(demoDir, '../../../packages/stackctl/e2e/pty_driver.py');

const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';
// oxlint-disable-next-line no-control-regex -- OSC 52: ESC ] 52 ; <target> ; <base64> BEL or ST
const OSC52 = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g;

const { cols, rows } = scene;
const driver = spawn(
  'python3',
  [
    '-B',
    '-u',
    driverPath,
    String(rows),
    String(cols),
    '--',
    ...(scene.program ?? ['bash', '--noprofile', '--norc']),
  ],
  {
    cwd: example,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: 'en_US.UTF-8',
      PS1: '$ ',
      HISTFILE: '/dev/null',
      // macOS's bash otherwise opens with a notice that zsh is the default shell.
      BASH_SILENCE_DEPRECATION_WARNING: '1',
      // The footer's git branch reads `main` whatever branch this is recorded from.
      STACKCTL_DEMO_RECORDING: '1',
      // A copy goes out as OSC 52 (see above).
      SSH_TTY: 'recording',
    },
    stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
  },
);
const events = readline.createInterface({ input: driver.stdio[3] as NodeJS.ReadableStream });
let exited = false;
events.on('line', (line) => {
  if ((JSON.parse(line) as { event: string }).event === 'exit') {
    exited = true;
  }
});

const screen = new Screen(rows, cols);
const decoder = new TextDecoder('utf-8');
const start = performance.now();
const cast: [number, 'o', string][] = [];
let pending = '';
let inSync = false;
let copied = null as string | null;
// Set by the scene (through the stage), so typed as what it can become, not as its first value.
let snapshot = null as string | null;
/** How many of the cast's events had been cut when the snapshot was taken: a still's frame. */
let snapshotAt = 0;

driver.stdout!.on('data', (chunk: Buffer) => {
  screen.feed(chunk);
  pending += decoder.decode(chunk, { stream: true });
  for (const match of pending.matchAll(OSC52)) {
    copied = Buffer.from(match[1]!, 'base64').toString('utf8');
  }
  // Emit up to the last point outside a synchronized update; keep an update still open.
  let cut = 0;
  let at = 0;
  for (;;) {
    const on = pending.indexOf(SYNC_ON, at);
    const off = pending.indexOf(SYNC_OFF, at);
    if (inSync) {
      if (off < 0) {
        break;
      }
      inSync = false;
      at = off + SYNC_OFF.length;
      cut = at;
    } else if (on >= 0) {
      cut = on;
      inSync = true;
      at = on + SYNC_ON.length;
    } else {
      cut = pending.length;
      break;
    }
  }
  if (cut > 0) {
    cast.push([(performance.now() - start) / 1000, 'o', pending.slice(0, cut)]);
    pending = pending.slice(cut);
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function write(text: string): void {
  driver.stdin!.write(
    `${JSON.stringify({ op: 'write', data: Buffer.from(text).toString('base64') })}\n`,
  );
}

const KEYS: Record<string, string> = {
  enter: '\r',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  esc: '\x1b',
  'ctrl-c': '\x03',
};

const stage: Stage = {
  async press(key, ms) {
    write(KEYS[key] ?? key);
    await sleep(ms);
  },
  async type(text) {
    for (const char of text) {
      write(char);
      await sleep(TYPING_MS);
    }
  },
  paste(text) {
    write(text);
  },
  sleep,
  async waitFor(text, timeout = 60_000) {
    const until = performance.now() + timeout;
    while (!screen.dump().includes(text)) {
      if (exited || performance.now() > until) {
        throw new Error(`never showed ${JSON.stringify(text)}:\n${screen.dump()}`);
      }
      await sleep(50);
    }
  },
  doubleClick(text, offset) {
    const at = screen.find(text);
    if (!at) {
      throw new Error(`${JSON.stringify(text)} isn't on screen:\n${screen.dump()}`);
    }
    // One write: the two presses must land within stackctl's double-click window.
    const report = `\x1b[<0;${at.col + offset};${at.row}`;
    write(`${report}M${report}m${report}M${report}m`);
  },
  async waitForPrompt(timeout = 30_000) {
    const until = performance.now() + timeout;
    while (
      screen
        .lines()
        .filter((line) => line !== '')
        .at(-1) !== '$'
    ) {
      if (exited || performance.now() > until) {
        throw new Error(`the shell's prompt never came back:\n${screen.dump()}`);
      }
      await sleep(50);
    }
  },
  async waitForExit(timeout = 180_000) {
    const until = performance.now() + timeout;
    // `exited` is set by the driver's exit event, between these sleeps.
    for (;;) {
      if (exited) {
        return;
      }
      if (performance.now() > until) {
        throw new Error(`the program never exited:\n${screen.dump()}`);
      }
      await sleep(50);
    }
  },
  copied: () => copied,
  rowOf: (text) => screen.find(text)?.row ?? null,
  text(value) {
    snapshotAt = cast.length;
    snapshot = value;
  },
  snapshot(from = 1, to = rows) {
    snapshotAt = cast.length;
    snapshot = screen
      .lines()
      .slice(from - 1, to)
      .map((line) => line.trimEnd())
      .join('\n')
      // The screen's empty stretches, as one blank line: it is text to read, not a screen.
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+|\n+$/g, '');
  },
};

let failure: string | null = null;
try {
  if (!scene.program) {
    await stage.waitForPrompt();
    await sleep(600);
  }
  failure = (await scene.play(stage)) ?? null;
} finally {
  driver.stdin!.end();
}

if (failure) {
  console.error(`record.ts: ${name}: ${failure}`);
  process.exit(1);
}
if (snapshot === null) {
  console.error(`record.ts: ${name}: the scene took no snapshot`);
  process.exit(1);
}
if (pending !== '') {
  cast.push([(performance.now() - start) / 1000, 'o', pending]);
}
// A still is everything drawn up to its snapshot, as one event: the player lands on that screen.
const frames: typeof cast = scene.still
  ? [
      [
        0,
        'o',
        cast
          .slice(0, snapshotAt)
          .map(([, , data]) => data)
          .join(''),
      ],
    ]
  : cast;
const header = { version: 2, width: cols, height: rows, theme: THEME };
fs.writeFileSync(
  castOut,
  [header, ...frames].map((line) => JSON.stringify(line)).join('\n') + '\n',
);
fs.writeFileSync(textOut, `${snapshot}\n`);
console.log(
  scene.still
    ? `record.ts: ${name}: a still`
    : `record.ts: ${name}: ${cast.length} frames, ${cast.at(-1)![0].toFixed(1)}s`,
);
