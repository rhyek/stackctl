---
description: Lifecycle hooks - async functions stackctl runs before and after it starts, gets ready, stops or destroys the session, an application service, the Compose project or an infra service. When each runs, in what order, what it receives (exec, log, data, trigger), what a failure does, and the time limits at a shutdown.
---

# Lifecycle hooks

A lifecycle hook is an async function stackctl runs around one of its own steps: before a service
starts, once it is ready, before it stops. Generate code before a start, register a webhook once
a service answers and remove it before the service stops, migrate a database: each goes in the
hook of the step it belongs to.

Four things take hooks, each under its own `lifecycle`:

```ts
export default defineConfig({
  serviceRootDir: 'apps',
  // the session itself
  session: {
    lifecycle: {
      beforeStart: async ({ exec }) => {
        await exec('pnpm', ['codegen']);
      },
    },
  },
  services: {
    // an application service
    api: {
      port: 3001,
      healthcheck: '/health',
      lifecycle: {
        afterReady: async ({ buildAddress, exec }) => {
          const url = buildAddress({ path: '/webhooks' });
          await exec('node', ['scripts/webhook.ts', 'add', url]);
        },
        beforeStop: async ({ exec }) => {
          await exec('node', ['scripts/webhook.ts', 'remove']);
        },
      },
    },
  },
  infra: {
    'docker-compose': {
      // the Compose project as a whole
      lifecycle: {
        beforeStart: async ({ exec }) => {
          // setup of your own: certificates a container mounts
          await exec('node', ['scripts/dev-certs.ts']);
        },
      },
      services: {
        // an infra service
        db: {
          lifecycle: {
            afterReady: async ({ exec }) => {
              await exec('pnpm', ['migrate'], { cwd: 'libs/db' });
            },
          },
        },
      },
    },
  },
});
```

All four take `beforeStart`, `afterStart`, `afterReady`, `beforeStop` and `afterStop`. The
Compose project and an infra service also take `beforeDestroy` and `afterDestroy`.

- **Most hooks run on every start**, so make them idempotent: check fast, and do nothing when
  there is nothing to do.
- **A session reads `stackctl.config.ts` once, as it starts.** After editing a hook, quit the
  session and start it again.

## When each hook runs

