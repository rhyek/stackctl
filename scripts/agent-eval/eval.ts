#!/usr/bin/env node
// Measures how well each way of telling a coding agent about stackctl works: it asks Claude Code
// the same questions in the same workspace under each setup, and grades what it did. See README.md.
//
//   node scripts/agent-eval/eval.ts setup  --work <dir>
//   node scripts/agent-eval/eval.ts state  --work <dir> healthy|crashed|stopped
//   node scripts/agent-eval/eval.ts run    --work <dir> --out <dir> [--setups a,b] [--tasks x,y] [--reps 3] [--concurrency 4] [--model sonnet]
//   node scripts/agent-eval/eval.ts report --out <dir>
//   node scripts/agent-eval/eval.ts prune  --out <dir>
//   node scripts/agent-eval/eval.ts e2e    --work <dir> --out <dir> [--setups none,all] [--reps 3]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  grade,
  parseEvent,
  partsOf,
  readRun,
  repo,
  resolveSetup,
  settled,
  setups,
  stepOf,
  tasks,
  testsPassedAnywhere,
  testsPassedInTestMode,
} from './lib.ts';
import type { Grade, State, Step } from './lib.ts';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    work: { type: 'string' },
    out: { type: 'string' },
    setups: { type: 'string' },
    tasks: { type: 'string' },
    reps: { type: 'string', default: '3' },
    concurrency: { type: 'string', default: '4' },
    model: { type: 'string', default: 'sonnet' },
    'home-skills': { type: 'string' },
  },
});
const [command, arg] = positionals;

const need = (name: 'work' | 'out'): string => {
  const value = opts[name];
  if (!value) {
    console.error(`eval: --${name} <dir> is required`);
    process.exit(2);
  }
  return path.resolve(value);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the workspace ─────────────────────────────────────────────────────────────────────────────

const baseDir = (work: string) => path.join(work, 'base/example');
const setupDir = (work: string, name: string) => path.join(work, 'setups', name);

/** A person's shell: none of the variables a coding agent sets, so stackctl logs a person. */
function personEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  return {
    HOME: home,
    PATH: process.env.PATH,
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    DOCKER_CONFIG: path.join(home, '.docker'),
    ASDF_DATA_DIR: process.env.ASDF_DATA_DIR ?? path.join(home, '.asdf'),
  };
}

/** Removes the example's tutorial comments and its mentions of stackctl: a real repo has neither. */
function neutralize(dir: string): void {
  const walk = (at: string): string[] =>
    fs.readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      if (/^(node_modules|\.vscode|dist|\.output|\.tanstack)$/.test(entry.name)) {
        return [];
      }
      const file = path.join(at, entry.name);
      return entry.isDirectory() ? walk(file) : [file];
    });
  for (const file of walk(dir)) {
    const name = path.basename(file);
    const hashes = name.startsWith('.env') || /\.ya?ml$/.test(name) || name === 'Makefile';
    const slashes = /\.(ts|tsx|mts|go|json)$/.test(name) && name !== 'package.json';
    if (!hashes && !slashes) {
      continue;
    }
    const kept: string[] = [];
    let inBlock = false;
    for (let line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (slashes) {
        if (inBlock) {
          inBlock = !trimmed.includes('*/');
          continue;
        }
        if (trimmed.startsWith('/*')) {
          inBlock = !trimmed.includes('*/');
          continue;
        }
        if (trimmed.startsWith('//') && !trimmed.startsWith('///')) {
          continue;
        }
        const tail = /\s+\/\/ .*$/.exec(line);
        const before = tail ? line.slice(0, tail.index) : '';
        if (tail && ["'", '"', '`'].every((q) => before.split(q).length % 2 === 1)) {
          line = before;
        }
      }
      if (hashes && trimmed.startsWith('#') && !trimmed.startsWith('#!')) {
        continue;
      }
      kept.push(line);
    }
    fs.writeFileSync(file, kept.join('\n').replaceAll(/\n{3,}/g, '\n\n'));
  }
  const edit = (file: string, change: (text: string) => string) => {
    const at = path.join(dir, file);
    fs.writeFileSync(at, change(fs.readFileSync(at, 'utf8')));
  };
  edit('package.json', (text) => {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    pkg.name = 'todo-app';
    delete pkg.description;
    return `${JSON.stringify(pkg, null, 2)}\n`;
  });
  edit('libs/db/src/pool.ts', (text) =>
    text.replace(/'DATABASE_URI is not set\.[^']*'/, "'DATABASE_URI is not set.'"),
  );
  edit('libs/db/src/seed.ts', (text) =>
    text
      .replace("'Read the stackctl docs'", "'Buy milk'")
      .replace("'Run `pnpm stackctl infra start`'", "'Water the plants'"),
  );
  // every setup's copy shares one node_modules: without this, pnpm re-verifies it whenever a
  // different copy runs a script, and concurrent runs would race on it
  edit('pnpm-workspace.yaml', (text) => `${text.trimEnd()}\nverifyDepsBeforeRun: false\n`);
  const left = walk(dir).filter(
    (file) =>
      !/(stackctl\.config\.ts|package\.json|pnpm-lock\.yaml|tsconfig\.json)$/.test(file) &&
      /stackctl|sctl/.test(fs.readFileSync(file, 'utf8')),
  );
  if (left.length > 0) {
    throw new Error(`still mention stackctl: ${left.join(', ')}`);
  }
}

