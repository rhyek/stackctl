// The coding-agent conversations agent-chat.ts replays: real runs of Claude Code with what
// stackctl offers to install (the rules file and the skill), in a copy of the
// example workspace (see README.md), up to the agent's answer. Left out: what the recording's own
// setup caused, the tests run's wait loop its permissions refused. Each tool's output is
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

/** What both runs read first: the docs' index, as the rules file says, then the playbook it names. */
const readDocs: ToolStep[] = [
  { tool: 'Read', input: 'node_modules/stackctl/docs/llms.txt', output: ['Read 47 lines'], think: 1600 }, // oxfmt-ignore
  { tool: 'Read', input: 'node_modules/stackctl/docs/ai/playbook.md', output: ['Read 243 lines'] },
];

export const conversations: Record<string, Conversation> = {
  // "The app is down": `stackctl infra restart -s db` from another terminal took the backend down,
  // whose pg pool has no error handler; the event log says who restarted the database.
  restart: {
    prompt: "the app isn't loading, can you check what's going on?",
    steps: [
      { tool: 'Skill', input: 'stackctl', output: ['Launching skill: stackctl'], think: 1600 },
      ...readDocs,
      {
        tool: 'Bash',
        input: 'pnpm stackctl status',
        output: [
          'development session: running since today 19:04:23 (pid 72629, control port 14025), started by a person',
          'services  backend   running, not ready',
          '          frontend  running, not ready',
          '          worker    running, ready',
        ],
        more: 16,
        run: 1200,
      },
      {
        tool: 'Bash',
        input:
          "pnpm stackctl show-config | jq '.services | map_values({ port, publicOrigin, healthcheck })'",
        output: [
          '{',
          '  "backend": {',
          '    "port": 3001,',
          '    "publicOrigin": "http://api.localhost:21050",',
        ],
        more: 22,
        run: 1200,
      },
      {
        say: 'Backend and frontend are running but not ready, and db was restarted right after the session started. Checking logs.',
        think: 2200,
        pause: 700,
      },
      {
        tool: 'Bash',
        input:
          "pnpm stackctl logs | grep -iE 'error|exception|ECONN|fail' | tail -30; echo ---; pnpm stackctl logs | tail -25",
        output: [
          "2026-11-11 19:05:12 [backend   ]     throw er; // Unhandled 'error' event",
          '2026-11-11 19:05:12 [backend   ] error: terminating connection due to administrator command',
          '2026-11-11 19:05:12 [backend   ]     at parseErrorMessage (node_modules/.pnpm/pg-protocol@1.16.1/node_modules/pg-protocol/dist/parser.js:306:11)',
          "2026-11-11 19:05:12 [backend   ] Emitted 'error' event on BoundPool instance at:",
        ],
        more: 36,
        run: 1200,
      },
      {
        say: "The backend crashed when the db was restarted. I'll restart it with stackctl, which is the recipe for this case.",
        think: 1800,
        pause: 600,
      },
      {
        tool: 'Bash',
        input: 'pnpm stackctl service restart -s backend; pnpm stackctl status | head -6',
        output: [
          'restarting backend',
          'stackctl: waiting for backend to be healthy',
          'stackctl: everything is healthy',
          'development session: running since today 19:04:23 (pid 72629, control port 14025), started by a person',
        ],
        more: 5,
        run: 2600,
      },
      {
        say: "The app was down because the backend crashed, and it's now fixed. All three services (backend, frontend, worker) are running and ready.\n\n**Cause:** at 19:05:12 someone ran `stackctl infra restart -s db`, which restarted the database. The backend's Postgres pool got `terminating connection due to administrator command`. It had no handler for that error, so the process crashed. The dev script then sat on \"Waiting for file changes before restarting…\", so the backend stayed \"running\" but never came back. The frontend stayed not-ready because it depends on the backend.\n\n**Fix:** I ran `stackctl service restart -s backend`. It came back healthy and the frontend followed.\n\n**Follow-up:** the backend will crash again on any future database restart or dropped connection. The fix is an `error` listener on the pg Pool (`pool.on('error', …)`) so a dropped idle connection doesn't throw as an unhandled event. I haven't changed any code. Do you want me to add that handler?",
        think: 2600,
      },
    ],
  },

  // "Run the tests": a test-mode session of the backend, the suite in its environment, then quit.
  tests: {
    prompt: "run the backend's tests",
    steps: [
      ...readDocs,
      { tool: 'Read', input: 'node_modules/stackctl/docs/guide/testing.md', output: ['Read 101 lines'] }, // oxfmt-ignore
      {
        say: 'Following the playbook: find the config, test mode and service names.',
        think: 1400,
        pause: 500,
      },
      {
        tool: 'Bash',
        input:
          "ls -a && npx stackctl show-config | jq '.services | map_values({port, command})' && npx stackctl --mode test status",
        output: ['.', '..', '.claude', '.env'],
        more: 52,
        run: 1400,
      },
      {
        say: "No test session is running, so I'll start one for the backend in the background.",
        think: 1600,
        pause: 500,
      },
      {
        tool: 'Bash',
        input: 'npx stackctl --mode test --headless -s backend',
        output: ['Running in the background (↓ to manage)'],
      },
      {
        tool: 'Bash',
        input: 'cat node_modules/.stackctl/modes/test/running.json',
        output: [
          '{',
          '  "port": 14059,',
          '  "pid": 75771,',
          '  "sessionId": "a20d4bad-8bdf-45ec-8388-562f43124103",',
        ],
        more: 10,
      },
      {
        tool: 'Bash',
        input:
          'timeout 120 curl -sN "http://127.0.0.1:14059/events" | grep -m1 -E \'"sessionReady":true|"type":"session-state","ready":true|"status":"stopped"\'',
        output: [
          '{"type":"snapshot","pid":75771,"sessionId":"a20d4bad-8bdf-45ec-8388-562f43124103","configPath":"stackctl.config.ts","mode":"test","modeSource":"flag","startedByAgent":true,"logFile":"node_modules/.stackctl/modes/test/logs/1794445560265-75771-1.log","services":',
        ],
        run: 2500,
      },
      { say: "Ready. Running the tests in the test mode's environment.", think: 1200, pause: 500 },
      {
        tool: 'Bash',
        input: 'npx stackctl --mode test run backend test',
        output: [
          '✔ lists the todos (61.719875ms)',
          '✔ rejects a todo without a title (14.42275ms)',
          '✔ adds a todo, completes it and deletes it (20.679625ms)',
          'ℹ tests 3',
        ],
        more: 7,
        run: 1800,
      },
      { say: 'Tests passed. Stopping the test session.', think: 1000, pause: 500 },
      {
        tool: 'Bash',
        input: 'curl -s -X POST http://127.0.0.1:14059/command/quit',
        output: ['{"ok":true}'],
        run: 1200,
      },
      {
        say: "All 3 backend tests passed: lists the todos, rejects a todo without a title, and adds, completes and deletes a todo.\n\nI ran them in stackctl's `test` mode, which has its own ports and database, so your development data wasn't touched. No test session was running beforehand, so I started one for the backend, ran `stackctl --mode test run backend test`, and then quit the session.",
        think: 2000,
      },
    ],
  },
};
