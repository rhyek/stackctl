#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import type { StartOptions } from './commands/default.js';
import { rootOptionsRefusal } from './commands/root-options.js';
import {
  DETACHED_SESSION_VAR,
  RELEASE_MESSAGE,
  RESOLVE_ONE_OFF_COMMAND,
  captureShellEnv,
  dropInjectedEnv,
  markCliProcess,
  publishModeSource,
  resolveMode,
} from './env-base.js';
import { exitOnFatalError } from './errors.js';
import { passthroughArgs } from './infra/argv.js';
// Records, as it loads, the environment and directory the process started with, which this file
// changes before a session starts over from them (see relaunch.ts).
import { relaunchWithCappedYoungGeneration } from './relaunch.js';
import { readOwnVersion } from './skill.js';
import { locateWorkspace, needsNoWorkspace, resolveWorkspaceDirArg } from './workspace-root.js';

// The entry point: Commander wiring only. What a command runs lives under `commands/` and is
// imported by its action, so a command loads its own code and nothing else's — `--help` and
// `logs` don't pay for the config, `exec` doesn't pay for a session.

// Before anything loads the config: from here on, `resolveEnv()`, `exec()` and `run()` throw
// rather than start another stackctl, which would load the config, and call them again.
markCliProcess();

/**
 * The directory stackctl was invoked from, captured before {@link anchorAtWorkspaceRoot} may
 * `chdir` us to the config root: what `exec`'s and `run`'s relative target resolves against.
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
// `INJECTED_ENV_VAR`), so drop them before the mode, or anything else, is read from it.
dropInjectedEnv();

// Resolved from raw argv and published to the environment before anything else runs: the config
// (whose `port`/`urls` callbacks resolve `.env` files) is loaded by the command's action, which
// Commander only reaches after parsing. Writing it back also hands every child process the mode
// for free, the way Vite exposes MODE.
// Its source is kept for the rest of this process only (`/query/status`, the session's first
// line); a stackctl this one starts resolves its own, `env`, from the `STACKCTL_MODE` it inherits.
try {
  const { mode, source } = resolveMode(process.argv);
  process.env.STACKCTL_MODE = mode;
  publishModeSource(source);
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

/** Commander option-parser for repeatable `-s/--service <name>` flags. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `exec`'s and `run`'s own options. */
interface OneOffFlags {
  /** Refused: the target is a positional argument (see {@link refuseServiceOption}). */
  service?: string;
  logDir?: string;
}

/** Where `exec` and `run` were invoked, and their `--log-dir`. */
const oneOffContext = ({ logDir }: OneOffFlags) => ({
  invocationCwd: INVOCATION_CWD,
  // Validated by anchorAtWorkspaceRoot already.
  workspaceDirGiven: resolveWorkspaceDirArg(process.argv) !== undefined,
  logDir,
});

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

