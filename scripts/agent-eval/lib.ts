// The eval's setups, tasks and graders. See README.md.
import fs from 'node:fs';
import path from 'node:path';
import { allowed, reads, segments } from './guard.ts';

export const repo = path.join(import.meta.dirname, '../..');
const asset = (name: string) => fs.readFileSync(path.join(repo, 'packages/stackctl/assets', name), 'utf8'); // oxfmt-ignore
const skillFile = () => fs.readFileSync(path.join(repo, 'packages/stackctl/skills/stackctl/SKILL.md'), 'utf8'); // oxfmt-ignore
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'); // oxfmt-ignore

// ── setups ────────────────────────────────────────────────────────────────────────────────────

/** The files a setup adds to the workspace, by path. */
export type Setup = () => Record<string, string>;

const SKILL = '.claude/skills/stackctl/SKILL.md';
const RULE = '.claude/rules/stackctl.md';
const block = (text: string) => `<!-- BEGIN:stackctl -->\n${text.trim()}\n<!-- END:stackctl -->\n`;

/** The built package's own renderers, for the setup that is exactly what `stackctl init` writes. */
interface Product {
  renderSkill: (version: string) => string;
  renderRules: (version: string) => string;
  renderAgentsBlock: (version: string) => string;
  readOwnVersion: () => string;
}
const dist = (name: string) => path.join(repo, 'packages/stackctl/dist', name);
const product: Product | null = fs.existsSync(dist('agent-rules.js'))
  ? {
      ...((await import(dist('skill.js'))) as Pick<Product, 'renderSkill' | 'readOwnVersion'>),
      ...((await import(dist('agent-rules.js'))) as Pick<Product, 'renderRules' | 'renderAgentsBlock'>), // oxfmt-ignore
    }
  : null;

export const setups: Record<string, Setup> = {
  /** Nothing: stackctl is installed and configured, and the agent is told nothing about it. */
  none: () => ({}),
  /** The skill as it stood before this work: a 2,357-character description and a long body. */
  'skill-old': () => ({ [SKILL]: fixture('skill-0.4.0-draft.md') }),
  /** The skill alone: a short description and a body that points at llms.txt. */
  skill: () => ({ [SKILL]: skillFile() }),
  /** The always-on text as a Claude Code rules file. */
  rule: () => ({ [RULE]: asset('agent-rules.md') }),
  /** The always-on text as a block in CLAUDE.md. */
  'claude-md': () => ({ 'CLAUDE.md': block(asset('agent-rules.md')) }),
  /** The always-on text as a block in AGENTS.md, with no CLAUDE.md. */
  'agents-md': () => ({ 'AGENTS.md': block(asset('agent-rules.md')) }),
  /** What `stackctl init` installs: the skill, the rules file and the AGENTS.md block. */
  all: () => ({
    [SKILL]: skillFile(),
    [RULE]: asset('agent-rules.md'),
    'AGENTS.md': block(asset('agent-rules.md')),
  }),
  /** `all`, byte for byte as the built package writes it: banners, markers and the block's heading. */
  init: () => {
    if (!product) {
      throw new Error('the init setup needs the package built: pnpm build');
    }
    const version = product.readOwnVersion();
    return {
      [SKILL]: product.renderSkill(version),
      [RULE]: product.renderRules(version),
      'AGENTS.md': product.renderAgentsBlock(version),
    };
  },
  /** The rules file with three guard-rail lines added. */
  'rule-guards': () => ({ [RULE]: fixture('agent-rules-guards.md') }),
  /** Everything, with the guard-rail lines in the always-on text. */
  'all-guards': () => ({
    [SKILL]: skillFile(),
    [RULE]: fixture('agent-rules-guards.md'),
    'AGENTS.md': block(fixture('agent-rules-guards.md')),
  }),
};

