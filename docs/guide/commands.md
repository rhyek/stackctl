---
description: Run one command or one script in a service's directory with its exact environment, or in several services at once, using stackctl exec and stackctl run.
---

# One-off commands

Sometimes you don't want the whole stack, only one command with a service's environment: a
migration, a seed script, a REPL, a test run.

```bash
sctl exec api -- node src/migrate.ts   # a command, in api's directory with api's env
sctl run api seed -- --rows=100        # api's `seed` script, with arguments
cd apps/api && sctl run seed           # no service: the current directory
```

- **`sctl exec [service] -- <command>`** runs a literal command. The `--` is required.
- **`sctl run [service] <script> [-- args]`** runs a `package.json` script or Makefile
  target, [the way a service's dev script is run](./services.md#how-a-script-is-run).

Both run in the service's directory with what a session would give it: its resolved
[`.env` files](./env.md), its `PORT` and its `PUBLIC_ORIGIN`. No session needs to be running,
and a running one is not touched.

## Naming a service

A service is named by its name or by a path, relative or absolute:

```bash
sctl exec api -- node src/migrate.ts        # the service named api
sctl exec apps/api -- node src/migrate.ts   # its directory, the same thing
sctl exec libs/db -- node src/migrate.ts    # a directory that isn't a service
```

- **A path anywhere inside a service is that service**, and the command runs in the service's
  own directory, with the service's own [`env`](../config/services.md#env).
- **`./api` is always the directory.** A bare `api` is the service.
- **A relative path is relative to the directory you ran stackctl in**, or to the workspace
  directory when `--workspace-dir` is given.
- **A directory outside every service** gets the `.env` files of every directory from the root
  down to it, and no `PORT`.
- **No argument** means the current directory.

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

## Several services at once

```bash
sctl run -t backend test                  # every service tagged backend
sctl exec -s api -s worker -- npx tsc -b  # api and worker
sctl run -t backend --ignore-sibling-error lint
```

- **`-s` or `-t` runs it in several services**, at once, each as above. `-s` names a service
  as in [Naming a service](#naming-a-service); `-t` takes every service with the
  [tag](../config/services.md#tags).
- **Every line is labelled with its service**, and a summary of each one's result goes to
  stderr at the end. Nothing gets the terminal.
- **The first failure stops the others.** With `--ignore-sibling-error`, every command runs to
  its end.
- **A service a tag matched that lacks the script is skipped.**

The output, the exit code and the rest are in the
[CLI reference](../reference/cli.md#several-services-at-once).

## From a script

`exec()` and `run()` do the same from Node, and resolve with the result instead of exiting:

```ts
import { exec, run } from 'stackctl';

await exec({ service: 'api', command: ['node', 'src/migrate.ts'] });
const { exitCode } = await run({
  service: 'api',
  script: 'seed',
  profile: 'test',
});
const { ok, results } = await run({ tags: ['backend'], script: 'test' });
```

See the [SDK](../reference/sdk.md#exec-and-run), and
[several services at once](../reference/sdk.md#several-services-at-once) from a script.
