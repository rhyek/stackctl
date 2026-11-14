---
description: Run one command or one script in a service's directory with its exact environment, using stackctl exec and stackctl run.
---

# One-off commands

Sometimes you don't want the whole stack, only one command with a service's environment: a
migration, a seed script, a REPL, a test run.

```bash
sctl exec api -- node src/migrate.ts   # a command, in api's directory with api's env
sctl run api seed -- --rows=100        # api's `seed` script, with arguments
cd apps/api && sctl run seed           # no target: the current directory
```

- **`sctl exec [target] -- <command>`** runs a literal command. The `--` is required.
- **`sctl run [target] <script> [-- args]`** runs a `package.json` script or Makefile
  target, [the way a service's dev script is run](./services.md#how-a-script-is-run).

Both run in the target's directory with what a session would give it: its resolved
[`.env` files](./env.md), its `PORT` and its `PUBLIC_ORIGIN`. No session needs to be running,
and a running one is not touched.

## Targets

A target is a service's name or a directory:

```bash
sctl exec api -- node src/migrate.ts        # the service named api
sctl exec apps/api -- node src/migrate.ts   # its directory, the same thing
sctl exec libs/db -- node src/migrate.ts    # a directory that isn't a service
```

- **A path anywhere inside a service is that service**, and the command runs in the service's
  own directory.
- **`./api` is always the directory.** A bare `api` is the service.
- **A directory outside every service** gets the workspace's `.env` files, then its own, and no
  `PORT`.
- **No target** means the current directory.

## Profiles

`--profile` picks the environment, as for a session:

```bash
sctl --profile test run api seed
sctl --profile test exec -- vitest
```

## Output and exit code

The command's output goes to your terminal and nothing else is printed, so both commands work
in a pipeline. The exit code is the command's own.

- **On a terminal, the command gets the terminal**: prompts, colors and a watch mode's keys
  work as they do when you run it bare. stdout and stderr are decided one by one, so with
  `| grep` only stdout is piped.
- **A coding agent's command is always piped**, terminal or not.
- **Each call writes a [log file](./logs.md#log-files)**: the command and its directory, every
  line that was piped, and how it ended and how long it took. Output that went to a terminal
  isn't in it.
- **Inside a command stackctl runs**, such as a dev script `sctl exec -- node --watch
  src/main.ts`, a menu command, or another `exec` or `run`, they only set up the environment,
  then become the command: no stackctl process stays between them. The outer command keeps
  the log and the [event](../reference/events.md), so nothing is recorded twice.

## From a script

`exec()` and `run()` do the same from Node, and resolve with the exit code instead of exiting:

```ts
import { exec, run } from 'stackctl';

await exec({ target: 'api', command: ['node', 'src/migrate.ts'] });
const { exitCode } = await run({
  target: 'api',
  script: 'seed',
  profile: 'test',
});
```

See the [SDK](../reference/sdk.md#exec-and-run).