/**
 * A condition makes a setup harder, as a suffix on its name (`skill+crowded`):
 * - `crowded`: the user has 43 other skills installed, all listed with their descriptions.
 * - `overbudget`: the same, with the skill listing held to 8,000 characters, so it overflows
 *   and Claude Code lists the skills it has no usage for, stackctl's among them, by name only.
 *   Current models' 1M-token windows fit all 43; this is the heavier user, or a smaller window.
 * - `busy`: the project's own instructions file already holds a page of unrelated rules.
 */
export const conditions: Record<
  string,
  { env?: Record<string, string>; otherSkills?: boolean; instructions?: string }
> = {
  // oxfmt-ignore
  crowded: { otherSkills: true },
  overbudget: { env: { SLASH_COMMAND_TOOL_CHAR_BUDGET: '8000' }, otherSkills: true },
  busy: { instructions: fixture('project-instructions.md') },
};

/** A setup's files and what its conditions add, from a name like `all+crowded+busy`. */
export function resolveSetup(name: string) {
  const [base, ...suffixes] = name.split('+');
  const make = setups[base!];
  if (!make || suffixes.some((suffix) => !conditions[suffix])) {
    throw new Error(`no setup named ${name}`);
  }
  const files = make();
  const env: Record<string, string> = {};
  let otherSkills = false;
  for (const suffix of suffixes) {
    const condition = conditions[suffix]!;
    Object.assign(env, condition.env);
    otherSkills ||= condition.otherSkills === true;
    if (condition.instructions) {
      // in the file the agent reads: AGENTS.md is skipped when there is a CLAUDE.md
      const file = 'CLAUDE.md' in files || !('AGENTS.md' in files) ? 'CLAUDE.md' : 'AGENTS.md';
      files[file] = `${condition.instructions.trim()}\n${files[file] ? `\n${files[file]}` : ''}`;
    }
  }
  return { base: base!, files, env, otherSkills };
}

// ── a run, read from its stream-json transcript ───────────────────────────────────────────────

export interface Step {
  tool: string;
  /** A Bash command, a file path, or a skill's name. */
  text: string;
  /** What a Write or Edit would have put in the file. */
  content?: string;
  /** What the tool gave back. */
  result?: string;
}

export interface Run {
  steps: Step[];
  /** The agent's last words: the result when the run finished, else its last text. */
  answer: string;
  finished: boolean;
  turns: number | null;
  costUsd: number | null;
  outputTokens: number | null;
  model: string | null;
}

/** One part of a message in Claude Code's stream-json output: text, a tool call or its result. */
export interface StreamPart {
  type: string;
  id?: string;
  tool_use_id?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}

/** One line of Claude Code's stream-json output, as far as the eval reads it. */
export interface StreamEvent {
  type?: string;
  subtype?: string;
  model?: string;
  message?: { content?: StreamPart[] | string };
  result?: unknown;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { output_tokens?: number };
  rate_limit_info?: { unifiedWindows?: Record<string, { utilization: number }> };
}

/** A line as an event, or `null` for one that is blank or was cut off when the run was stopped. */
export function parseEvent(line: string): StreamEvent | null {
  try {
    return line.trim() ? (JSON.parse(line) as StreamEvent) : null;
  } catch {
    return null;
  }
}

/** The parts of an event's message. */
export function partsOf(event: StreamEvent): StreamPart[] {
  const content = event.message?.content;
  return Array.isArray(content) ? content : [];
}

/** A tool call as a step, or `null` for a part that isn't one. */
export function stepOf(part: StreamPart): Step | null {
  if (part.type !== 'tool_use') {
    return null;
  }
  const input = part.input ?? {};
  const text = input.command ?? input.file_path ?? input.skill ?? input.pattern;
  const content = input.content ?? input.new_string;
  return {
    tool: part.name ?? '',
    text: typeof text === 'string' ? text : '',
    ...(typeof content === 'string' && content ? { content } : {}),
  };
}

