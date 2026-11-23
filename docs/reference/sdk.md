---
description: stackctl's SDK, the functions it exports for your own scripts and test suites - defineConfig, startStack, attach, wait, the session commands, infra, exec, run, resolveEnv, showConfig, init and logging - with their options and return values.
---

# SDK

stackctl's SDK is what it exports for your own code: a test suite's global setup, a seed or
migration script, a launcher. It does from a script what the CLI does from a shell, with the
same workspace, profiles and environment. Everything is a named export of `stackctl`:

```ts
import {
  attach,
  defineConfig,
  exec,
  infra,
  run,
  service,
  startStack,
} from 'stackctl';
```

stackctl is ESM only. It has no CommonJS entry, so `require('stackctl')` fails.

| Export                                | What it does                                              |
| ------------------------------------- | --------------------------------------------------------- |
| [`defineConfig`](#defineconfig)       | Defines the config.                                       |
| [`startStack`](#startstack)           | Starts a healthy stack for a test suite.                  |
| [`attach`, `wait`](#attach-and-wait)  | The stack of a session already running.                   |
| [`stop`, `status`](#session-commands) | Stop the profile's session, or say how it stands.         |
| [`events`, `logs`](#session-commands) | Read or follow its event log and its log.                 |
| [`resetProfile`](#session-commands)   | Stop it, then delete the profile's state.                 |
| [`service`](#service)                 | Start, stop or restart services in the running session.   |
| [`infra`](#infra)                     | Start, stop, restart, reset or destroy the infra.         |
| [`exec`, `run`](#exec-and-run)        | Run a command or script with a service's environment.     |
| [`resolveEnv`](#resolveenv)           | Returns a service's environment without running anything. |
| [`showConfig`](#showconfig)           | Returns the resolved config.                              |
| [`init`](#init)                       | Sets a project up, as `stackctl init -y`.                 |
| [`logging`](#logging)                 | Log formatter helpers.                                    |

Every function but `defineConfig`, `stackEnvironment` and `logging` does what its
[CLI](./cli.md) command does, by running that command in a child process: the calling process
never loads the config, and a result is what the command did. A refusal the command prints and
exits `1` for (an unknown service, no session running) is a rejection with its message. Like the
CLI, each function finds the workspace from the current directory, or takes a `workspaceDir`,
and all but `init` take a `profile`. None can be called from inside `stackctl.config.ts` or its
callbacks: it would load the config again. What a command prints goes to the calling process's
stderr, never its stdout, except the output of `exec()`, `run()` and `infra.compose()` with
`stdio: 'inherit'`, which is the command's own.

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
const stack = await startStack({ profile: 'test', services: ['api'] });
try {
  await fetch(`${stack.origins.api}/health`);
} finally {
  await stack.stop();
}

// every service tagged browser, and the services they need
await startStack({ profile: 'test', tags: ['browser'] });
```

| Option         | Default                | What it is                                                                 |
| -------------- | ---------------------- | -------------------------------------------------------------------------- |
| `services`     | required unless `tags` | The services to bring up. Their deps and the profile's infra come too.     |
| `tags`         | none                   | Brings up every service with one of these tags too, as `-t` does.          |
| `profile`      | as the CLI resolves it | The profile.                                                               |
| `workspaceDir` | nearest config         | The directory holding `stackctl.config.ts`, relative or absolute.          |
| `waitTimeout`  | `300`                  | Seconds to wait for everything to be healthy.                              |
| `killOthers`   | `false`                | Quit a session already running in the profile, as `--kill-others` does.    |
| `env`          | `stackEnvironment()`   | The environment the session starts with.                                   |

It resolves with:

| Field             | What it is                                                                              |
| ----------------- | --------------------------------------------------------------------------------------- |
| `origins`         | Each configured service's [public origin](../config/urls.md), by name.                  |
| `domain`          | The reverse proxy's canonical domain, or `null` without one.                            |
| `services`        | What the session runs: the services asked for and their deps.                           |
| `session`         | `'started'`: this call started it, and it ends with this process. `'attached'`: from [`attach()` or `wait()`](#attach-and-wait). |
| `control`         | A [control API client](./control-api.md#the-client) for the session.                    |
| `stop()`          | Quits the session, resolving once it has exited.                                        |
| `status()`        | [`status()`](#session-commands) of this session's profile.                              |
| `service`         | [`service.start`, `stop` and `restart`](#service) on this session.                       |
| `pid`, `port`     | The session's process and its control-API port.                                         |
| `profile`, `profileSource`, `logFile` | The session's profile, where it came from, and its log.             |

- **The session ends with the calling process**, however that ends.
- **Healthy** means running and passing its healthcheck. A service with no healthcheck must
  stay up for a second.
- **A service with `autostart: false` stays stopped** and isn't waited on. Start it with
  `stack.control.command.service.start(name)`.
- **It rejects** when a session of the profile is already running (unless `killOthers`), when
  the session exits or a service stops while starting, or when `waitTimeout` passes
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
await startStack({
  services: ['web'],
  env: { ...stackEnvironment(), FEATURE_X: '1' },
});
```

## `attach` and `wait`

```ts
function attach(options?): Promise<Stack>;
function wait(options?): Promise<Stack>;
```

The stack of a session another process started, a `start --detach` in CI say: the same object
[`startStack()`](#startstack) resolves with, with `session: 'attached'`.

```ts
const stack = await attach({ profile: 'test' });
await fetch(`${stack.origins.web}/health`);
await stack.service.restart({ services: ['api'] });
```

| Option         | Default                | What it is                                                        |
| -------------- | ---------------------- | ----------------------------------------------------------------- |
| `profile`      | as the CLI resolves it | The profile.                                                      |
| `workspaceDir` | nearest config         | The directory holding `stackctl.config.ts`, relative or absolute. |
| `waitTimeout`  | `300`                  | `attach` only: seconds to wait for the session to be ready.       |
| `timeout`      | `300`                  | `wait` only: seconds to wait for it to start and be ready.        |

- **`attach` needs the session running now.** It rejects at once without one, or when the one
  recorded doesn't answer, and otherwise waits until it is ready.
- **`wait` waits for the session to start too**, as [`stackctl wait`](./cli.md#stackctl-wait)
  does.
- **An attached session doesn't end with this process.** Its `stop()` quits it.

## Session commands

```ts
function stop(options?): Promise<{ stopped }>;
function status(options?): Promise<StatusReport>;
function events(options?): Promise<EventLine[]>;
function logs(options?): Promise<{ path, text }>;
function resetProfile(options): Promise<void>;
```

What [`stackctl stop`, `status`, `events`, `logs` and `reset`](./cli.md) do, with a session
running or not.

```ts
const { running } = await status({ profile: 'test' });
for await (const line of events({ follow: true })) {
  if (line.type === 'service-state') break;
}
await resetProfile({ profile: 'test' });
```

| Function       | Resolves with                                                                |
| -------------- | ---------------------------------------------------------------------------- |
| `stop`         | `{ stopped }`: `false` when none was running.                                |
| `status`       | What [`stackctl status --json`](./cli.md#stackctl-status) prints.            |
| `events`       | The [event log](./events.md)'s lines, parsed, or `[]` before any session ran. `lines: n` keeps the last `n`. |
| `logs`         | The log's `path` and `text`. Rejects before any session ran.                 |
| `resetProfile` | Once the session is stopped and the state deleted.                           |

- **`stop` rejects when the session may still be running**, and `resetProfile` needs
  `profile`, as `--profile` is needed for `stackctl reset`.
- **`events({ follow: true })` and `logs({ follow: true })` are async iterables** of the lines,
  ending when the next session starts, when `signal` aborts, or when the loop breaks.
- **They read the running session's files, else the latest one's**, as the CLI does.

## `service`

```ts
service.start(options): Promise<{ ok, results }>;
service.stop(options): Promise<{ ok, results }>;
service.restart(options): Promise<{ ok, results }>;
```

What [`stackctl service`](./cli.md#stackctl-service) does, in the profile's running session.

```ts
await service.restart({ tags: ['backend'], profile: 'test' });
```

| Option        | Default | What it is                                                           |
| ------------- | ------- | -------------------------------------------------------------------- |
| `services`    | none    | Services, by name or by a path, as `-s` takes them.                  |
| `tags`        | none    | Every service with one of these tags, beside `services`.             |
| `waitTimeout` | `300`   | `start` and `restart`: seconds to wait for the services to be ready. |

- **It takes `profile` and `workspaceDir`** too.
- **Each result** is `{ service, status, error? }`, with `status` `'running'`, `'stopped'` or
  `'failed'`.
- **It rejects with no session running**, and for a selection the CLI refuses.

## `infra`

```ts
infra.start(options?): Promise<{ ok, results }>;
infra.stop(options?): Promise<{ ok, results }>;
infra.restart(options?): Promise<{ ok, results }>;
infra.reset(options?): Promise<{ ok, results }>;
infra.destroy(options?): Promise<{ ok, results }>;
infra.compose(args, options?): Promise<{ exitCode, stdout?, stderr? }>;
```

What [`stackctl infra`](./cli.md#stackctl-infra) does, with no session needed.

```ts
await infra.reset({ profile: 'test' });
await infra.start({ tags: ['data'], waitTimeout: 60 });
const { stdout } = await infra.compose(['ps'], { stdio: 'pipe' });
```

| Option        | Default           | What it is                                                               |
| ------------- | ----------------- | ------------------------------------------------------------------------ |
| `services`    | every enabled one | Infra services, by name.                                                 |
| `tags`        | none              | Every enabled infra service with one of these tags, beside `services`.   |
| `waitTimeout` | the config's      | `start`, `restart` and `reset`: seconds to wait for them to be ready.    |
| `stdio`       | `'inherit'`       | `compose` only: `'pipe'` collects the output into `stdout` and `stderr`. |

- **It takes `profile` and `workspaceDir`** too.
- **Each result** is `{ service, status, error? }`, with `status` `'ready'`, `'stopped'`,
  `'destroyed'` or `'failed'`.
- **It rejects** for what the CLI refuses before anything runs: an unknown service or tag, a
  disabled service named, and what [`reset`](../config/infra.md#reset) and `destroy` can't
  remove. An empty `services` or `tags` rejects too: leave it out to act on every enabled one.

## `exec` and `run`

```ts
function exec(options): Promise<{ exitCode, signal, stdout?, stderr? }>;
function run(options): Promise<{ exitCode, signal, stdout?, stderr? }>;
// With a `service` array or `tags`:
function exec(options): Promise<{ ok, results }>;
function run(options): Promise<{ ok, results }>;
```

What [`stackctl exec` and `stackctl run`](../guide/commands.md) do, from a script: one
command in a service's directory, with its environment, or the same command in
[several services at once](#several-services-at-once).

```ts
await exec({ service: 'api', command: ['node', 'src/migrate.ts'] });

const { exitCode, stdout } = await run({
  service: 'api',
  script: 'seed',
  args: ['--rows=100'],
  profile: 'test',
  stdio: 'pipe',
});
```

| Option               | Default                | What it is                                                             |
| -------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `command`            | **required** (`exec`)  | The program and its arguments, run with no shell.                      |
| `script`             | **required** (`run`)   | The script or Makefile target.                                         |
| `args`               | none                   | `run` only: arguments forwarded to the script.                         |
| `service`            | the current directory  | A service, by its name or a path, relative or absolute, or an array.   |
| `tags`               | none                   | Every service with one of these tags, beside `service`.                |
| `ignoreSiblingError` | `false`                | With several services: every command runs to its end when one fails.   |
| `profile`            | as the CLI resolves it | The profile.                                                           |
| `workspaceDir`       | nearest config         | The directory holding `stackctl.config.ts`, relative or absolute.      |
| `stdio`              | `'inherit'`            | `'inherit'` gives the command this process's stdout and stderr, [as the CLI does](../guide/commands.md#output-and-exit-code). `'pipe'` collects them into `stdout` and `stderr`. |

- **A non-zero exit resolves**, with its `exitCode` or the `signal` that ended it. The caller
  judges the result.
- **It rejects only when the command can't start**: no config, an unknown service, a missing
  script.
- **The calling process is untouched**: its `process.env` and working directory don't change,
  and neither function calls `process.exit`.
- **Signals are forwarded** to the command.
- **Each call is in the [event log](./events.md)** and writes a
  [log file](../guide/logs.md#log-files), as `stackctl exec` and `run` do, except
  [inside a command stackctl runs](../guide/commands.md#output-and-exit-code).

### Several services at once

```ts
const { ok, results } = await run({
  tags: ['backend'],
  script: 'test',
  stdio: 'pipe',
});

await exec({
  service: ['api', './tools'],
  command: ['node', 'check.ts'],
  ignoreSiblingError: true,
});
```

What [`-s` and `-t`](../guide/commands.md#several-services-at-once) do on the command line.
It resolves with every service's result:

| Field      | What it is                                                                         |
| ---------- | ---------------------------------------------------------------------------------- |
| `ok`       | Every command that ran exited `0`.                                                 |
| `results`  | One per service: the services in config order, then the directories as given.      |

Each of `results`:

| Field              | What it is                                                                    |
| ------------------ | ----------------------------------------------------------------------------- |
| `service`          | The service's name, or for a directory in no service, its path from the root. |
| `status`           | `'ok'`, `'failed'`, `'stopped'` or `'skipped'`.                               |
| `exitCode`         | Its exit code, or `null` when a signal ended it or it never ran.              |
| `signal`           | The signal that ended it, or `null`.                                          |
| `error`            | Why it couldn't start.                                                        |
| `stdout`, `stderr` | With `stdio: 'pipe'`: its output.                                             |

- **A `service` array or `tags` runs it in several services**, each as one call would, all at
  once. One name in an array still does, and resolves with this result. `tags` takes every
  service with one of the [tags](../config/services.md#tags), and a `service` string with
  `tags` joins them. No service runs twice.
- **Branch on `Array.isArray` before passing a value typed `string | string[]`** as `service`:
  which one it is picks the result's type.
- **`stdio: 'inherit'` prints each line labelled with its service**, on this process's stdout
  or stderr. `'pipe'` prints nothing and collects each service's output into its result.
  Neither prints a summary.
- **The first failure stops the others.** `failed` is a command that ended non-zero, or by a
  signal, by itself, or couldn't start. `stopped` is one stackctl stopped: another one failed, or
  the calling process was sent a signal. With `ignoreSiblingError: true`, every command runs to
  its end.
- **A service a tag matched that lacks the script is `skipped`.**
- **It rejects only when nothing can start**: no config, an unknown service or tag, a named
  service without the script, a script none of them has, nothing named (an empty `service` or
  `tags` and nothing else), or `ignoreSiblingError` without a `service` array or `tags`.
- **A command that can't start is a `failed` result**, with its `error`, so the others'
  results are kept.
- **The rest is as for one command**: signals reach every command, and each one is in the
  event log and writes its own log file, except inside a command stackctl runs, where nothing
  is logged or recorded.

## `resolveEnv`

```ts
function resolveEnv(options?): { env, files, candidates };
```

Returns the environment stackctl would give a service, without starting or running anything.
For a script stackctl doesn't start, such as a launcher that needs a port before anything is
up. It is synchronous.

```ts
const { env } = resolveEnv({ profile: 'test', service: 'api' });
const databaseUrl = env.DATABASE_URL;
```

| Option         | Default                | What it is                                      |
| -------------- | ---------------------- | ----------------------------------------------- |
| `service`      | the current directory  | A service, by its name or by a path, relative or absolute. |
| `profile`      | as the CLI resolves it | The profile whose files to read.                |
| `workspaceDir` | nearest config         | The directory holding `stackctl.config.ts`, relative or absolute. |

| Field        | What it is                                                                               |
| ------------ | ---------------------------------------------------------------------------------------- |
| `env`        | What stackctl adds: the files' variables, `env.vars`, and for a service its `PORT` and `PUBLIC_ORIGIN`. |
| `files`      | The `.env` files that existed and were read.                                             |
| `candidates` | Every path looked for. Check it when a variable is missing.                              |

`env` doesn't include the rest of `process.env`. Merge them yourself when you need both:
`{ ...process.env, ...env }`.

## `showConfig`

```ts
function showConfig(options?): Promise<Config>;
```

The resolved config, as [`stackctl show-config`](./cli.md#stackctl-show-config) prints it:
callbacks run, defaults applied, functions left out. It takes `profile` and `workspaceDir`.

## `init`

```ts
function init(options?): Promise<void>;
```

Sets a project up as [`stackctl init -y`](./cli.md#stackctl-init) does. `workspaceDir` is where;
`agentsMd: true` adds the `AGENTS.md` section too.

## `logging`

Builders for a service's [`logs.formatter`](../config/logs.md#the-logging-helpers):

```ts
logging.formatter(config?);
logging.nodejs.pino.formatter(config?);
logging.nodejs.winston.formatter(config?);
```

## Types

The types used by the config are exported for
[splitting it across files](../config/config-file.md#splitting-the-config-across-files):
`ServiceInput`, `DockerComposeServiceInput`, `DockerComposeServicesInput`,
`DockerComposeDestroyContext`, `DockerComposeStartContext`, `DockerComposeReadyContext`,
`DockerComposeCallbackContext`, `ReverseProxyRoute`, `ReverseProxyInput` and
`DockerComposeInfraInput`. With
[typed service names](../config/config-file.md#typed-service-names), `ServiceName`,
`InfraServiceName` and `ServiceConfig` are your own. `ControlClient`, `SessionStatus` and
`SessionEvent` describe the [control API client](./control-api.md#the-client), and `EventLine`,
`EventEntry`, `EventEnvelope` and `EventBy` the [event log](./events.md)'s lines.
