// The coding-agent conversations agent-chat.ts replays: real runs of Claude Code with what
// stackctl offers to install (the rules file and the skill), in a copy of the
// example workspace (see README.md), up to the agent's answer. Left out: what the recording's own
// setup caused. Each tool's output is
// its first lines, as Claude Code shows them, and `more` counts the rest. A Read's `Read N lines` and a background command's
// `Running in the background` are Claude Code's own display of the result, as it draws them.

/** A tool call: what Claude Code shows as `● Tool(input)` and, under it, `⎿ output`. */
export interface ToolStep {
  tool: string;
  input: string;
  output: string[];
  /** How many more lines the output had, folded away. */
  more?: number;
  /** How long the agent works before the call, and how long the call runs, in ms. */
  think?: number;
  run?: number;
}

/** What the agent says: paragraphs, `- ` list items, `**bold**` and `` `code` ``. */
export interface SayStep {
  say: string;
  think?: number;
  pause?: number;
}

export interface Conversation {
  prompt: string;
  steps: (ToolStep | SayStep)[];
}

/**
 * What both runs read first: the docs' index, as the rules file says, then the playbook it names,
 * at its length when the run was captured.
 */
const readDocs = (playbookLines: number): ToolStep[] => [
  { tool: 'Read', input: 'node_modules/stackctl/docs/llms.txt', output: ['Read 47 lines'], think: 1600 }, // oxfmt-ignore
  { tool: 'Read', input: 'node_modules/stackctl/docs/ai/playbook.md', output: [`Read ${String(playbookLines)} lines`] }, // oxfmt-ignore
];

export const conversations: Record<string, Conversation> = {
  // "The app is down": `stackctl infra restart -s db` from another terminal took the backend down,
  // whose pg pool has no error handler; the event log says who restarted the database.
  restart: {
    prompt: "the app isn't loading, can you check what's going on?",
    steps: [
      ...readDocs(245),
      {
        tool: 'Bash',
        input: 'pnpm stackctl --profile development status',
        output: [
          'development session: running since today 11:14:34 (pid 68544, control port 14096), started by a person',
          'services  backend   running, not ready',
          '          frontend  running, not ready',
          '          worker    running, ready',
        ],
        more: 9,
        run: 1200,
        think: 1400,
      },
      {
        tool: 'Bash',
        input:
          "pnpm stackctl --profile development logs | grep -iE 'error|exception|fail|refused' | tail -30; pnpm stackctl --profile development events -n 30",
        output: [
          "2026-11-12 11:14:41 [backend   ]     throw er; // Unhandled 'error' event",
          '2026-11-12 11:14:41 [backend   ] error: terminating connection due to administrator command',
          '2026-11-12 11:14:41 [backend   ]     at parseErrorMessage (node_modules/.pnpm/pg-protocol@1.16.1/node_modules/pg-protocol/dist/parser.js:306:11)',
          "2026-11-12 11:14:41 [backend   ] Emitted 'error' event on BoundPool instance at:",
        ],
        more: 19,
        run: 1400,
        think: 2200,
      },
      {
        tool: 'Bash',
        input:
          'pnpm stackctl --profile development service restart -s backend && pnpm stackctl --profile development status',
        output: [
          'restarting backend',
          'stackctl: waiting for backend to be healthy',
          'stackctl: everything is healthy',
          'development session: running since today 11:14:34 (pid 68544, control port 14096), started by a person',
        ],
        more: 13,
        run: 2600,
        think: 1800,
      },
      {
        say: "The app is loading again: I restarted the backend and all three services now report healthy.\n\n**Cause:** the database was restarted at 11:14:40 (`infra restart -s db`, run from the CLI by a person). That cut the backend's Postgres connection with `terminating connection due to administrator command`. The backend crashed on an unhandled pg error. Its watch-mode dev script stayed alive waiting for a file change, so the service showed `running, not ready`. The frontend went not-ready because it depends on the backend.\n\n**Fix:** `stackctl --profile development service restart -s backend`. Backend, frontend and worker are now `running, ready`, and the db and mail infra are up.\n\n**Underlying bug:** the backend has no error handler on its pg pool, so any future database restart will crash it the same way. Adding a `pool.on('error', …)` handler, or reconnect logic, in the backend would fix that. I haven't changed any code. Want me to look at it?",
        think: 2600,
      },
    ],
  },

  // "Run the tests": a test-profile session of the backend, waited on, the suite in its
  // environment, then stopped.
  tests: {
    prompt: "run the backend's tests",
    steps: [
      ...readDocs(245),
      {
        tool: 'Bash',
        input:
          "ls; ls .env* ; npx stackctl --profile test status; npx stackctl --profile development status; npx stackctl --profile test show-config | jq '.services | keys'", // oxfmt-ignore
        output: ['apps', 'docker-compose.yaml', 'libs', 'node_modules'],
        more: 25,
        run: 1600,
        think: 1400,
      },
      {
        say: 'Test profile exists, no session running. Start a test session of the backend in the background.',
        think: 1600,
        pause: 500,
      },
      {
        tool: 'Bash',
        input: 'npx stackctl --profile test --headless -s backend',
        output: ['Running in the background (↓ to manage)'],
      },
      {
        tool: 'Bash',
        input: 'npx stackctl --profile test wait && npx stackctl --profile test run backend test',
        output: [
          'stackctl: waiting for backend to be healthy',
          'stackctl: everything is healthy',
          'test session ready: pid 66053, control API on 14045, log node_modules/.stackctl/profiles/test/sessions/1794503613491/logs.txt', // oxfmt-ignore
          '✔ lists the todos (81.360709ms)',
        ],
        more: 10,
        run: 4000,
      },
      {
        tool: 'Bash',
        input: 'npx stackctl --profile test stop',
        output: ['stopped test session (pid 66053)'],
        run: 1200,
      },
      {
        say: "All 3 backend tests passed:\n\n- lists the todos\n- rejects a todo without a title\n- adds a todo, completes it and deletes it\n\nI ran them in stackctl's `test` profile. I started a test session for the backend, ran `stackctl --profile test run backend test`, then stopped the session. The development session wasn't running, and I didn't touch it.",
        think: 2000,
      },
    ],
  },
};