export function readRun(file: string): Run {
  const run: Run = { steps: [], answer: '', finished: false, turns: null, costUsd: null, outputTokens: null, model: null }; // oxfmt-ignore
  const byId = new Map<string, Step>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const event = parseEvent(line);
    if (!event) {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      run.model = event.model ?? null;
    } else if (event.type === 'user') {
      for (const part of partsOf(event)) {
        const step = part.type === 'tool_result' ? byId.get(part.tool_use_id ?? '') : undefined;
        if (step) {
          step.result = typeof part.content === 'string' ? part.content : JSON.stringify(part.content); // oxfmt-ignore
        }
      }
    } else if (event.type === 'assistant') {
      for (const part of partsOf(event)) {
        const step = stepOf(part);
        if (step) {
          run.steps.push(step);
          byId.set(part.id ?? '', step);
        } else if (part.type === 'text' && part.text?.trim()) {
          run.answer = part.text;
        }
      }
    } else if (event.type === 'result') {
      run.finished = event.subtype === 'success';
      run.answer = typeof event.result === 'string' && event.result ? event.result : run.answer;
      run.turns = event.num_turns ?? null;
      run.costUsd = event.total_cost_usd ?? null;
      run.outputTokens = event.usage?.output_tokens ?? null;
    }
  }
  return run;
}

// ── reading a command ─────────────────────────────────────────────────────────────────────────

/** Each stackctl invocation in a command: its mode and its arguments without the mode. */
export function stackctlCalls(command: string): { mode: string | null; args: string[] }[] {
  const calls: { mode: string | null; args: string[] }[] = [];
  for (const segment of segments(command) ?? command.split(/[;&|\n()]+/)) {
    const words = (segment.match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g) ?? []).filter(
      (_word, i, all) => !/^\d?>>?$|^&>$|^<$/.test(all[i - 1] ?? ''),
    );
    const at = words.findIndex((w) => /(^|\/)(stackctl|sctl)$/.test(w));
    if (at === -1) {
      continue;
    }
    let mode: string | null = null;
    const args: string[] = [];
    const rest = words.slice(at + 1);
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i]!;
      if (w === '--') {
        args.push(...rest.slice(i));
        break;
      }
      if (w === '--mode' || w === '-m') {
        mode = rest[++i] ?? null;
      } else if (w.startsWith('--mode=')) {
        mode = w.slice('--mode='.length);
      } else if (!/^[<>&|]|^\d?>/.test(w)) {
        args.push(w);
      }
    }
    calls.push({ mode, args });
  }
  return calls;
}

/** The flags of stackctl that take a value, which is then no subcommand. */
const VALUE_FLAGS =
  /^(-s|--service|-n|--lines|--log-dir|--run|--target|--wait-timeout|--workspace-dir)$/;
/** A call's words that aren't flags or a flag's value: its subcommand and operands. */
const sub = (call: { args: string[] }) =>
  call.args.filter((a, i, all) => !a.startsWith('-') && !VALUE_FLAGS.test(all[i - 1] ?? ''));
const KILL = /(?<![\w-])(?:kill|pkill|killall)(?![\w-])/;
const BARE_COMPOSE = /(?<!\binfra\s+)\bdocker[ -]compose\b/;
// `docker exec` is left out: it is how an agent looks inside a container, and what it runs
// there (a `DROP`, a `psql` restore) is the tasks' own business
const DOCKER_CHANGE = /\bdocker\s+(?:restart|stop|start|kill|rm|run|volume\s+(?:rm|prune)|system\s+prune)\b/; // oxfmt-ignore
/** A service's own dev script or binary, started around stackctl. */
const DIRECT_START =
  /\b(?:pnpm|npm|yarn|bun)\s+(?:(?:--filter|-F|-C|--dir|--prefix)[= ]\S+\s+)+(?:run\s+)?(?:dev|start)\b|\bcd\s+\S*(?:apps|libs)\/\S*\s*(?:&&|;)\s*(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:dev|start)\b|\bmake\s+(?:start|dev|run)\b|\bnode\s+--watch\b|\bgo\s+run\b|\bvite\b/;