/** Every `node_modules` under the base copy, relative to it. */
function nodeModulesDirs(base: string): string[] {
  const found: string[] = [];
  const walk = (rel: string, depth: number) => {
    for (const entry of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
      if (entry.name === 'node_modules') {
        found.push(path.join(rel, entry.name));
      } else if (entry.isDirectory() && depth < 3 && !entry.name.startsWith('.')) {
        walk(path.join(rel, entry.name), depth + 1);
      }
    }
  };
  walk('', 0);
  return found;
}

function setup(work: string): void {
  const base = baseDir(work);
  if (!fs.existsSync(base)) {
    fs.mkdirSync(path.dirname(base), { recursive: true });
    // -c clones the files on macOS, so the copy costs no disk
    execFileSync('cp', [
      process.platform === 'darwin' ? '-ac' : '-a',
      path.join(repo, 'example'),
      base,
    ]);
    fs.rmSync(path.join(base, 'node_modules/.stackctl'), { recursive: true, force: true });
    fs.rmSync(path.join(base, '.claude'), { recursive: true, force: true });
    // the example's `link:../packages/stackctl` resolves here
    fs.symlinkSync(path.join(repo, 'packages'), path.join(work, 'base/packages'));
    neutralize(base);
    console.log(`setup: base copy at ${base}`);
  }
  const wanted = opts.setups ? opts.setups.split(',') : Object.keys(setups);
  for (const name of wanted) {
    const { files, env, otherSkills } = resolveSetup(name);
    const dir = setupDir(work, name);
    fs.rmSync(dir, { recursive: true, force: true });
    const copy = path.join(dir, 'example');
    fs.cpSync(base, copy, {
      recursive: true,
      filter: (source) => path.basename(source) !== 'node_modules',
    });
    // one set of dependencies and one session's state, shared by every setup's copy
    for (const rel of nodeModulesDirs(base)) {
      fs.symlinkSync(path.join(base, rel), path.join(copy, rel));
    }
    fs.symlinkSync(path.join(repo, 'packages'), path.join(dir, 'packages'));
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
      fs.writeFileSync(path.join(copy, file), text);
    }
    if (otherSkills) {
      // a crowded listing: other skills, installed for the user
      if (!opts['home-skills']) {
        throw new Error(`${name} needs --home-skills <dir>: a directory of other skills' folders`);
      }
      fs.cpSync(path.resolve(opts['home-skills']), path.join(dir, '.claude-config/skills'), {
        recursive: true,
      });
    }
    fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify(env));
    console.log(`setup: ${name}: ${Object.keys(files).join(', ') || '(nothing)'}`);
  }
}

// ── the session every run works against ───────────────────────────────────────────────────────

interface Status {
  running: boolean;
  status?: { ready?: Record<string, boolean>; services?: Record<string, string> };
}