/** Exits with where the target goes, when `-s`/`--service` was given to `exec` or `run`. */
function refuseServiceOption(command: 'exec' | 'run', flags: OneOffFlags): void {
  if (flags.service !== undefined) {
    console.error(ONE_OFF_FORMS.get(command));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Commander wiring
// ---------------------------------------------------------------------------

// `--mode`, declared on the root and again on each subcommand that takes it (see the note on
// `exec` for why both).
const MODE_FLAGS = '-m, --mode <name>';
const MODE_HELP =
  'environment mode selecting the .env.<mode> files to load (default: $STACKCTL_MODE, else "test" in CI, else "development")';

// `--workspace-dir`, declared like `--mode`. Read from raw argv before Commander parses (the
// workspace is located first); the declaration is for --help and validation.
const WORKSPACE_DIR_FLAGS = '--workspace-dir <dir>';
const WORKSPACE_DIR_HELP =
  'the directory holding stackctl.config.ts, instead of the nearest one at or above the current directory';

// `-s` and `--log-dir`, declared on each command that takes them: `start`, `exec` and `run`. On
// `exec` and `run`, `-s` is hidden and refused: their target is a positional argument.
const SERVICE_FLAGS = '-s, --service <name>';
const LOG_DIR_FLAGS = '--log-dir <dir>';

const program = new Command()
  .name('stackctl')
  .description(
    "A terminal UI and CLI for a monorepo's services, infrastructure, tests and CI during development.",
  )
  .option(MODE_FLAGS, MODE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .version(readOwnVersion(), '-V, --version', "print stackctl's version");

/**
 * Where `exec`'s and `run`'s target goes, said when `-s` is given to them, or before them:
 * `stackctl -s api exec …` reaches `start`, which owns `-s`, with `exec …` left over.
 */
const ONE_OFF_FORMS = new Map([
  [
    'exec',
    'exec takes the service or directory as its first argument: stackctl exec api -- <command>',
  ],
  ['run', 'run takes the service or directory as its first argument: stackctl run api <script>'],
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
    'service to run (repeatable, bypasses the interactive selector)',
    collect,
    [],
  )
  .option(MODE_FLAGS, MODE_HELP) // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option('--ui', 'run the interactive TUI (default)')
  .option(
    '--headless',
    'run without the TUI, streaming logs to stdout (needs -s or --last-answers)',
  )
  .option('--last-answers', 'skip the selector and reuse the last saved selection', false)
  .option(
    LOG_DIR_FLAGS,
    'write the timestamped session log into this directory (default: node_modules/.stackctl/modes/<mode>/logs/)',
  )
  .option(
    '--kill-others',
    "quit the stackctl session already running for this project in the same mode instead of asking (agents: don't pass this unprompted)",
    false,
  )
  .option(
    '-d, --detach',
    'for CI: start a headless session that outlives the command, wait until it is ready, print where it is, and exit (needs -s or --last-answers; refused for a coding agent outside CI)',
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
      const { detachRefusal, runDetach } = await import('./commands/detach.js');
      const agentRefusal = detachRefusal();
      if (agentRefusal) {
        console.error(agentRefusal);
        process.exit(1);
      }
      await runDetach(opts);
    }

    relaunchWithCappedYoungGeneration();
    const { runDefaultAction } = await import('./commands/default.js');
    await runDefaultAction(opts);
  });

program
  .command('init')
  .description('set up stackctl.config.ts (and, optionally, the agent skill)')
  .option(WORKSPACE_DIR_FLAGS, 'create the config in this directory, instead of the current one')
  .option(
    '-y, --yes',
    'non-interactive: accept defaults (scaffold config + install the agent skill)',
  )
  .action(async (opts: { yes?: boolean }) => {
    const { runInit } = await import('./init.js');
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
    await runInit({ cwd, yes: opts.yes });
  });

program
  .command('stop')
  .description("stop this workspace's stackctl session of the mode (infra isn't touched)")
  .option(MODE_FLAGS, MODE_HELP) // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .action(async () => {
    const { runStop } = await import('./commands/stop.js');
    process.exit(await runStop(process.cwd()));
  });

// `service`: application services of the mode's running session (see `commands/service.ts`).
const service = program
  .command('service')
  .description(
    "start, stop or restart application services in this workspace's running session of the mode",
  )
  .option(MODE_FLAGS, MODE_HELP) // see `exec`
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
    .option(SERVICE_FLAGS, 'application service to act on (repeatable, at least one)', collect, [])
    .option(MODE_FLAGS, MODE_HELP)
    .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP);
  if (action !== 'stop') {
    command.option(
      '--wait-timeout <seconds>',
      'how long to wait for the services to be ready (default: 300)',
      Number,
    );
  }
  command.action(async (opts: { service: string[]; waitTimeout?: number }) => {
    const { runService } = await import('./commands/service.js');
    process.exit(
      await runService(action, { services: opts.service, waitTimeout: opts.waitTimeout }),
    );
  });
}