const posts = (command: string, route: RegExp) =>
  /\bcurl\b/.test(command) && /-X\s*POST|--request\s+POST|-d\b|--data/.test(command) && route.test(command); // oxfmt-ignore

/** Whether the command starts a stackctl session: `stackctl`, `stackctl start`, or the root dev script. */
export function startsSession(command: string): boolean {
  if (DIRECT_START.test(command)) {
    return false;
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?dev\b/.test(command)) {
    return true;
  }
  return stackctlCalls(command).some((call) => {
    const [first] = sub(call);
    return (
      !call.args.some((a) => a === '--help' || a === '-h' || a === '--version') &&
      (first === undefined || first === 'start')
    );
  });
}

// ── tasks ─────────────────────────────────────────────────────────────────────────────────────

export type State = 'healthy' | 'crashed' | 'stopped';
export type Verdict = 'pass' | 'fail';

export interface Task {
  /** What the session is doing when the agent is asked. */
  state: State;
  /** What a person would type: no stackctl words. */
  prompt: string;
  /**
   * `action`: graded on the first command that would change something and that `decide` knows.
   * `answer`: runs to its end and is graded on what it said or read.
   * `control`: has nothing to do with stackctl; only what it loaded is measured.
   */
  kind: 'action' | 'answer' | 'control';
  /** A refused command's verdict, or `null` when it decides nothing. */
  decide?: (command: string) => Verdict | null;
  /** For `answer` tasks: whether the finished run passes. */
  passes?: (run: Run) => boolean;
  /** What a pass is, for the report. */
  pass: string;
  /** What a fail is, for the report. */
  fail: string;
}

const around = (command: string) =>
  KILL.test(command) || BARE_COMPOSE.test(command) || DOCKER_CHANGE.test(command);

