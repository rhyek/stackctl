#!/usr/bin/env node
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { Command } from 'commander';
import { startedByAgent } from './agent-detection';
import { agentProfileRefusal } from './agent-profile';
import type { StartOptions } from './commands/default';
import { rootOptionsRefusal } from './commands/root-options';
import {
  ATTACH_COMMAND,
  DETACHED_SESSION_VAR,
  RELEASE_MESSAGE,
  RESOLVE_ONE_OFF_COMMAND,
  TARGET_BASE_VAR,
  captureShellEnv,
  dropInjectedEnv,
  markCliProcess,
  publishProfileSource,
  resolveProfile,
  takeNested,
} from './env-base';
import { exitOnFatalError } from './errors';
import { takeHandedBy } from './event-log';
import { passthroughArgs } from './infra/argv';
import type { OneOffAsk } from './one-off/resolve';
import { takeHandedSessionId } from './running';
// Records, as it loads, the environment and directory the process started with, which this file
// changes before a session starts over from them (see relaunch.ts).
import { relaunchWithCappedYoungGeneration } from './relaunch';
import { takeSdkResultFlag } from './sdk-result';
import { readOwnVersion } from './skill';
import { locateWorkspace, needsNoWorkspace, resolveWorkspaceDirArg } from './workspace-root';

// The entry point: Commander wiring only. What a command runs lives under `commands/` and is
// imported by its action, so a command loads its own code and nothing else's — `--help` and
// `logs` don't pay for the config, `exec` doesn't pay for a session.

// Node's compile cache, in its default place under the temp directory: what the command's action
// imports next (the config, its schema, the runner) starts from V8's cached code, not a fresh
// compile. A third of `exec`'s start. `NODE_DISABLE_COMPILE_CACHE` turns it off, as for any Node.
module.enableCompileCache();

// Before anything loads the config: from here on, `resolveEnv()`, `exec()` and `run()` throw
// rather than start another stackctl, which would load the config, and call them again.
markCliProcess();

// An SDK function that ran this command waits for its result on descriptor 3; the flag that says
// so is the SDK's, and never reaches Commander.
takeSdkResultFlag(process.argv);

/**
 * The directory stackctl was invoked from, captured before {@link anchorAtWorkspaceRoot} may
 * `chdir` us to the config root: what `exec`'s and `run`'s relative service path resolves against.
 */
const INVOCATION_CWD = process.cwd();

// A stackctl forked with an IPC channel (the session `startStack()` starts) ends with the process
// that forked it: the channel closes however that process ends, `kill -9` included. Before
// anything else, so it holds while the config loads and the infra comes up too: the disconnect is
// taken for a SIGTERM, which each phase answers as it would from a shell.
// The session `start --detach` forks holds to that until the command lets it go, once the session
// is ready: a `release` message, sent just before the command closes the channel. From then on
// it outlives the command.
const detachedSession = process.env[DETACHED_SESSION_VAR] === '1';
delete process.env[DETACHED_SESSION_VAR];
// What `start --detach` handed the session it forks: the base its typed `-s` resolved against.
const handedTargetBase = process.env[TARGET_BASE_VAR] || undefined;
delete process.env[TARGET_BASE_VAR];
if (process.channel) {
  const endWithParent = () => process.kill(process.pid, 'SIGTERM');
  process.on('disconnect', endWithParent);
  if (detachedSession) {
    const onMessage = (message: unknown) => {
      if ((message as { type?: unknown } | null)?.type === RELEASE_MESSAGE) {
        process.off('disconnect', endWithParent);
        process.off('message', onMessage);
      }
    };
    process.on('message', onMessage);
  }
  // Output may go to a pipe the parent has closed with it, which is no reason to fail a shutdown.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
}

// First of all: a stackctl started from a process another stackctl started inherits that one's
// `.env` values and `PORT`. They are not this invocation's ambient environment (see
// `INJECTED_ENV_VAR`), so drop them before the profile, or anything else, is read from it.
dropInjectedEnv();