One table for each of the four things that take hooks: its hooks, when each runs, and the type
of the object it receives. The [examples](#examples) then show them together.

### The session

Under `session.lifecycle`. Every kind of session runs them: the terminal UI, `--headless` and
`start --detach`.

| Hook          | Runs                                                                             | Receives                                        |
| ------------- | -------------------------------------------------------------------------------- | ----------------------------------------------- |
| `beforeStart` | Once, as the session starts: after the services are picked and a session it replaces has quit, before the infra. | [`SessionStartContext`](#what-a-hook-receives) |
| `afterStart`  | Once the infra is up, as the services are told to start: before any is ready.    | [`SessionStartContext`](#what-a-hook-receives)  |
| `afterReady`  | Once, the first time the infra is up and every service is ready.                 | [`SessionStartContext`](#what-a-hook-receives)  |
| `beforeStop`  | As the session quits, before its services' `beforeStop`.                         | [`SessionStopContext`](#what-a-hook-receives)   |
| `afterStop`   | Once every service has stopped, after their `afterStop`.                         | [`SessionStopContext`](#what-a-hook-receives)   |

The session is ready once its `afterReady` has finished: `stackctl wait`, `start --detach` and
[`startStack()`](../reference/sdk.md#startstack) wait for it.

### An application service

Under `services.<name>.lifecycle`. The dev session runs them, around the service's dev process.

| Hook          | Runs                                                                             | Receives                                        |
| ------------- | -------------------------------------------------------------------------------- | ----------------------------------------------- |
| `beforeStart` | Before every start of the process: at the session's start (once its [`deps`](./services.md#deps) are ready), on a start, on a restart, and on a restart because a `.env` file changed. | [`ServiceStartContext`](#what-a-hook-receives) |
| `afterStart`  | Right after the process is started, before it is ready.                          | [`ServiceStartContext`](#what-a-hook-receives)  |
| `afterReady`  | Once per start, when its [`healthcheck`](./services.md#healthcheck) first passes. With no healthcheck, right after `afterStart`. | [`ServiceStartContext`](#what-a-hook-receives) |
| `beforeStop`  | Before the process is signalled, on a stop someone asked for: a stop, a restart, the session quitting. | [`ServiceStopContext`](#what-a-hook-receives) |
| `afterStop`   | Once that process has exited.                                                    | [`ServiceStopContext`](#what-a-hook-receives)   |

The process gets what `beforeStart` writes to the service's `.env` files.

### The Compose project

Under `infra['docker-compose'].lifecycle`. Its hooks are the outer ones: each `before…` runs
before the infra services', each `after…` after theirs.

| Hook            | Runs                                                                           | Receives                                        |
| --------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| `beforeStart`   | Before a start's first Compose call.                                           | [`DockerComposeProjectStartContext`](#what-a-hook-receives) |
| `afterStart`    | After `docker compose up`, before the services are ready.                      | [`DockerComposeProjectStartContext`](#what-a-hook-receives) |
| `afterReady`    | Once every service of the start is ready.                                      | [`DockerComposeProjectStartContext`](#what-a-hook-receives) |
| `beforeStop`    | Before a stop.                                                                 | [`DockerComposeProjectStopContext`](#what-a-hook-receives) |
| `afterStop`     | Once the services have stopped.                                                | [`DockerComposeProjectStopContext`](#what-a-hook-receives) |
| `beforeDestroy` | Before a destroy.                                                              | [`DockerComposeProjectDestroyContext`](#what-a-hook-receives) |
| `afterDestroy`  | Once the containers and volumes are removed.                                   | [`DockerComposeProjectDestroyContext`](#what-a-hook-receives) |

Infra hooks run on three kinds of run:

| Run     | Is                                                                                       |
| ------- | ---------------------------------------------------------------------------------------- |
| Start   | A session's start, `infra start`, and the start half of `infra restart` and `infra reset`. |
| Stop    | `infra stop`, and the stop half of `infra restart`.                                      |
| Destroy | `infra destroy`, and the destroy half of `infra reset`. A reset runs no stop hooks.      |

Each from the CLI, the terminal UI's keys on an infra service, or the
[control API](../reference/control-api.md#post-commandinfra).

### An infra service

Under `infra['docker-compose'].services.<name>.lifecycle`, on the same runs as the project's.

| Hook            | Runs                                                                           | Receives                                        |
| --------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| `beforeStart`   | Before `docker compose up` starts it.                                          | [`DockerComposeStartContext`](#what-a-hook-receives) |
| `afterStart`    | Right after `docker compose up`, before it is ready.                           | [`DockerComposeStartContext`](#what-a-hook-receives) |
| `afterReady`    | Once it is ready: its container is healthy.                                    | [`DockerComposeReadyContext`](#what-a-hook-receives) |
| `beforeStop`    | Before it is stopped.                                                          | [`DockerComposeStopContext`](#what-a-hook-receives) |
| `afterStop`     | Once it has stopped.                                                           | [`DockerComposeStopContext`](#what-a-hook-receives) |
| `beforeDestroy` | Before its container and volumes are removed.                                  | [`DockerComposeDestroyContext`](#what-a-hook-receives) |
| `afterDestroy`  | Once they are removed.                                                         | [`DockerComposeDestroyContext`](#what-a-hook-receives) |

What is only about infra, `fresh`, `control` and `compose`, is on the
[Infra](./infra.md#callbacks) page.

## Examples

Every hook that runs, in order, for four common commands, each by where it is in the config. A
step in plain words is stackctl's own.

### A session's start

The terminal UI once you confirm the picker, `stackctl -s api -s web`, `stackctl --headless`,
`stackctl start --detach`, `startStack()`.

| #   | Runs                                                                                   |
| --- | -------------------------------------------------------------------------------------- |
| 1   | `session.lifecycle.beforeStart`                                                        |
| 2   | `infra['docker-compose'].lifecycle.beforeStart`                                        |
| 3   | `infra['docker-compose'].services.<name>.lifecycle.beforeStart`, of each infra service |
| 4   | stackctl runs `docker compose up`                                                      |
| 5   | `infra['docker-compose'].services.<name>.lifecycle.afterStart`                         |
| 6   | `infra['docker-compose'].lifecycle.afterStart`                                         |
| 7   | `infra['docker-compose'].services.<name>.lifecycle.afterReady`                         |
| 8   | `infra['docker-compose'].lifecycle.afterReady`                                         |
| 9   | `session.lifecycle.afterStart`                                                         |
| 10  | `services.<name>.lifecycle.beforeStart`, of each application service                   |
| 11  | stackctl starts the service's process                                                  |
| 12  | `services.<name>.lifecycle.afterStart`                                                 |
| 13  | `services.<name>.lifecycle.afterReady`                                                 |
| 14  | `session.lifecycle.afterReady`                                                         |

Steps 10 to 13 run for each application service, at its own pace.

### A session's quit

Ctrl+C, `stackctl stop`, the control API's quit.

| #   | Runs                                                                        |
| --- | --------------------------------------------------------------------------- |
| 1   | `session.lifecycle.beforeStop`                                              |
| 2   | `services.<name>.lifecycle.beforeStop`, of each running application service |
| 3   | stackctl stops every process                                                |
| 4   | `services.<name>.lifecycle.afterStop`                                       |
| 5   | `session.lifecycle.afterStop`                                               |

The infra is left running, so no infra hook runs.

### An application service's restart

`stackctl service restart -s api`, `r` on the service in the terminal UI, or a change to one of
its `.env` files.

| #   | Runs                                  |
| --- | ------------------------------------- |
| 1   | `services.api.lifecycle.beforeStop`   |
| 2   | stackctl stops the service's process  |
| 3   | `services.api.lifecycle.afterStop`    |
| 4   | `services.api.lifecycle.beforeStart`  |
| 5   | stackctl starts the service's process |
| 6   | `services.api.lifecycle.afterStart`   |
| 7   | `services.api.lifecycle.afterReady`   |

Only that service's hooks: none of the session's, and none of the infra's.

### An infra service's reset

`stackctl infra reset -s db`, or `R` on the service in the terminal UI: a destroy, then a start.

| #   | Runs                                                          |
| --- | ------------------------------------------------------------- |
| 1   | `infra['docker-compose'].lifecycle.beforeDestroy`             |
| 2   | `infra['docker-compose'].services.db.lifecycle.beforeDestroy` |
| 3   | stackctl removes the service's container and volumes          |
| 4   | `infra['docker-compose'].services.db.lifecycle.afterDestroy`  |
| 5   | `infra['docker-compose'].lifecycle.afterDestroy`              |
| 6   | `infra['docker-compose'].lifecycle.beforeStart`               |
| 7   | `infra['docker-compose'].services.db.lifecycle.beforeStart`   |
| 8   | stackctl runs `docker compose up`                             |
| 9   | `infra['docker-compose'].services.db.lifecycle.afterStart`    |
| 10  | `infra['docker-compose'].lifecycle.afterStart`                |
| 11  | `infra['docker-compose'].services.db.lifecycle.afterReady`    |
| 12  | `infra['docker-compose'].lifecycle.afterReady`                |

## What a hook receives

Every hook gets one object, with these fields:

| Field          | What it is                                                                              |
| -------------- | --------------------------------------------------------------------------------------- |
| `exec`         | `exec(command, args?, opts?)`: runs a command. See [`exec`](#exec).                     |
| `log`          | `log(message)`: writes a line to stackctl's log.                                        |
| `data`         | One object every hook of the operation shares. See [Sharing `data`](#sharing-data).    |
| `envs`         | The environment `exec` gives its commands.                                              |
| `tokens`       | The config's top-level [`tokens`](./config-file.md#tokens).                             |
| `profile`      | The active profile.                                                                     |
| `config`       | The resolved config, read-only, as [`show-config`](../reference/cli.md#stackctl-show-config) prints it. |
| `workspaceDir` | The workspace root, absolute.                                                           |

Each level adds fields of its own:

| A hook of              | Also gets                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------- |
| The session            | `mode`: `ui` (the terminal UI), `headless` or `detached` (`start --detach`).          |
| An application service | [`trigger`](#trigger); `service`, `{ name, kind, port, route, publicOrigin }`; [`buildAddress`](./urls.md#buildaddress). Its `tokens` have the service's own merged over the top-level ones. |
| The Compose project    | [`trigger`](#trigger); `compose`.                                                     |
| An infra service       | [`trigger`](#trigger); `service`; `buildAddress`; `compose`; `control`; `fresh` in `afterReady`. See [Infra](./infra.md#what-a-callback-receives). |

A hook written as a function of its own takes the type its table gives under
[When each hook runs](#when-each-hook-runs), imported from `stackctl`.

### `exec`

`exec(command, args?, opts?)` runs a command and resolves with `{ exitCode, stdout, stderr }`.
Where the command runs, and with which environment, depends on whose hook calls it:

| A hook of              | Runs its commands in    | With these `envs`                                                     |
| ---------------------- | ----------------------- | --------------------------------------------------------------------- |
| The session            | the workspace root      | The workspace's `.env` files and the shell's environment.             |
| An application service | the service's directory | What its dev process gets: its `.env` files, `PORT`, `PUBLIC_ORIGIN`. |
| The Compose project    | the workspace root      | The workspace environment and `COMPOSE_PROJECT_NAME`.                 |
| An infra service       | the workspace root      | The same as the Compose project's.                                    |

`opts` changes that for one command:

| Option   | What it does                                                                             |
| -------- | ---------------------------------------------------------------------------------------- |
| `cwd`    | Runs it in another directory. A relative path starts from the directory the hook's commands run in: `{ cwd: 'libs/db' }` in a session's hook is `<workspace root>/libs/db`. |
| `env`    | Variables merged over `envs`.                                                            |
| `reject` | `false` keeps a non-zero exit from failing the hook.                                     |

- **A non-zero exit throws**, which fails the hook.
- **Its output goes to stackctl's log as it comes.** A service hook's lines share the service's
  label with its dev process's output, so name the hook in what it logs:
  `log('afterReady: webhook registered')`.
- **Its input is closed**, so a command that prompts gets no answer.
- **Run commands with `exec`, not with a child process of your own.** A command `exec` started
  ends with stackctl, however stackctl ends, and with everything it started. Its output stays
  out of the terminal UI.

## `trigger`

What caused the start, stop or destroy a hook is part of. The session's hooks have no `trigger`:
they get `mode`.

| `trigger` | What caused it                                                                           |
| --------- | ---------------------------------------------------------------------------------------- |
| `session` | The session's start.                                                                     |
| `start`   | A start: the terminal UI's `s`, `stackctl service start` or `infra start`, the control API, the SDK. A service added to a running session too. |
| `stop`    | A stop, from any of the same places.                                                     |
| `restart` | A restart: `r`, `stackctl service restart` or `infra restart`, the control API, the SDK. |
| `env`     | A `.env` file of the service changed, and it restarts for it.                            |
| `quit`    | The session is shutting down.                                                            |
| `reset`   | `infra reset`, `R` on an infra service, or the control API.                              |
| `destroy` | `infra destroy`.                                                                         |

```ts
web: {
  lifecycle: {
    beforeStart: async ({ trigger, exec }) => {
      // a full build once per session, an incremental one after
      const args = trigger === 'session' ? ['--clean'] : [];
      await exec('pnpm', ['build:assets', ...args]);
    },
  },
},
```

## Sharing `data`

`data` is one object for one operation, shared by every hook the operation runs, at every level.
It starts empty, and nothing is kept once the operation ends.

| Operation                            | The hooks that share its `data`                                      |
| ------------------------------------ | -------------------------------------------------------------------- |
| A session's start                    | The session's start hooks, its infra's hooks, and the start hooks of every service it starts. |
| One service's start, stop or restart | That service's hooks. A restart's stop and start share one.          |
| A session's shutdown                 | The session's stop hooks and every running service's.                |
| One `stackctl infra` command         | Every hook it runs.                                                  |

```ts
api: {
  lifecycle: {
    beforeStop: async ({ exec, data }) => {
      const { stdout } = await exec('node', ['scripts/jobs.ts', 'pause']);
      data.paused = stdout.trim();
    },
    afterReady: async ({ exec, data }) => {
      // after a restart, resume what its stop paused
      if (typeof data.paused === 'string') {
        await exec('node', ['scripts/jobs.ts', 'resume', data.paused]);
      }
    },
  },
},
```

Put what one hook owns under a name of its own, so another's can't clash with it:
`data.db = { migrated: true }`.

<llm-only>

## When a hook fails

A hook fails when it throws, or when a command it runs with `exec` exits non-zero. Its message is
in the log, in red. What the failure does depends on the hook:

| A failure in               | Does                                                                              |
| -------------------------- | --------------------------------------------------------------------------------- |
| `beforeStart`              | Nothing is started. An application service stays `stopped`, with [the reason](#a-failed-service). The session's fails its start. An infra hook's fails the run. |
| `afterStart`, `afterReady` | The process or container keeps running. An application service is [`failed`](#a-failed-service), and never ready. An infra hook's fails the run. The session's fails its start. |
| `beforeStop`, `afterStop`  | The stop goes ahead, and the failure is logged. An `infra` command exits `1`.     |
| `beforeDestroy`            | Nothing is removed, and the run fails.                                            |
| `afterDestroy`             | The removal is done, and the command exits `1`. A reset stops there, starting nothing. |

A session whose start fails ends it: `--headless` and `start --detach` stop everything and exit
`1`, and the terminal UI shows the error and waits for you to quit. `stackctl wait`,
`start --detach` and `startStack()` fail with the reason, and `stackctl status` shows it, once
the session is gone too.

### A failed service

An application service whose `afterStart` or `afterReady` failed is `failed`. One whose
`beforeStart` failed was never started, and reads `stopped`. `stackctl status` says why:

```
services  api     failed, not ready: afterReady failed: boom
          web     waiting, not ready: waiting for api, which failed: afterReady failed: boom. Run …
          worker  stopped: beforeStart failed: no codegen
```

- **A `failed` service's process keeps running**, and the dev reverse proxy still forwards to
  it.
- **What depends on it keeps waiting**, and a wait on either fails at once with the reason:
  `stackctl service start`, `stackctl wait`, `start --detach`, `startStack()`.
- **The reason is also** in the log, in `errors` on
  [`GET /query/status`](../reference/control-api.md#get-querystatus), and on the dev reverse
  proxy's page for the service.
- **Restart it once it is fixed**: `stackctl service restart -s api`, or focus it and press `r`.
  A start does nothing to a `failed` service, which is already running.
- **A fix in `stackctl.config.ts`, the hook itself included, needs a new session.**

## Ready and reachable

- **Ready**: its healthcheck passes (or, with none, its process has started) **and** its
  `afterStart` and `afterReady` have finished. It is what its dependents, `stackctl service
  start`, `stackctl wait` and `startStack()` wait for.
- **Reachable**: the [dev reverse proxy](./reverse-proxy.md) forwards to a service as soon as its
  healthcheck passes, whether its hooks have finished or not, until its process is signalled.

So a hook can call its own service through `buildAddress()`, in `afterReady` and in `beforeStop`
alike, and so can a service it registers the address with.

## Time limits

**No hook has a time limit, except the stop hooks [at a shutdown](#at-a-shutdown).** A slow hook
holds the step it comes before: a `beforeStart` the start, an `afterReady` the service's ready, a
`beforeStop` the stop.

- **`stackctl status` names the hook a service still runs**:
  `api  running, not ready: its afterReady is still running`. So does `serviceHooks` on
  [`GET /query/status`](../reference/control-api.md#get-querystatus).
- **`stackctl service stop` waits for a slow `beforeStop`.** Stop the service again to abandon
  the hook.

### Abandoned hooks

A hook still running when what it belongs to moves on is abandoned. stackctl stops waiting for
it, ends the commands it started with `exec`, ignores what it returns or throws from then on, and
says so in the log: `afterReady abandoned: the service was stopped`.

| What happens                                  | Abandons                        |
| --------------------------------------------- | ------------------------------- |
| A stop, a restart or a new start of a service | Its start hook still running.   |
| A quit                                        | Every start hook still running. |
| A second stop of a service                    | Its stop hook still running.    |
| A shutdown's 5 seconds for stop hooks are up  | The stop hooks still running.   |

An abandoned start hook neither fails its service nor makes it ready.

### At a shutdown

A quit (Ctrl+C, `stackctl stop`, the control API's quit, a signal) runs, in order:

1. The session's `beforeStop`, then every running service's `beforeStop`, side by side:
   **up to 5 seconds** in all.
2. The stop: `SIGTERM` to each service, up to 10 seconds for it to exit, then `SIGKILL`.
3. The services' `afterStop`, side by side, then the session's `afterStop`: **up to 5 seconds**
   in all.

- **A hook still running when its 5 seconds are up is [abandoned](#abandoned-hooks)**, and one
  whose turn comes after that is skipped.
- **A second quit kills everything at once**, and skips the hooks left.

</llm-only>

## What runs no hook

- **`stackctl exec` and `stackctl run`.**
- **A service that exits by itself.** A crash is not a stop: no `beforeStop` or `afterStop`.
- **The infra at a session's quit.** It is left running, so no infra stop hook runs.
