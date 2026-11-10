---
description: The functions stackctl exports for scripts - defineConfig, startStack, stackEnvironment, exec, run, resolveEnv and logging - with their options and return values.
---

# Node API

Everything is a named export of `stackctl`:

```ts
import { defineConfig, exec, logging, resolveEnv, run, startStack } from 'stackctl';
```

stackctl is ESM only. It has no CommonJS entry, so `require('stackctl')` fails.

| Export                                  | What it does                                               |
| --------------------------------------- | ---------------------------------------------------------- |
| [`defineConfig`](#defineconfig)         | Defines the config.                                        |
| [`startStack`](#startstack)             | Starts a healthy stack for a test suite.                   |
| [`exec`, `run`](#exec-and-run)          | Run a command or script with a service's environment.      |
| [`resolveEnv`](#resolveenv)             | Returns a service's environment without running anything.  |
| [`logging`](#logging)                   | Log formatter helpers.                                     |

Like the CLI, each function finds the workspace from the current directory, or takes a
`workspaceDir`. `startStack`, `exec`, `run` and `resolveEnv` can't be called from inside
`stackctl.config.ts` or its callbacks: they would load the config again.

## `defineConfig`

```ts
function defineConfig(options): Config;
```

Takes the options in [the config file](../config/config-file.md) and returns the resolved config,
which is the file's default export.

## `startStack`

```ts
function startStack(options): Promise<Stack>;
```

Starts a headless session as a child of the calling process and resolves once the infra and
every service asked for are healthy. See [Tests and CI](../guide/testing.md).

```ts
const stack = await startStack({ mode: 'test', services: ['web'] });
try {
  await fetch(`${stack.origins.api}/health`);
} finally {
  await stack.stop();
}
```

| Option         | Default                | What it is                                                                 |
| -------------- | ---------------------- | -------------------------------------------------------------------------- |
| `services`     | **required**           | The services to bring up. Their deps and the mode's infra come too.        |
| `mode`         | as the CLI resolves it | The mode.                                                                  |
| `workspaceDir` | nearest config         | The directory holding `stackctl.config.ts`.                                |
| `waitTimeout`  | `300`                  | Seconds to wait for everything to be healthy.                              |
| `killOthers`   | `false`                | Quit a session already running in the mode, as `--kill-others` does.       |
| `logDir`       | the mode's log dir     | Where the session log is written.                                          |
| `env`          | `stackEnvironment()`   | The environment the session starts with.                                   |

It resolves with:

| Field             | What it is                                                                              |
| ----------------- | --------------------------------------------------------------------------------------- |
| `origins`         | Each configured service's [public origin](../config/urls.md), by name.                  |
| `domain`          | The reverse proxy's canonical domain, or `null` without one.                            |
| `services`        | What the session runs: the services asked for and their deps.                           |
| `control`         | A [control API client](./control-api.md#the-client) for the session.                    |
| `stop()`          | Quits the session, resolving once it has exited.                                        |
| `pid`, `port`     | The session's process and its control-API port.                                         |
| `mode`, `modeSource`, `logFile` | The session's mode, where it came from, and its log.                      |

- **The session ends with the calling process**, however that ends.
- **Healthy** means running and passing its healthcheck. A service with no healthcheck must
  stay up for a second.
- **A service with `autostart: false` stays stopped** and isn't waited on. Start it with
  `stack.control.command.service.start(name)`.
- **It rejects** when a session of the mode is already running (unless `killOthers`), when the
  session exits or a service stops while starting, or when `waitTimeout` passes
  (`not healthy after 300s: worker`). The session is stopped first, and the error has the
  log's path.

### `stackEnvironment`

```ts
function stackEnvironment(env = process.env): NodeJS.ProcessEnv;
```

Returns `env` without what a package manager and a test runner add to it, which would
otherwise leak into every service: `npm_*`, `INIT_CWD`, `NODE`, `NODE_PATH`,
`PNPM_SCRIPT_SRC_DIR`, and under Vitest or Jest their own variables and `NODE_ENV`. It is
`startStack`'s default `env`. To add a variable:

```ts
await startStack({ services: ['web'], env: { ...stackEnvironment(), FEATURE_X: '1' } });
```

## `exec` and `run`

```ts
function exec(options): Promise<{ exitCode, signal, stdout?, stderr? }>;
function run(options): Promise<{ exitCode, signal, stdout?, stderr? }>;
```

What [`stackctl exec` and `stackctl run`](../guide/commands.md) do, from a script: one
command in a target's directory, with its environment.

```ts
await exec({ target: 'api', command: ['node', 'src/migrate.ts'] });

const { exitCode, stdout } = await run({
  target: 'api',
  script: 'seed',
  args: ['--rows=100'],
  mode: 'test',
  stdio: 'pipe',
});
```

| Option         | Default                | What it is                                                                   |
| -------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `command`      | **required** (`exec`)  | The program and its arguments, run with no shell.                            |
| `script`       | **required** (`run`)   | The script or Makefile target.                                               |
| `args`         | none                   | `run` only: arguments forwarded to the script.                               |
| `target`       | the current directory  | A service's name, or a directory.                                            |
| `mode`         | as the CLI resolves it | The mode.                                                                    |
| `workspaceDir` | nearest config         | The directory holding `stackctl.config.ts`.                                  |
| `stdio`        | `'inherit'`            | `'inherit'` streams the output. `'pipe'` collects it into `stdout` and `stderr`. |

- **A non-zero exit resolves**, with its `exitCode` or the `signal` that ended it. The caller
  judges the result.
- **It rejects only when the command can't start**: no config, an unknown target, a missing
  script.
- **The calling process is untouched**: its `process.env` and working directory don't change,
  and neither function calls `process.exit`.
- **Signals are forwarded** to the command.

## `resolveEnv`

```ts
function resolveEnv(options?): { env, files, candidates };
```

Returns the environment stackctl would give a target, without starting or running anything.
For a script stackctl doesn't start, such as a launcher that needs a port before anything is
up. It is synchronous.

```ts
const { env } = resolveEnv({ mode: 'test', target: 'api' });
const databaseUrl = env.DATABASE_URL;
```

| Option         | Default                | What it is                                      |
| -------------- | ---------------------- | ----------------------------------------------- |
| `target`       | the current directory  | A service's name, or a directory.               |
| `mode`         | as the CLI resolves it | The mode whose files to read.                   |
| `workspaceDir` | nearest config         | The directory holding `stackctl.config.ts`.     |

| Field        | What it is                                                                               |
| ------------ | ---------------------------------------------------------------------------------------- |
| `env`        | What stackctl adds: the files' variables, `env.vars`, and for a service its `PORT` and `PUBLIC_ORIGIN`. |
| `files`      | The `.env` files that existed and were read.                                             |
| `candidates` | Every path looked for. Check it when a variable is missing.                              |

`env` doesn't include the rest of `process.env`. Merge them yourself when you need both:
`{ ...process.env, ...env }`.

## `logging`

Builders for a service's [`logs.formatter`](../config/logs.md#the-logging-helpers):

```ts
logging.formatter(config?);
logging.nodejs.pino.formatter(config?);
logging.nodejs.winston.formatter(config?);
```

`z`, from zod, is re-exported for a hand-written formatter.

## Types

The types used by the config are exported for
[splitting it across files](../config/config-file.md#splitting-the-config-across-files):
`ServiceInput`, `InfraServiceInput`, `InfraServicesInput`, `ReverseProxyRoute`,
`ReverseProxyInput` and `DockerComposeInfraInput`. With
[typed service names](../config/config-file.md#typed-service-names), `ServiceName`,
`InfraServiceName` and `ServiceConfig` are your own. `ControlClient` and `SessionStatus`
describe the [control API client](./control-api.md#the-client).