// Resolved from raw argv and published to the environment before anything else runs: the config
// (whose `port`/`urls` callbacks resolve `.env` files) is loaded by the command's action, which
// Commander only reaches after parsing. Writing it back also hands every child process the profile
// for free, the way Vite exposes MODE.
// Its source is kept for the rest of this process only (`/query/status`, the session's first
// line); a stackctl this one starts resolves its own, `env`, from the `STACKCTL_PROFILE` it
// inherits.
try {
  const { profile, source } = resolveProfile(process.argv);
  // A coding agent never runs a command in a profile it didn't name (see agent-profile.ts).
  const refusal = agentProfileRefusal({
    agent: startedByAgent(),
    source,
    forked: process.channel !== undefined,
    argv: process.argv,
  });
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  process.env.STACKCTL_PROFILE = profile;
  publishProfileSource(source);
} catch (err) {
  // Runs before Commander, so there's no usage output to lean on — just say what's wrong.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Published alongside it, for the config's callbacks and every child process: the directory
// stackctl was invoked in and, once anchorAtWorkspaceRoot finds it, the workspace root. Both
// describe this invocation, so a value inherited from a stackctl that started this one is dropped.
process.env.STACKCTL_CWD = INVOCATION_CWD;
delete process.env.STACKCTL_WORKSPACE_DIR;
// A session that ran this command handed over who asked; nothing this runs may pass that on.
takeHandedBy();
// The id `start --detach` handed the session it starts: the session takes it, its services don't.
takeHandedSessionId();
// Whether this runs inside a command stackctl runs: an `exec` or `run` there only sets up the
// environment. What this runs doesn't pass it on.
takeNested();

/**
 * Very early step (runs for every command): find the workspace (`--workspace-dir` exactly, else the
 * nearest directory at or above the invocation directory with a stackctl config) and `chdir` into
 * it, so stackctl behaves identically from any subdirectory. Exits 1 when there is none, except
 * for `init`, `--help` and `--version`, which need no config. The config itself is loaded, and the
 * workspace's `.env` merged into our own environment, by the commands that use them (see
 * `commands/workspace.ts`).
 */
function anchorAtWorkspaceRoot(invocationCwd: string): void {
  let root: string;
  try {
    root = locateWorkspace({
      workspaceDir: resolveWorkspaceDirArg(process.argv),
      from: invocationCwd,
    }).root;
  } catch (err) {
    if (needsNoWorkspace(process.argv)) {
      return;
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (root !== process.cwd()) {
    process.chdir(root);
  }
  process.env.STACKCTL_WORKSPACE_DIR = root;
  // Before anything puts file values into `process.env`: what is there now is what the shell
  // handed us, and only that may win over a `.env` file (see captureShellEnv).
  captureShellEnv();
}

/** Commander option-parser for repeatable flags: `-s/--service`, `-t/--tag`. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `exec`'s and `run`'s own options. */
interface OneOffFlags {
  /** `-s`, repeatable: the many form. */
  service: string[];
  /** `-t`, repeatable: the many form. */
  tag: string[];
  ignoreSiblingError?: boolean;
}

/**
 * What a relative service path resolves against: the invocation directory, or the root when
 * `--workspace-dir` was given. Read in an action, once the CLI has anchored at the root.
 */
const invocationBase = () =>
  // Validated by anchorAtWorkspaceRoot already.
  resolveWorkspaceDirArg(process.argv) !== undefined ? process.cwd() : INVOCATION_CWD;

/**
 * What a relative `-s` path on `start` and `service` resolves against, as for `exec` and `run`
 * ({@link invocationBase}); a session `start --detach` forked takes the base its command had.
 */
const targetBase = () => handedTargetBase ?? invocationBase();

/** Where `exec` and `run` were invoked. */
const oneOffContext = () => ({ invocationCwd: INVOCATION_CWD, base: invocationBase() });

/**
 * A command's operands split at the raw `--`: Commander drops it and appends what follows to the
 * operands, so how many came after it is counted from argv. `after` is `undefined` with no `--`.
 */
function splitAtDashDash(operands: string[]): { before: string[]; after?: string[] } {
  const dashDash = process.argv.indexOf('--');
  if (dashDash === -1) {
    return { before: operands };
  }
  const cut = Math.max(0, operands.length - (process.argv.length - dashDash - 1));
  return { before: operands.slice(0, cut), after: operands.slice(cut) };
}

/** Whether `-s` or `-t` was given to `exec` or `run`: they run in several services. */
const isManyForm = (flags: OneOffFlags) => flags.service.length > 0 || flags.tag.length > 0;

/** Exits, saying so, when `--ignore-sibling-error` is given without `-s` or `-t`. */
function refuseLoneIgnoreSiblingError(flags: OneOffFlags): void {
  if (flags.ignoreSiblingError && !isManyForm(flags)) {
    console.error('--ignore-sibling-error needs -s or -t');
    process.exit(1);
  }
}

/** `exec` or `run` with `-s` or `-t`: `command` in every service they select. Exits. */
async function runManyForm(flags: OneOffFlags, command: OneOffAsk): Promise<never> {
  const { runOneOffMany } = await import('./commands/one-off-many');
  const selection = {
    targets: flags.service,
    tags: flags.tag,
    ignoreSiblingError: flags.ignoreSiblingError === true,
  };
  return runOneOffMany(command, selection, oneOffContext());
}

// ---------------------------------------------------------------------------
// Commander wiring
// ---------------------------------------------------------------------------

// `--profile`, declared on the root and again on each subcommand that takes it (see the note on
// `exec` for why both).
const PROFILE_FLAGS = '-p, --profile <name>';
const PROFILE_HELP =
  'environment profile selecting the .env.<profile> files to load (default: $STACKCTL_PROFILE, else "test" in CI, else "development"); a coding agent must name it on every command, development included';

// `--workspace-dir`, declared like `--profile`. Read from raw argv before Commander parses (the
// workspace is located first); the declaration is for --help and validation.
const WORKSPACE_DIR_FLAGS = '--workspace-dir <dir>';
const WORKSPACE_DIR_HELP =
  'the directory holding stackctl.config.ts, instead of the nearest one at or above the current directory';

// `-s`, declared on each command that takes it. On `start`, `service`, `exec` and `run` it names a
// service by its name or by a path (on `exec` and `run`, the many form, with a positional service
// as the single form); on `infra`, an infra service by its name.
const SERVICE_FLAGS = '-s, --service <service>';
const INFRA_SERVICE_FLAGS = '-s, --service <name>';

// `-t`, beside `-s` on `start`, `service`, `infra`, `exec` and `run`: every service of the kind
// the command acts on that has the tag.
const TAG_FLAGS = '-t, --tag <tag>';

// `exec` and `run` in several services: `-s` and `-t` as on `start`, and the flag that keeps the
// others running when one fails.
const ONE_OFF_SERVICE_HELP = 'a service to run it in, by its name or by a path (repeatable)';
const ONE_OFF_TAG_HELP = 'run it in every service with this tag (repeatable)';
const IGNORE_SIBLING_ERROR_FLAG = '--ignore-sibling-error';
const IGNORE_SIBLING_ERROR_HELP =
  'keep the other commands running when one fails; only with -s or -t';

const program = new Command()
  .name('stackctl')
  .description(
    "A terminal UI and CLI for a monorepo's services, infrastructure, tests and CI during development.",
  )
  .option(PROFILE_FLAGS, PROFILE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .version(readOwnVersion(), '-V, --version', "print stackctl's version");

/**
 * Where `exec`'s and `run`'s options go, said when `-s` is given before them:
 * `stackctl -s api exec …` reaches `start`, which owns `-s`, with `exec …` left over.
 */
const ONE_OFF_FORMS = new Map([
  ['exec', "exec's options go after it: stackctl exec -s api -- <command>"],
  ['run', "run's options go after it: stackctl run -s api <script>"],
]);

/**
 * `start` takes no arguments, but being the default command it is handed whatever Commander
 * couldn't place, so it says what that was: a one-off command after `start`'s options, a word in
 * a command's place that names none, or arguments to `start` itself.
 */
function refuseStartArguments(start: Command): never {
  const oneOff = ONE_OFF_FORMS.get(start.args[0] ?? '');
  if (oneOff) {
    console.error(oneOff);
    process.exit(1);
  }
  // A bare word first on the command line, which isn't `start`: what Commander reports as an
  // unknown command, which it never gets to once a default command takes the arguments.
  const [first] = program.args;
  if (first !== undefined && first !== 'start' && !first.startsWith('-')) {
    const commander = program as Command & { unknownCommand?: () => never };
    if (typeof commander.unknownCommand === 'function') {
      commander.unknownCommand(); // its own message, with its "Did you mean …?"
    }
    program.error(`error: unknown command '${first}'`, { code: 'commander.unknownCommand' });
  }
  start.error(
    `error: too many arguments for 'start'. Expected 0 arguments but got ${String(start.args.length)}: ${start.args.join(', ')}.`,
    { code: 'commander.excessArguments' },
  );
}

// The session, and the default command: `stackctl` and `stackctl -s api` are `stackctl start`.
program
  .command('start', { isDefault: true })
  .description(
    'start a dev session: the service picker and the TUI, or --headless (the default command)',
  )
  .option(
    SERVICE_FLAGS,
    'a service to run, by its name or by a path (repeatable, bypasses the interactive selector)',
    collect,
    [],
  )
  .option(
    TAG_FLAGS,
    'run every service with this tag (repeatable, adds to -s, bypasses the interactive selector)',
    collect,
    [],
  )
  .option(PROFILE_FLAGS, PROFILE_HELP) // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option('--ui', 'run the interactive TUI (default)')
  .option(
    '--headless',
    'run without the TUI, streaming logs to stdout (needs -s, -t or --last-answers)',
  )
  .option('--last-answers', 'skip the selector and reuse the last saved selection', false)
  .option(
    '--kill-others',
    "quit the stackctl session already running for this project in the same profile instead of asking (agents: don't pass this unprompted)",
    false,
  )
  .option(
    '-d, --detach',
    'for CI: start a headless session that outlives the command, wait until it is ready, print where it is, and exit (needs -s, -t or --last-answers; refused for a coding agent outside CI)',
  )
  .option(
    '--wait-timeout <seconds>',
    'how long --detach waits for the session to be ready (default: 300)',
    Number,
  )
  // Refused by the action, which can say what they were (see refuseStartArguments).
  .allowExcessArguments()
  .action(async (opts: StartOptions, start: Command) => {
    if (start.args.length > 0) {
      refuseStartArguments(start);
    }
    const refusal = rootOptionsRefusal(opts);
    if (refusal) {
      console.error(refusal);
      process.exit(1);
    }

    if (opts.detach) {
      const { detachRefusal, runDetach } = await import('./commands/detach');
      const agentRefusal = detachRefusal();
      if (agentRefusal) {
        console.error(agentRefusal);
        process.exit(1);
      }
      await (await import('./config-typecheck')).checkConfigTypes();
      await runDetach(opts, { targetBase: targetBase() });
    }

    relaunchWithCappedYoungGeneration();
    // After starting over, so it runs once; the session `--detach` starts was checked by it.
    if (!detachedSession) {
      await (await import('./config-typecheck')).checkConfigTypes();
    }
    const { runDefaultAction } = await import('./commands/default');
    await runDefaultAction(opts, { targetBase: targetBase(), detached: detachedSession });
  });

program
  .command('init')
  .description('set up stackctl.config.ts (and, optionally, the guidance for coding agents)')
  .option(WORKSPACE_DIR_FLAGS, 'create the config in this directory, instead of the current one')
  .option(
    '-y, --yes',
    'non-interactive: accept defaults (scaffold config + install the agent skill and rules file)',
  )
  .option('--agents-md', 'also add a stackctl section to AGENTS.md')
  .action(async (opts: { yes?: boolean; agentsMd?: boolean }) => {
    const { runInit } = await import('./init');
    // From raw argv, since the option is global: it may precede `init`.
    let given: string | undefined;
    try {
      given = resolveWorkspaceDirArg(process.argv);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    const cwd = given === undefined ? undefined : path.resolve(INVOCATION_CWD, given);
    if (cwd !== undefined && !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`--workspace-dir ${cwd} is not a directory`);
      process.exit(1);
    }
    await runInit({ cwd, yes: opts.yes, agentsMd: opts.agentsMd });
    // For the SDK's `init()`, which resolves once this is written: it has nothing to hand over.
    const { writeSdkResult } = await import('./sdk-result');
    writeSdkResult({});
  });

program
  .command('stop')
  .description("stop this workspace's stackctl session of the profile (infra isn't touched)")
  .option(PROFILE_FLAGS, PROFILE_HELP) // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .action(async () => {
    const { runStop } = await import('./commands/stop');
    process.exit(await runStop(process.cwd()));
  });

program
  .command('wait')
  .description(
    "wait until this workspace's session of the profile is ready, one started in the background: its services and infra up and healthy (read-only)",
  )
  .option(PROFILE_FLAGS, PROFILE_HELP) // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option(
    '--timeout <seconds>',
    'how long to wait for the session to start and be ready (default: 300)',
    Number,
  )
  .action(async (opts: { timeout?: number }) => {
    const { runWait } = await import('./commands/wait');
    process.exit(await runWait({ timeout: opts.timeout }));
  });

// Not listed: what the SDK's `attach()` runs. `wait` for a session that must be running already.
program
  .command(ATTACH_COMMAND, { hidden: true })
  .option(PROFILE_FLAGS, PROFILE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option('--timeout <seconds>', 'how long to wait for it to be ready', Number)
  .action(async (opts: { timeout?: number }) => {
    const { runWait } = await import('./commands/wait');
    process.exit(await runWait({ timeout: opts.timeout, waitForStart: false }));
  });

// `service`: application services of the profile's running session (see `commands/service.ts`).
const service = program
  .command('service')
  .description(
    "start, stop or restart application services in this workspace's running session of the profile",
  )
  .option(PROFILE_FLAGS, PROFILE_HELP) // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP);

const SERVICE_ACTIONS = [
  [
    'start',
    'start the services, adding any the session was started without, and wait until they are ready',
  ],
  ['stop', 'stop the services (the ones that wait on them keep running)'],
  ['restart', 'restart the services and wait until they are ready'],
] as const;

for (const [action, description] of SERVICE_ACTIONS) {
  const command = service
    .command(action)
    .description(description)
    .option(
      SERVICE_FLAGS,
      'an application service to act on, by its name or by a path (repeatable; at least one -s or -t)',
      collect,
      [],
    )
    .option(
      TAG_FLAGS,
      'act on every application service with this tag (repeatable, adds to -s)',
      collect,
      [],
    )
    .option(PROFILE_FLAGS, PROFILE_HELP)
    .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP);
  if (action !== 'stop') {
    command.option(
      '--wait-timeout <seconds>',
      'how long to wait for the services to be ready (default: 300)',
      Number,
    );
  }
  command.action(async (opts: { service: string[]; tag: string[]; waitTimeout?: number }) => {
    const { runService } = await import('./commands/service');
    process.exit(
      await runService(
        action,
        { services: opts.service, tags: opts.tag, waitTimeout: opts.waitTimeout },
        { targetBase: targetBase() },
      ),
    );
  });
}

program
  .command('reset')
  .description(
    "stop the --profile session, then delete node_modules/.stackctl/profiles/<profile>/: its record, saved selection, trust bundle, default logs and event log, which starts again with the reset's own lines (infra isn't touched)",
  )
  .option(PROFILE_FLAGS, 'the profile whose state to delete (required)') // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .action(async () => {
    const { runReset } = await import('./commands/stop');
    process.exit(await runReset(process.cwd(), {}, undefined, INVOCATION_CWD));
  });