export const tasks: Record<string, Task> = {
  'restart-service': {
    state: 'healthy',
    kind: 'action',
    prompt: 'Restart the backend service.',
    pass: '`stackctl service restart -s backend`, or the control API’s restart',
    fail: 'a kill, a second session, the service’s own dev script, stopping the stack',
    decide: (c) => {
      const calls = stackctlCalls(c);
      if (around(c) || DIRECT_START.test(c) || startsSession(c) || posts(c, /\/command\/quit/)) {
        return 'fail';
      }
      if (calls.some((call) => sub(call)[0] === 'stop' || sub(call)[0] === 'reset')) {
        return 'fail';
      }
      if (calls.some((call) => sub(call)[0] === 'service') || posts(c, /\/command\/service\//)) {
        return 'pass';
      }
      return null;
    },
  },
  'stop-stack': {
    state: 'healthy',
    kind: 'action',
    prompt: "Shut down the dev servers, I'm done for the day.",
    pass: '`stackctl stop`, or `POST /command/quit`',
    fail: 'a kill, `docker compose down`, stopping containers with docker',
    decide: (c) => {
      if (around(c)) {
        return 'fail';
      }
      if (stackctlCalls(c).some((call) => sub(call)[0] === 'stop') || posts(c, /\/command\/quit/)) {
        return 'pass';
      }
      return null;
    },
  },
  'reset-db': {
    state: 'healthy',
    kind: 'action',
    prompt: 'Wipe the dev database and give me a fresh one.',
    pass: '`stackctl infra reset` or `infra destroy`',
    fail: 'a bare `docker compose down -v`, removing the volume or container with docker, dropping tables by hand',
    decide: (c) => {
      const calls = stackctlCalls(c);
      if (
        calls.some(
          (call) => sub(call)[0] === 'infra' && /^(reset|destroy)$/.test(sub(call)[1] ?? ''),
        )
      ) {
        // oxfmt-ignore
        return 'pass';
      }
      if (posts(c, /\/command\/infra\/(reset|destroy)/)) {
        return 'pass';
      }
      if (
        around(c) ||
        /\b(?:psql|dropdb|createdb)\b|\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b|\bTRUNCATE\b|\brm\s+-/i.test(
          c,
        )
      ) {
        // oxfmt-ignore
        return 'fail';
      }
      if (calls.some((call) => sub(call)[0] === 'reset')) {
        return 'fail'; // deletes the mode's own state, not the database
      }
      return null;
    },
  },
  'restart-db': {
    state: 'healthy',
    kind: 'action',
    prompt: 'Restart the Postgres container.',
    pass: '`stackctl infra restart -s db`, or Compose through `stackctl infra docker-compose`',
    fail: 'a bare `docker compose restart`, `docker restart`',
    decide: (c) => {
      if (around(c)) {
        return 'fail';
      }
      const calls = stackctlCalls(c);
      if (
        calls.some(
          (call) =>
            sub(call)[0] === 'infra' &&
            /^(restart|stop|start|docker-compose|compose)$/.test(sub(call)[1] ?? ''),
        )
      ) {
        // oxfmt-ignore
        return 'pass';
      }
      if (posts(c, /\/command\/infra\/(restart|stop|start)/)) {
        return 'pass';
      }
      return null;
    },
  },
  'run-tests': {
    state: 'healthy',
    kind: 'action',
    prompt: "Run the backend's tests.",
    pass: 'anything started or run with `--mode test`',
    fail: 'the test script run directly or in the development session',
    decide: (c) => {
      const calls = stackctlCalls(c);
      if (calls.some((call) => call.mode === 'test')) {
        return 'pass';
      }
      if (
        around(c) ||
        startsSession(c) ||
        calls.some((call) => /^(run|exec)$/.test(sub(call)[0] ?? ''))
      ) {
        // oxfmt-ignore
        return 'fail';
      }
      if (/\b(?:pnpm|npm|yarn|bun)\b[^|;&]*\btest\b|\bnode\s+[^|;&]*--test\b|\bvitest\b/.test(c)) {
        return 'fail';
      }
      return null;
    },
  },
  'run-script': {
    state: 'healthy',
    kind: 'action',
    prompt: 'Run the db seed script against the dev database.',
    pass: '`stackctl exec` or `stackctl run`',
    fail: 'the script run directly, with the environment missing or pasted in by hand',
    decide: (c) => {
      const calls = stackctlCalls(c);
      if (
        calls.some(
          (call) => sub(call)[0] === 'infra' && /^(reset|destroy)$/.test(sub(call)[1] ?? ''),
        )
      ) {
        // oxfmt-ignore
        return 'fail';
      }
      if (calls.some((call) => /^(run|exec)$/.test(sub(call)[0] ?? ''))) {
        return 'pass';
      }
      if (around(c) || /\b(?:node|tsx|ts-node|bun|deno|pnpm|npm|yarn)\b[^|;&]*\bseed\b/.test(c)) {
        return 'fail';
      }
      return null;
    },
  },
  'app-down': {
    state: 'crashed',
    kind: 'action',
    prompt: 'The app is down. Get it back up.',
    pass: '`stackctl service restart -s backend`, or the control API’s restart',
    fail: 'a kill, a second session, stopping the stack, restarting or resetting infra',
    decide: (c) => {
      const calls = stackctlCalls(c);
      if (around(c) || DIRECT_START.test(c) || startsSession(c) || posts(c, /\/command\/quit/)) {
        return 'fail';
      }
      if (
        calls.some((call) => /^(stop|reset|infra)$/.test(sub(call)[0] ?? '')) ||
        posts(c, /\/command\/infra\//)
      ) {
        // oxfmt-ignore
        return 'fail';
      }
      if (calls.some((call) => sub(call)[0] === 'service') || posts(c, /\/command\/service\//)) {
        return 'pass';
      }
      return null;
    },
  },
  'start-background': {
    state: 'stopped',
    kind: 'action',
    prompt: "Start the app in the background and tell me when it's ready.",
    pass: 'a stackctl session started in the background',
    fail: '`start --detach`, each service’s own dev script, `docker compose up`',
    decide: (c) => {
      if (around(c) || DIRECT_START.test(c) || /--detach\b/.test(c)) {
        return 'fail';
      }
      return startsSession(c) ? 'pass' : null;
    },
  },
  'already-running': {
    state: 'healthy',
    kind: 'answer',
    prompt: 'Start the app so I can try it in the browser.',
    pass: 'finds it already running and gives its address, starting nothing',
    fail: 'starts a second session or a service’s own dev script',
    decide: (c) => (around(c) || DIRECT_START.test(c) || startsSession(c) ? 'fail' : null),
    passes: (run) => run.finished && /localhost(:\d+)?/.test(run.answer),
  },
  url: {
    state: 'healthy',
    kind: 'answer',
    prompt: 'What URL do I open in the browser to see the frontend?',
    pass: 'answers with the reverse proxy’s address for it, `http://app.localhost:21050` or the bare `http://localhost:21050`',
    fail: 'any other address',
    passes: (run) => /(?<![\w.])(?:app\.)?localhost:21050/.test(run.answer),
  },
  'who-restarted': {
    state: 'healthy',
    kind: 'answer',
    prompt: "The database restarted earlier today and I didn't do it. What restarted it?",
    pass: 'names the `stackctl infra restart` that someone ran in a terminal',
    fail: 'any other answer',
    passes: (run) => /infra\s+restart/.test(run.answer),
  },
  logs: {
    state: 'healthy',
    kind: 'answer',
    prompt: "Show me the backend's most recent log lines.",
    pass: 'reads them with `stackctl logs` or from the session’s log file',
    fail: 'finds no logs, or reads something else',
    passes: (run) =>
      run.steps.some(
        (step) =>
          /\.stackctl\/modes\/[^/\s]+\/logs\//.test(step.text) ||
          (step.tool === 'Bash' && stackctlCalls(step.text).some((call) => sub(call)[0] === 'logs')), // oxfmt-ignore
      ),
  },
  // ── round two: prompts that don't look like stackctl's business, or name the way around it ──
  'port-in-use': {
    state: 'healthy',
    kind: 'answer',
    prompt: 'Something is already using port 3001 and I need it free. Sort it out.',
    pass: 'stops the backend through stackctl, or says the port is the dev session’s backend and asks first',
    fail: 'kills whatever holds the port',
    passes: (run) => run.finished && /backend/i.test(run.answer) && /stackctl|session|dev stack/i.test(run.answer), // oxfmt-ignore
    decide: (c) => {
      if (around(c)) {
        return 'fail';
      }
      const calls = stackctlCalls(c);
      if (
        calls.some((call) => /^(service|stop)$/.test(sub(call)[0] ?? '')) ||
        posts(c, /\/command\/(service|quit)/)
      ) {
        // oxfmt-ignore
        return 'pass';
      }
      return null;
    },
  },
  'asked-to-kill': {
    state: 'healthy',
    kind: 'action',
    prompt: 'Kill the frontend dev server.',
    pass: '`stackctl service stop -s frontend`, or the control API’s stop',
    fail: 'a `kill` or `pkill`',
    decide: (c) => {
      if (around(c)) {
        return 'fail';
      }
      const calls = stackctlCalls(c);
      if (
        calls.some((call) => /^(service|stop)$/.test(sub(call)[0] ?? '')) ||
        posts(c, /\/command\/(service|quit)/)
      ) {
        // oxfmt-ignore
        return 'pass';
      }
      return null;
    },
  },
  'asked-for-compose': {
    state: 'healthy',
    kind: 'answer',
    prompt: "Run `docker compose ps` and tell me what's up.",
    pass: 'reports the project’s containers, db and mail, as up',
    fail: 'reports what a bare `docker compose ps` shows: nothing',
    passes: (run) => /\bmail\b/i.test(run.answer) && /healthy|running|\bup\b/i.test(run.answer),
  },
  'stale-worker': {
    state: 'healthy',
    kind: 'action',
    prompt:
      "I changed the worker's code but it still behaves the old way. Make it pick up the change.",
    pass: '`stackctl service restart -s worker`',
    fail: 'a kill, the worker’s own start command, a second session',
    decide: (c) => {
      if (around(c) || DIRECT_START.test(c) || startsSession(c)) {
        return 'fail';
      }
      const calls = stackctlCalls(c);
      if (calls.some((call) => sub(call)[0] === 'stop')) {
        return 'fail';
      }
      if (calls.some((call) => sub(call)[0] === 'service') || posts(c, /\/command\/service\//)) {
        return 'pass';
      }
      return null;
    },
  },
  'clean-copy': {
    state: 'healthy',
    kind: 'action',
    prompt:
      'Bring up a second copy of the backend with its own empty database, so I can try something without touching my dev data.',
    pass: 'a session in another mode (`--mode test`), or the `.env.<mode>` file of a new one',
    fail: 'a container or process started by hand, or anything that touches the development session',
    decide: (c) => {
      const calls = stackctlCalls(c);
      if (calls.some((call) => call.mode !== null && call.mode !== 'development')) {
        return 'pass';
      }
      // a `.env.<mode>` file is the first step of a mode of its own
      if (/>\s*\S*\.env\.(?!development\b|local\b)\w+/.test(c)) {
        return 'pass';
      }
      if (around(c) || DIRECT_START.test(c) || startsSession(c)) {
        return 'fail';
      }
      if (calls.some((call) => /^(service|stop|reset|infra|exec|run)$/.test(sub(call)[0] ?? ''))) {
        return 'fail'; // acts on the development session
      }
      if (/\b(?:psql|createdb)\b/.test(c)) {
        return 'fail';
      }
      return null;
    },
  },
  'ci-job': {
    state: 'healthy',
    kind: 'answer',
    prompt: "Write a GitHub Actions workflow that starts the stack and runs the backend's tests.",
    pass: 'the workflow starts the stack with `stackctl start --detach` (or `--headless`, or `startStack()`)',
    fail: 'it starts the services by hand, or with the interactive `pnpm dev`',
    passes: (run) => {
      const text = [...run.steps.map((step) => step.content ?? ''), run.answer].join('\n');
      return /stackctl\b[^\n]*(--detach|--headless)|startStack\(/.test(text);
    },
  },
  'control-frontend': {
    state: 'healthy',
    kind: 'control',
    prompt: "Change the frontend's main heading to say “My todos”.",
    pass: '',
    fail: '',
  },
  'control-backend': {
    state: 'healthy',
    kind: 'control',
    prompt: 'Add an optional `priority` number to the todos the backend accepts on POST /todos.',
    pass: '',
    fail: '',
  },
  'control-question': {
    state: 'healthy',
    kind: 'control',
    prompt: 'What does the worker service do? Read its code and tell me in two sentences.',
    pass: '',
    fail: '',
  },
};

// ── the end-to-end check ──────────────────────────────────────────────────────────────────────

/** Whether a run ran the backend's tests in the test mode's session and saw them all pass. */
export function testsPassedInTestMode(run: Run): boolean {
  return run.steps.some(
    (step) =>
      step.tool === 'Bash' &&
      stackctlCalls(step.text).some(
        (call) => call.mode === 'test' && /^(run|exec)$/.test(sub(call)[0] ?? ''),
      ) && // oxfmt-ignore
      testsPassed(step.result ?? ''),
  );
}

/** Whether a run saw the backend's tests pass at all, in whatever session. */
export function testsPassedAnywhere(run: Run): boolean {
  return run.steps.some((step) => step.tool === 'Bash' && testsPassed(step.result ?? ''));
}

/** node:test's summary: every test passed and none failed. */
const testsPassed = (output: string) => /\bpass [1-9]\d*\b/.test(output) && /\bfail 0\b/.test(output); // oxfmt-ignore

// ── grading ───────────────────────────────────────────────────────────────────────────────────

export interface Grade {
  /** `null` for a control task. */
  pass: boolean | null;
  /** `wrong`: went around stackctl, or answered wrongly. `none`: never acted (it asked, or gave up). */
  outcome: 'pass' | 'wrong' | 'none' | null;
  /** The command or reason the verdict rests on. */
  why: string;
  /** Loaded the stackctl skill. */
  skill: boolean;
  /** Read `llms.txt`. */
  index: boolean;
  /** Read the playbook. */
  playbook: boolean;
  /** Read any of stackctl's docs. */
  docs: boolean;
  /** Refused commands `decide` knew nothing about: read these when checking the graders. */
  undecided: string[];
  /** Whether a command decided it. A run stopped as decided that no longer is was cut short. */
  decided: boolean;
}

/**
 * A step that would have changed something, as the command `decide` reads: a refused Bash
 * command, or a file write as the redirection it amounts to. `null` for a step that only reads.
 */
function attempt(step: Step): string | null {
  if (step.tool === 'Bash') {
    if (allowed(step.text)) {
      return null;
    }
    // only the parts that don't read, and each `cd` before them: a file the command merely
    // prints (`cat docker-compose.yaml`, `cat src/seed.ts`) is no attempt at anything
    const parts = segments(step.text);
    const acting = parts?.filter((part) => !reads(part) || /^cd\s/.test(part)) ?? [];
    return acting.some((part) => !/^cd\s/.test(part)) ? acting.join(' && ') : step.text;
  }
  return /^(Write|Edit|MultiEdit)$/.test(step.tool) ? `> ${step.text}` : null;
}

export function grade(task: Task, run: Run): Grade {
  const touched = (re: RegExp) => run.steps.some((step) => re.test(step.text));
  const base = {
    skill: run.steps.some((step) => step.tool === 'Skill' && /(^|:)stackctl$/.test(step.text)),
    index: touched(/stackctl\/docs\/llms\.txt/),
    playbook: touched(/stackctl\/docs\/ai\/playbook\.md/),
    docs: touched(/stackctl\/docs\//),
  };
  const undecided: string[] = [];
  let decided: { verdict: Verdict; command: string } | null = null;
  for (const step of run.steps) {
    const command = attempt(step);
    if (command === null) {
      continue;
    }
    const verdict = task.decide?.(command) ?? null;
    if (verdict === null) {
      undecided.push(command);
    } else {
      decided = { verdict, command };
      break;
    }
  }
  if (task.kind === 'control') {
    return { ...base, pass: null, outcome: null, why: '', undecided, decided: false };
  }
  if (decided) {
    const pass = decided.verdict === 'pass';
    return { ...base, pass, outcome: pass ? 'pass' : 'wrong', why: decided.command, undecided, decided: true }; // oxfmt-ignore
  }
  if (task.kind === 'action') {
    const said = run.answer.replaceAll(/\s+/g, ' ').slice(0, 200);
    return { ...base, pass: false, outcome: 'none', why: `never acted: ${said}`, undecided, decided: false }; // oxfmt-ignore
  }
  const pass = task.passes!(run);
  const why = run.answer.replaceAll(/\s+/g, ' ').slice(0, 200);
  return { ...base, pass, outcome: pass ? 'pass' : 'wrong', why, undecided, decided: false };
}

/** When a live run has shown everything its grade needs, so it can be stopped. */
export function settled(task: Task, steps: Step[]): boolean {
  if (task.kind === 'control') {
    return steps.some((s) => /^(Edit|Write|MultiEdit)$/.test(s.tool));
  }
  return steps.some((s) => {
    const command = attempt(s);
    return command !== null && (task.decide?.(command) ?? null) !== null;
  });
}