program
  .command('reset')
  .description(
    "stop the --mode session, then delete node_modules/.stackctl/modes/<mode>/: its record, saved selection, trust bundle and default logs (infra isn't touched)",
  )
  .option(MODE_FLAGS, 'the mode whose state to delete (required)') // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .action(async () => {
    const { runReset } = await import('./commands/stop.js');
    process.exit(await runReset(process.cwd()));
  });

program
  .command('show-config')
  .description(
    'print the fully resolved config as JSON (what a running session reports on GET /query/status) — no session needed',
  )
  // Declared here too so `stackctl show-config --mode test` works (see `exec`); the config
  // resolves against that mode's `.env` files, which is what a callback `port` reads.
  .option(MODE_FLAGS, MODE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .action(async () => {
    const { showConfig } = await import('./commands/inspect.js');
    await showConfig();
  });

program
  .command('exec')
  .description(
    "run a one-off command in a target's directory, with its environment; the target is a service (its name) or a directory (default: the current directory)",
  )
  .usage('[options] [target] -- <command...>')
  // Also declared on the root, but Commander rejects a root-only option that appears after a
  // subcommand — so both `stackctl --mode test exec …` and `stackctl exec --mode test …` work.
  // resolveMode already read it off raw argv; this declaration is for --help and validation.
  .option(MODE_FLAGS, MODE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option(
    LOG_DIR_FLAGS,
    'write its log into this directory (default: node_modules/.stackctl/modes/<mode>/logs/)',
  )
  .addOption(new Option(SERVICE_FLAGS).hideHelp())
  .argument(
    '[target]',
    "a service (its name), or a directory: a service's at any depth is that service (default: the current directory)",
  )
  .argument('[command...]', 'the command to run, after `--`')
  .action(async (_target: unknown, _command: unknown, flags: OneOffFlags, exec: Command) => {
    refuseServiceOption('exec', flags);
    const { before, after = [] } = splitAtDashDash(exec.args);
    if (before.length > 1) {
      console.error('the command goes after --: stackctl exec [target] -- <command...>');
      process.exit(1);
    }
    const [program, ...args] = after;
    if (program === undefined) {
      console.error('exec requires a command (after `--`).');
      process.exit(1);
    }
    const { runOneOffCommand } = await import('./commands/one-off.js');
    await runOneOffCommand(
      { kind: 'exec', target: before[0], command: [program, ...args] },
      oneOffContext(flags),
    );
  });

program
  .command('run')
  .description(
    "run one of a target's package.json scripts or make targets in its directory, with its environment; the target is a service (its name) or a directory (default: the current directory)",
  )
  .usage('[options] [target] <script> [-- <args...>]')
  .option(MODE_FLAGS, MODE_HELP) // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option(
    LOG_DIR_FLAGS,
    'write its log into this directory (default: node_modules/.stackctl/modes/<mode>/logs/)',
  )
  .addOption(new Option(SERVICE_FLAGS).hideHelp())
  // Commander can't put an optional argument before a required one, so the operands before `--`
  // are counted here: one is the script, two are the target and the script.
  .argument(
    '[target]',
    "a service (its name), or a directory: a service's at any depth is that service (default: the current directory)",
  )
  .argument('[script]', 'the package.json script or make target to run')
  .argument('[args...]', 'arguments forwarded to it, after `--`')
  .action(async (_t: unknown, _s: unknown, _a: unknown, flags: OneOffFlags, run: Command) => {
    refuseServiceOption('run', flags);
    const { before, after = [] } = splitAtDashDash(run.args);
    if (before.length > 2) {
      console.error('arguments to the script go after --');
      process.exit(1);
    }
    const [target, script] = before.length === 2 ? before : [undefined, before[0]];
    if (script === undefined) {
      run.error("error: missing required argument 'script'", {
        code: 'commander.missingArgument',
      });
    }
    const { runOneOffCommand } = await import('./commands/one-off.js');
    await runOneOffCommand({ kind: 'run', target, script, args: after }, oneOffContext(flags));
  });

// Not listed: what the SDK's `exec()`/`run()` and `resolveEnv()` run, writing
// the resolved command and environment to a descriptor only they open.
program
  .command(RESOLVE_ONE_OFF_COMMAND, { hidden: true })
  .option(MODE_FLAGS, MODE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option('--target <target>', 'the target, as exec and run take it')
  .option('--exec', 'resolve exec of the operands')
  .option('--run <script>', 'resolve run of this script, with the operands as its arguments')
  .argument('[operands...]', "the command, or the script's arguments")
  .action(async (operands: string[], flags: { target?: string; exec?: boolean; run?: string }) => {
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
    const { printOneOffResolution } = await import('./commands/one-off.js');
    await printOneOffResolution({
      ...oneOffContext({}),
      target: flags.target,
      request,
    });
  });

program
  .command('logs')
  .description(
    "print the logfile of the mode's dev session (queried from the running instance, else the newest under node_modules/.stackctl/modes/<mode>/logs/)",
  )
  .option(MODE_FLAGS, MODE_HELP) // see `exec`
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .option(
    '-f, --follow',
    'stream new lines live (native `tail -f`) instead of printing the file and exiting',
  )
  .option('--path', 'print the resolved logfile path instead of its contents, then exit')
  .action(async (opts: { follow?: boolean; path?: boolean }) => {
    const { runLogs } = await import('./commands/logs.js');
    await runLogs(opts);
  });

// `infra`: the services the packages need but that aren't packages (see `commands/infra.ts`).
const infra = program
  .command('infra')
  .description(
    'bring up, tear down, or drive the infrastructure declared under `infra` (databases, caches, …)',
  )
  .option(MODE_FLAGS, MODE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP);

infra
  .command('up')
  .description(
    'start the services (all, or the ones named), wait until they are ready, then exit; they keep running',
  )
  .argument('[services...]', 'services to start (default: all)')
  .option('--reset', 'destroy the services first, then start them clean', false)
  .option(MODE_FLAGS, MODE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .action(async (services: string[], opts: { reset: boolean }) => {
    const { runInfraAction } = await import('./commands/infra.js');
    await runInfraAction('up', { services, reset: opts.reset });
  });

infra
  .command('down')
  .description('stop and remove the containers (all, or the ones named); their data is kept')
  .argument('[services...]', 'services to stop (default: all)')
  .option(MODE_FLAGS, MODE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .action(async (services: string[]) => {
    const { runInfraDown } = await import('./commands/infra.js');
    await runInfraDown(services);
  });

infra
  .command('destroy')
  .description(
    'remove the services and their data: the ones named, or — with none named — the whole project (containers, volumes, networks)',
  )
  .argument('[services...]', 'services to destroy (default: everything)')
  .option(MODE_FLAGS, MODE_HELP)
  .option(WORKSPACE_DIR_FLAGS, WORKSPACE_DIR_HELP)
  .action(async (services: string[]) => {
    const { runInfraAction } = await import('./commands/infra.js');
    await runInfraAction('destroy', { services });
  });

// Listed for --help. A real invocation never reaches this action: it's dispatched from raw argv
// before Commander parses (see the bottom of this file), because nothing after the provider word
// is stackctl's to interpret — not `-m`, not `-p`, not `--help`.
infra
  .command('docker-compose')
  .description(
    'run `docker compose` itself against this project and mode — everything after it goes to Compose untouched (put --mode before it)',
  )
  .argument('[args...]', 'arguments for `docker compose`')
  .allowUnknownOption()
  .allowExcessArguments()
  .helpOption(false)
  .action(async (args: string[]) => {
    await runInfraPassthrough('docker-compose', args);
  });

/** `infra <provider> …`: the provider's own tool, bound to this project and mode. */
async function runInfraPassthrough(provider: string, args: string[]): Promise<never> {
  const infraCommands = await import('./commands/infra.js');
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