program
  .command('show-config')
  .description(
    'print the fully resolved config as JSON (what a running session reports on GET /query/status) — no session needed',
  )
  // Declared here too so `stackctl show-config --profile test` works (see `exec`); the config
  // resolves against that profile's `.env` files, which is what a callback `port` reads.
  .option(PROFILE_FLAGS, PROFILE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .action(async () => {
    const { showConfig } = await import('./commands/inspect');
    await showConfig();
  });

program
  .command('exec')
  .description(
    "run a one-off command in a service's directory, with its environment; the service is named by its name or by a path; a directory that belongs to no service runs with the workspace's environment (default: the current directory); with -s or -t, in several services at once",
  )
  .usage(
    '[options] [service] -- <command...>\n       stackctl exec [options] (-s <service>|-t <tag>)... -- <command...>',
  )
  // Also declared on the root, but Commander rejects a root-only option that appears after a
  // subcommand — so both `stackctl --profile test exec …` and `stackctl exec --profile test …`
  // work. resolveProfile already read it off raw argv; this declaration is for --help and
  // validation.
  .option(PROFILE_FLAGS, PROFILE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option(SERVICE_FLAGS, ONE_OFF_SERVICE_HELP, collect, [])
  .option(TAG_FLAGS, ONE_OFF_TAG_HELP, collect, [])
  .option(IGNORE_SIBLING_ERROR_FLAG, IGNORE_SIBLING_ERROR_HELP)
  .argument(
    '[service]',
    'a service, by its name or by a path: a path inside a service is that service (default: the current directory)',
  )
  .argument('[command...]', 'the command to run, after `--`')
  .action(async (_service: unknown, _command: unknown, flags: OneOffFlags, exec: Command) => {
    refuseLoneIgnoreSiblingError(flags);
    const { before, after } = splitAtDashDash(exec.args);
    if (isManyForm(flags) && before.length > 0) {
      // With no `--` at all, what was written is the command, put in the wrong place.
      console.error(
        after === undefined
          ? 'the command goes after --: stackctl exec -s api -- <command...>'
          : 'with -s or -t, exec takes no service argument: stackctl exec -s api -- <command...>',
      );
      process.exit(1);
    }
    if (before.length > 1) {
      console.error('the command goes after --: stackctl exec [service] -- <command...>');
      process.exit(1);
    }
    const [program, ...args] = after ?? [];
    if (program === undefined) {
      console.error('exec requires a command (after `--`).');
      process.exit(1);
    }
    if (isManyForm(flags)) {
      await runManyForm(flags, { kind: 'exec', command: [program, ...args] });
    }
    const { runOneOffCommand } = await import('./commands/one-off');
    await runOneOffCommand(
      { kind: 'exec', target: before[0], command: [program, ...args] },
      oneOffContext(),
    );
  });

program
  .command('run')
  .description(
    "run one of a service's package.json scripts or make targets in its directory, with its environment; the service is named by its name or by a path; a directory that belongs to no service runs with the workspace's environment (default: the current directory); with -s or -t, in several services at once",
  )
  .usage(
    '[options] [service] <script> [-- <args...>]\n       stackctl run [options] (-s <service>|-t <tag>)... <script> [-- <args...>]',
  )
  .option(PROFILE_FLAGS, PROFILE_HELP) // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option(SERVICE_FLAGS, ONE_OFF_SERVICE_HELP, collect, [])
  .option(TAG_FLAGS, ONE_OFF_TAG_HELP, collect, [])
  .option(IGNORE_SIBLING_ERROR_FLAG, IGNORE_SIBLING_ERROR_HELP)
  // Commander can't put an optional argument before a required one, so the operands before `--`
  // are counted here: one is the script, two are the service and the script.
  .argument(
    '[service]',
    'a service, by its name or by a path: a path inside a service is that service (default: the current directory)',
  )
  .argument('[script]', 'the package.json script or make target to run')
  .argument('[args...]', 'arguments forwarded to it, after `--`')
  .action(async (_t: unknown, _s: unknown, _a: unknown, flags: OneOffFlags, run: Command) => {
    refuseLoneIgnoreSiblingError(flags);
    const { before, after = [] } = splitAtDashDash(run.args);
    if (isManyForm(flags) && before.length > 1) {
      console.error('with -s or -t, run takes only the script: stackctl run -t backend <script>');
      process.exit(1);
    }
    if (before.length > 2) {
      console.error('arguments to the script go after --');
      process.exit(1);
    }
    const [service, script] = before.length === 2 ? before : [undefined, before[0]];
    if (script === undefined) {
      run.error("error: missing required argument 'script'", {
        code: 'commander.missingArgument',
      });
    }
    await (await import('./config-typecheck')).checkConfigTypes();
    if (isManyForm(flags)) {
      await runManyForm(flags, { kind: 'run', script, args: after });
    }
    const { runOneOffCommand } = await import('./commands/one-off');
    await runOneOffCommand({ kind: 'run', target: service, script, args: after }, oneOffContext());
  });

/** The hidden resolver's own options. Without `--many`, the first `--target` is the target. */
interface ResolveOneOffFlags {
  target: string[];
  tag: string[];
  many?: boolean;
  exec?: boolean;
  run?: string;
}

// Not listed: what the SDK's `exec()`/`run()` and `resolveEnv()` run, writing
// the resolved command and environment to a descriptor only they open.
program
  .command(RESOLVE_ONE_OFF_COMMAND, { hidden: true })
  .option(PROFILE_FLAGS, PROFILE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option('--target <target>', 'the target, as exec and run take it (repeatable)', collect, [])
  .option('--tag <tag>', 'with --many: every service with this tag (repeatable)', collect, [])
  .option('--many', 'resolve the many form: each --target and --tag, a command for each')
  .option('--exec', 'resolve exec of the operands')
  .option('--run <script>', 'resolve run of this script, with the operands as its arguments')
  .argument('[operands...]', "the command, or the script's arguments")
  .action(async (operands: string[], flags: ResolveOneOffFlags) => {
    const [program, ...args] = operands;
    const request =
      flags.exec && program !== undefined
        ? { kind: 'exec' as const, command: [program, ...args] as [string, ...string[]] }
        : flags.run !== undefined
          ? { kind: 'run' as const, script: flags.run, args: operands }
          : { kind: 'env' as const };
    if (flags.exec && program === undefined) {
      console.error('exec requires a command (after `--`).');
      process.exit(1);
    }
    if (flags.many) {
      if (request.kind === 'env') {
        console.error('--many resolves exec or run, not an environment.');
        process.exit(1);
      }
      const { printOneOffManyResolution } = await import('./commands/one-off');
      await printOneOffManyResolution({
        ...request,
        targets: flags.target,
        tags: flags.tag,
        base: invocationBase(),
      });
    }
    const { printOneOffResolution } = await import('./commands/one-off');
    await printOneOffResolution({ target: flags.target[0], base: invocationBase(), request });
  });

program
  .command('logs')
  .description(
    "print the log of the profile's session: the running one, else the latest (node_modules/.stackctl/profiles/<profile>/sessions/<id>/logs.txt)",
  )
  .option(PROFILE_FLAGS, PROFILE_HELP) // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option(
    '-f, --follow',
    'print it, then its new lines as they are written, until the next session starts',
  )
  .option('--path', 'print the resolved logfile path instead of its contents, then exit')
  .action(async (opts: { follow?: boolean; path?: boolean }) => {
    const { runLogs } = await import('./commands/logs');
    await runLogs(opts);
  });

program
  .command('status')
  .description(
    "the profile's session now (its services, infra and files) and the last commands that acted on it, from its event log — read-only, it never ends a session",
  )
  .option(PROFILE_FLAGS, PROFILE_HELP) // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option('--json', 'print it as JSON')
  .action(async (opts: { json?: boolean }) => {
    const { runStatus } = await import('./commands/status');
    await runStatus(opts);
  });

program
  .command('events')
  .description(
    "print the event log of the profile's session, the running one else the latest (node_modules/.stackctl/profiles/<profile>/sessions/<id>/events.jsonl): what acted on its stack, one JSON object per line",
  )
  .option(PROFILE_FLAGS, PROFILE_HELP) // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option('-n, --lines <count>', 'print only the last <count> lines')
  .option('-f, --follow', 'keep printing lines as they are written, until the next session starts')
  .option('--path', "print the event log's path instead, then exit")
  .action(async (opts: { lines?: string; follow?: boolean; path?: boolean }) => {
    const { runEvents } = await import('./commands/events');
    await runEvents(opts);
  });

// `infra`: the services the packages need but that aren't packages (see `commands/infra.ts`).
const infra = program
  .command('infra')
  .description(
    "start, stop, restart, reset or destroy the infrastructure declared under `infra` (databases, caches, …), or run its provider's tool",
  )
  .option(PROFILE_FLAGS, PROFILE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP);

const INFRA_COMMANDS = [
  [
    'start',
    'start the services and wait until they are ready, then exit; they keep running. afterReady runs, even for a service already running',
  ],
  [
    'stop',
    'stop and remove the containers; their named volumes are kept (a service with none loses the data in its container)',
  ],
  [
    'restart',
    'stop the services, then start them: the containers are recreated, their named volumes kept',
  ],
  ['reset', 'delete the services and their data, then start them clean'],
  [
    'destroy',
    'remove the services and their data, without starting them again; with no -s or -t, the whole project (containers, volumes, networks)',
  ],
] as const;

for (const [command, description] of INFRA_COMMANDS) {
  const sub = infra
    .command(command)
    .description(description)
    .option(
      INFRA_SERVICE_FLAGS,
      'an infra service to act on, by its name (repeatable; default: every enabled one)',
      collect,
      [],
    )
    .option(
      TAG_FLAGS,
      'act on every enabled infra service with this tag (repeatable, adds to -s)',
      collect,
      [],
    )
    .option(PROFILE_FLAGS, PROFILE_HELP)
    .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP);
  if (command === 'start' || command === 'restart' || command === 'reset') {
    sub.option(
      '--wait-timeout <seconds>',
      "how long to wait for the services to be ready (default: the config's readyTimeout)",
      Number,
    );
  }
  sub.action(async (opts: { service: string[]; tag: string[]; waitTimeout?: number }) => {
    const { runInfra } = await import('./commands/infra');
    await runInfra(command, opts.service, opts.tag, INVOCATION_CWD, {
      waitTimeoutS: opts.waitTimeout,
    });
  });
}

// Listed for --help. A real invocation never reaches this action: it's dispatched from raw argv
// before Commander parses (see the bottom of this file), because nothing after the provider word
// is stackctl's to interpret — not `-p`, not `--profile`, not `--help`.
infra
  .command('docker-compose')
  .description(
    'run `docker compose` itself against this project and profile — everything after it goes to Compose untouched (put --profile before it)',
  )
  .argument('[args...]', 'arguments for `docker compose`')
  .allowUnknownOption()
  .allowExcessArguments()
  .helpOption(false)
  .action(async (args: string[]) => {
    await runInfraPassthrough('docker-compose', args);
  });

/** `infra <provider> …`: the provider's own tool, bound to this project and profile. */
async function runInfraPassthrough(provider: string, args: string[]): Promise<never> {
  const infraCommands = await import('./commands/infra');
  return infraCommands.runInfraPassthrough(provider, args, INVOCATION_CWD);
}

// Anchor at the workspace root before dispatching any command, so stackctl behaves the same
// from anywhere in the tree.
anchorAtWorkspaceRoot(INVOCATION_CWD);
const passthrough = passthroughArgs(process.argv);
if (passthrough) {
  await runInfraPassthrough(passthrough.provider, passthrough.args);
}
await program.parseAsync(process.argv).catch((err: unknown) => exitOnFatalError(err));
