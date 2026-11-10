---
description: Run one command or one script in a service's directory with its exact environment, using stackctl exec and stackctl run.
---

# One-off commands

Sometimes you don't want the whole stack, only one command with a service's environment: a
migration, a seed script, a REPL, a test run.

```bash
stackctl exec api -- node src/migrate.ts   # a command, in api's directory with api's env
stackctl run api seed -- --rows=100        # api's `seed` script, with arguments
cd apps/api && stackctl run seed           # no target: the current directory
```

- **`stackctl exec [target] -- <command>`** runs a literal command. The `--` is required.
- **`stackctl run [target] <script> [-- args]`** runs a `package.json` script or Makefile
  target, [the way a service's dev script is run](./services.md#how-a-script-is-run).

Both run in the target's directory with what a session would give it: its resolved
[`.env` files](./env.md), its `PORT` and its `PUBLIC_ORIGIN`. No session needs to be running,
and a running one is not touched.

## Targets

A target is a service's name or a directory:

```bash
stackctl exec api -- node src/migrate.ts        # the service named api
stackctl exec apps/api -- node src/migrate.ts   # its directory, the same thing
stackctl exec libs/db -- node src/migrate.ts    # a directory that isn't a service
```

- **A path anywhere inside a service is that service**, and the command runs in the service's
  own directory.
- **`./api` is always the directory.** A bare `api` is the service.
- **A directory outside every service** gets the workspace's `.env` files, then its own, and no
  `PORT`.
- **No target** means the current directory.

## Modes

`--mode` picks the environment, as for a session:

```bash
stackctl --mode test run api seed
stackctl --mode test exec -- vitest
```

## Output and exit code

The command's output goes to your terminal and nothing else is printed, so both commands work
in a pipeline. The exit code is the command's own. Each call also writes a
[log file](./logs.md#log-files).

## From a script

`exec()` and `run()` do the same from Node, and resolve with the exit code instead of exiting:

```ts
import { exec, run } from 'stackctl';

await exec({ target: 'api', command: ['node', 'src/migrate.ts'] });
const { exitCode } = await run({ target: 'api', script: 'seed', mode: 'test' });
```

See the [Node API](../reference/node-api.md#exec-and-run).