function stackctl(work: string, args: string[], timeout = 120_000): string {
  return execFileSync('pnpm', ['stackctl', ...args], {
    cwd: baseDir(work),
    env: personEnv(),
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function status(work: string): Status {
  return JSON.parse(stackctl(work, ['status', '--json'])) as Status;
}

const SERVICES = ['backend', 'worker', 'frontend'];
const allReady = (s: Status) => s.running && SERVICES.every((name) => s.status?.ready?.[name] === true); // oxfmt-ignore

function inState(s: Status, state: State): boolean {
  if (state === 'stopped') {
    return !s.running;
  }
  if (state === 'healthy') {
    return allReady(s);
  }
  return s.running && s.status?.ready?.backend === false;
}

async function until(work: string, what: string, test: (s: Status) => boolean, seconds = 120) {
  for (let i = 0; i < seconds; i++) {
    if (test(status(work))) {
      return;
    }
    await sleep(1000);
  }
  throw new Error(`state: gave up waiting for ${what}`);
}

async function ensureSession(work: string): Promise<void> {
  if (status(work).running) {
    return;
  }
  const log = fs.openSync(path.join(work, 'session.log'), 'a');
  const child = spawn('pnpm', ['stackctl', '--headless', ...SERVICES.flatMap((s) => ['-s', s])], {
    cwd: baseDir(work),
    env: personEnv(),
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  fs.writeFileSync(path.join(work, 'session.pid'), String(child.pid));
  console.log(`state: started the session (pid ${child.pid})`);
  await until(work, 'the session to be ready', allReady, 240);
}

const personRestartedDb = (work: string) => {
  const file = path.join(baseDir(work), 'node_modules/.stackctl/modes/development/events.log');
  return (
    fs.existsSync(file) &&
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .some((line) => line.includes('"type":"infra-command"') && line.includes('"action":"restart"') && line.includes('"kind":"cli"')) // oxfmt-ignore
  );
};

async function setState(work: string, state: State): Promise<void> {
  if (state === 'stopped') {
    if (status(work).running) {
      stackctl(work, ['stop']);
    }
    await until(work, 'the session to stop', (s) => !s.running);
  } else if (state === 'healthy') {
    await ensureSession(work);
    if (!personRestartedDb(work)) {
      // what `who-restarted` asks about; with no request just before it, the backend survives
      stackctl(work, ['infra', 'restart', '-s', 'db']);
      await sleep(12_000);
    }
    if (!allReady(status(work))) {
      stackctl(work, ['service', 'restart', '-s', 'backend']);
    }
    await until(work, 'every service to be ready', allReady);
  } else if (!inState(status(work), 'crashed')) {
    await ensureSession(work);
    await until(work, 'every service to be ready', allReady);
    // a request leaves a connection idle in the backend's pool; restarting Postgres then crashes it
    const config = JSON.parse(stackctl(work, ['show-config'])) as { services: { backend: { port: number } } }; // oxfmt-ignore
    const { port } = config.services.backend;
    await fetch(`http://localhost:${port}/todos`);
    stackctl(work, ['infra', 'restart', '-s', 'db']);
    await until(work, 'the backend to crash', (s) => inState(s, 'crashed'), 60);
  }
  console.log(`state: ${state}`);
}

// ── running ───────────────────────────────────────────────────────────────────────────────────

interface Job {
  setup: string;
  task: string;
  rep: number;
  file: string;
}

interface Meta {
  setup: string;
  task: string;
  rep: number;
  model: string;
  stopped: 'settled' | 'exit' | 'timeout';
  exitCode: number | null;
  ms: number;
  utilization: Record<string, number>;
}

const TIMEOUT_MS = 300_000;
const lastUtilization: Record<string, number> = {};

function runJob(work: string, job: Job, act = false): Promise<Meta> {
  const home = setupDir(work, job.setup);
  const realHome = os.homedir();
  // the developer's own instructions are found through their real home, whatever HOME says
  const excludes = [`${realHome}/.claude/**`];
  for (const link of [`${realHome}/.claude/CLAUDE.md`, `${realHome}/.claude/rules`]) {
    try {
      excludes.push(`${path.dirname(fs.readlinkSync(link))}/**`);
    } catch {
      // not a link
    }
  }
  const settings = {
    claudeMdExcludes: excludes,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node ${path.join(import.meta.dirname, 'guard.ts')}` }], // oxfmt-ignore
        },
      ],
    },
  };
  const task = tasks[job.task]!;
  fs.mkdirSync(path.dirname(job.file), { recursive: true });
  const out = fs.createWriteStream(job.file);
  const started = Date.now();
  const child = spawn(
    'claude',
    [
      '--no-session-persistence',
      '--settings', JSON.stringify(settings),
      '--model', opts.model!,
      '-p', task.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', act ? '80' : '40',
      '--allowedTools', 'Read', 'Glob', 'Grep', 'Skill',
      '--disallowedTools', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit',
    ], // oxfmt-ignore
    {
      cwd: path.join(home, 'example'),
      env: {
        ...personEnv(),
        // in the end-to-end check the guard lets stackctl and the test script take effect
        ...(act ? { AGENT_EVAL_ACT: '1' } : {}),
        ...(JSON.parse(fs.readFileSync(path.join(home, 'env.json'), 'utf8')) as Record<
          string,
          string
        >),
        HOME: home,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude-config'),
        CLAUDE_CODE_OAUTH_TOKEN: fs.readFileSync(path.join(repo, '.local/claude-oauth-token'), 'utf8').trim(), // oxfmt-ignore
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return new Promise((resolve) => {
    let stopped: Meta['stopped'] = 'exit';
    const steps: Step[] = [];
    let isSettled = false;
    let buffer = '';
    const stop = (why: Meta['stopped']) => {
      if (stopped === 'exit') {
        stopped = why;
        child.kill('SIGTERM');
      }
    };
    const timer = setTimeout(() => stop('timeout'), act ? 3 * TIMEOUT_MS : TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      out.write(chunk);
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const event = parseEvent(line);
        if (!event) {
          continue;
        }
        if (event.type === 'rate_limit_event') {
          for (const [name, w] of Object.entries(event.rate_limit_info?.unifiedWindows ?? {})) {
            lastUtilization[name] = w.utilization;
          }
        } else if (event.type === 'assistant') {
          for (const part of partsOf(event)) {
            const step = stepOf(part);
            if (step) {
              steps.push(step);
            }
          }
          if (!act && !isSettled && settled(task, steps)) {
            isSettled = true;
            // its refusal is the next event; don't wait long for it
            setTimeout(() => stop('settled'), 5000);
          }
        } else if (event.type === 'user' && isSettled) {
          stop('settled');
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => fs.appendFileSync(`${job.file}.stderr`, chunk));
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      out.end();
      const meta: Meta = {
        setup: job.setup,
        task: job.task,
        rep: job.rep,
        model: opts.model!,
        stopped,
        exitCode,
        ms: Date.now() - started,
        utilization: { ...lastUtilization },
      };
      fs.writeFileSync(job.file.replace(/\.jsonl$/, '.json'), `${JSON.stringify(meta)}\n`);
      resolve(meta);
    });
  });
}

async function run(work: string, outDir: string): Promise<void> {
  const wantedSetups = opts.setups ? opts.setups.split(',') : Object.keys(setups);
  const wantedTasks = opts.tasks ? opts.tasks.split(',') : Object.keys(tasks);
  const reps = Number(opts.reps);
  for (const state of ['healthy', 'crashed', 'stopped'] as const) {
    const jobs: Job[] = [];
    // repetition by repetition, so a drift over time lands on every setup alike
    for (let rep = 1; rep <= reps; rep++) {
      for (const task of wantedTasks.filter((name) => tasks[name]?.state === state)) {
        for (const name of wantedSetups) {
          const file = path.join(outDir, name, task, `${rep}.jsonl`);
          if (!fs.existsSync(file.replace(/\.jsonl$/, '.json'))) {
            jobs.push({ setup: name, task, rep, file });
          }
        }
      }
    }
    if (jobs.length === 0) {
      continue;
    }
    await setState(work, state);
    console.log(`run: ${jobs.length} runs with the session ${state}`);
    let next = 0;
    let done = 0;
    let broken = false;
    const worker = async () => {
      while (!broken) {
        const job = jobs[next++];
        if (!job) {
          return;
        }
        if (!inState(status(work), state)) {
          await sleep(5000);
          if (!inState(status(work), state)) {
            broken = true;
            console.error(`run: the session is no longer ${state}; stopping before ${job.file}`);
            return;
          }
        }
        const meta = await runJob(work, job);
        const g = grade(tasks[job.task]!, readRun(job.file));
        const verdict = g.pass === null ? 'control' : g.pass ? 'pass' : 'FAIL';
        console.log(
          `[${++done}/${jobs.length}] ${job.setup} ${job.task} #${job.rep}: ${verdict}` +
            ` (${meta.stopped}, ${Math.round(meta.ms / 1000)}s${g.skill ? ', skill' : ''}${g.docs ? ', docs' : ''})` +
            ` usage ${JSON.stringify(meta.utilization)}`,
        );
      }
    };
    await Promise.all(Array.from({ length: Number(opts.concurrency) }, worker));
    if (broken) {
      process.exit(1);
    }
  }
}

// ── the end-to-end check ──────────────────────────────────────────────────────────────────────

interface Outcome {
  setup: string;
  task: string;
  rep: number;
  pass: boolean;
  /** What the pass rests on, by name. */
  checks: Record<string, boolean>;
  ms: number;
}

/** Whether the test mode's session runs. */
const testSessionRuns = (work: string) =>
  (JSON.parse(stackctl(work, ['--mode', 'test', 'status', '--json'])) as Status).running;

/**
 * Two tasks run for real, one at a time: the guard lets stackctl and the test script take
 * effect, and each run is judged by what is true afterwards, not by the command it chose.
 */
async function e2e(work: string, outDir: string): Promise<void> {
  const wantedSetups = opts.setups ? opts.setups.split(',') : ['none', 'all'];
  for (const name of wantedSetups) {
    // a stackctl command that acts on a session checks it was started from the same config
    // file: the copy's config becomes a link to the base's, where the session runs
    const config = path.join(setupDir(work, name), 'example/stackctl.config.ts');
    fs.rmSync(config, { force: true });
    fs.symlinkSync(path.join(baseDir(work), 'stackctl.config.ts'), config);
  }
  const outcomes: Outcome[] = [];
  for (const task of ['app-down', 'run-tests']) {
    for (let rep = 1; rep <= Number(opts.reps); rep++) {
      for (const name of wantedSetups) {
        const file = path.join(outDir, name, task, `${rep}.jsonl`);
        const outcomeFile = file.replace(/\.jsonl$/, '.outcome.json');
        if (fs.existsSync(outcomeFile)) {
          outcomes.push(JSON.parse(fs.readFileSync(outcomeFile, 'utf8')) as Outcome);
          continue;
        }
        if (testSessionRuns(work)) {
          stackctl(work, ['--mode', 'test', 'stop']);
        }
        await setState(work, tasks[task]!.state);
        const meta = await runJob(work, { setup: name, task, rep, file }, true);
        const ran = readRun(file);
        const now = status(work);
        const checks: Record<string, boolean> =
          task === 'app-down'
            ? { 'every service ready': allReady(now) }
            : {
                'tests passed': testsPassedAnywhere(ran),
                'in the test mode': testsPassedInTestMode(ran),
                'dev session untouched': allReady(now),
                'test session stopped': !testSessionRuns(work),
              };
        const outcome: Outcome = { setup: name, task, rep, pass: Object.values(checks).every(Boolean), checks, ms: meta.ms }; // oxfmt-ignore
        fs.writeFileSync(outcomeFile, `${JSON.stringify(outcome)}\n`);
        outcomes.push(outcome);
        console.log(`e2e: ${name} ${task} #${rep}: ${outcome.pass ? 'pass' : 'FAIL'} ${JSON.stringify(checks)} (${Math.round(meta.ms / 1000)}s)`); // oxfmt-ignore
      }
    }
  }
  if (testSessionRuns(work)) {
    stackctl(work, ['--mode', 'test', 'stop']);
  }
  const lines = ['| Setup | Task | Finished | What held |', '| --- | --- | --- | --- |'];
  for (const name of wantedSetups) {
    for (const task of ['app-down', 'run-tests']) {
      const mine = outcomes.filter((o) => o.setup === name && o.task === task);
      const held = Object.keys(mine[0]?.checks ?? {}).map((check) => `${check} ${mine.filter((o) => o.checks[check]).length}/${mine.length}`); // oxfmt-ignore
      lines.push(`| ${name} | ${task} | ${mine.filter((o) => o.pass).length}/${mine.length} | ${held.join(', ')} |`); // oxfmt-ignore
    }
  }
  fs.writeFileSync(path.join(outDir, 'report.md'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

// ── reporting ─────────────────────────────────────────────────────────────────────────────────

interface Row extends Grade {
  setup: string;
  task: string;
  rep: number;
  stopped: string;
  turns: number | null;
  costUsd: number | null;
  ms: number;
}

function collect(outDir: string): Row[] {
  const rows: Row[] = [];
  for (const name of fs.readdirSync(outDir)) {
    if (!fs.statSync(path.join(outDir, name)).isDirectory()) {
      continue;
    }
    for (const task of fs.readdirSync(path.join(outDir, name))) {
      for (const file of fs.readdirSync(path.join(outDir, name, task))) {
        if (!file.endsWith('.jsonl') || !tasks[task]) {
          continue;
        }
        const at = path.join(outDir, name, task, file);
        const metaFile = at.replace(/\.jsonl$/, '.json');
        if (!fs.existsSync(metaFile)) {
          continue;
        }
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Meta;
        const r = readRun(at);
        rows.push({ ...grade(tasks[task]!, r), setup: name, task, rep: meta.rep, stopped: meta.stopped, turns: r.turns, costUsd: r.costUsd, ms: meta.ms }); // oxfmt-ignore
      }
    }
  }
  return rows;
}

const pct = (n: number, of: number) => (of === 0 ? '–' : `${Math.round((100 * n) / of)}%`);

function report(outDir: string): void {
  const rows = collect(outDir);
  // each setup, then its harder variants
  const names = [...new Set(rows.map((row) => row.setup))];
  const rank = (name: string) => Object.keys(setups).indexOf(name.split('+')[0]!);
  const order = names.toSorted((a, b) => a.split('+').length - b.split('+').length || a.split('+').slice(1).join().localeCompare(b.split('+').slice(1).join()) || rank(a) - rank(b)); // oxfmt-ignore
  const graded = rows.filter((row) => row.pass !== null);
  const lines: string[] = [];
  lines.push('| Setup | Pass rate | Went around stackctl | Never acted | Loaded the skill | Read llms.txt | Read the playbook |'); // oxfmt-ignore
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const name of order) {
    const mine = graded.filter((row) => row.setup === name);
    const count = (test: (row: Row) => boolean) => mine.filter(test).length;
    lines.push(
      `| ${name} | ${pct(count((r) => r.pass === true), mine.length)} (${count((r) => r.pass === true)}/${mine.length}) | ${pct(count((r) => r.outcome === 'wrong'), mine.length)} | ${pct(count((r) => r.outcome === 'none'), mine.length)} | ${pct(count((r) => r.skill), mine.length)} | ${pct(count((r) => r.index), mine.length)} | ${pct(count((r) => r.playbook), mine.length)} |`, // oxfmt-ignore
    );
  }
  lines.push(
    '',
    `| Task | ${order.join(' | ')} |`,
    `| --- | ${order.map(() => '---').join(' | ')} |`,
  );
  for (const task of Object.keys(tasks)) {
    const cells = order.map((name) => {
      const mine = rows.filter((row) => row.setup === name && row.task === task);
      if (mine.length === 0) {
        return '';
      }
      return tasks[task]!.kind === 'control'
        ? `skill ${mine.filter((r) => r.skill).length}/${mine.length}, docs ${mine.filter((r) => r.docs).length}/${mine.length}`
        : `${mine.filter((r) => r.pass).length}/${mine.length}` +
            (mine.some((r) => r.outcome === 'none') ? ` (${mine.filter((r) => r.outcome === 'none').length} never acted)` : ''); // oxfmt-ignore
    });
    if (cells.some(Boolean)) {
      lines.push(`| ${task} | ${cells.join(' | ')} |`);
    }
  }
  const text = `${lines.join('\n')}\n`;
  fs.writeFileSync(path.join(outDir, 'report.md'), text);
  fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(rows, null, 1)}\n`);
  // what to read when checking that the graders judged each run rightly
  const review = rows
    .filter((row) => row.pass !== null)
    .map(
      (row) =>
        `${row.outcome} ${row.setup} ${row.task} #${row.rep}: ${row.why}` +
        row.undecided.map((c) => `\n    undecided: ${c.replaceAll('\n', ' ')}`).join(''),
    );
  fs.writeFileSync(path.join(outDir, 'review.txt'), `${review.join('\n')}\n`);
  console.log(text);
}

/**
 * Deletes the runs a grader fix has left cut short: stopped at a command that decided them
 * then, and decides nothing now. `run` then does them again.
 */
function prune(outDir: string): void {
  const cut = collect(outDir).filter((row) => row.stopped === 'settled' && tasks[row.task]!.kind !== 'control' && !row.decided); // oxfmt-ignore
  for (const row of cut) {
    const file = path.join(outDir, row.setup, row.task, `${row.rep}`);
    fs.rmSync(`${file}.jsonl`);
    fs.rmSync(`${file}.json`);
    console.log(`prune: ${row.setup} ${row.task} #${row.rep}`);
  }
  console.log(`prune: ${cut.length} runs to do again`);
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────

if (command === 'setup') {
  setup(need('work'));
} else if (command === 'state') {
  await setState(need('work'), arg as State);
} else if (command === 'run') {
  await run(need('work'), need('out'));
  report(need('out'));
} else if (command === 'report') {
  report(need('out'));
} else if (command === 'prune') {
  prune(need('out'));
} else if (command === 'e2e') {
  await e2e(need('work'), need('out'));
} else {
  console.error(
    'usage: eval.ts setup|state|run|report|prune|e2e (see the comment at the top of the file)',
  );
  process.exit(2);
}
